"""OpenAI-compatible API server.

Endpoints:
  POST /v1/chat/completions  — chat (streaming + non-streaming)
  GET  /v1/models            — model catalog
  GET  /v1/projects          — ChatGPT projects
  GET  /health               — health + Chrome status
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid

from aiohttp import web

from .breakers import BreakerKind, BreakerRegistry, CircuitOpenError
from . import conv_binding, send_receipts
from .cdp_driver import (
    AuthExpiredError,
    CDPDriver,
    GenerationInProgressError,
    GenerationStuckError,
    RateLimitError,
    is_rate_limited_text,
)
from .config import Config
from .cross_process_lock import LockAcquisitionError
from .lock_resolver import MutationLock, OwnedTabRequiredError, resolve_mutation_lock
from .request_pace import ReadThrottledError
from .resilience import retry_on_rate_limit

logger = logging.getLogger(__name__)

# Model mapping: user-facing names → ChatGPT web slugs
MODEL_MAP = {
    "gpt-5.5": "gpt-5-5",
    "gpt-5.5-thinking": "gpt-5-5-thinking",
    "gpt-5.3": "gpt-5-3",
    "gpt-5.2": "gpt-5-2",
    "gpt-5.1": "gpt-5-1",
    "gpt-5": "gpt-5",
    "gpt-5-mini": "gpt-5-mini",
    "gpt-5.3-mini": "gpt-5-3-mini",
    "auto": "auto",
    # Legacy aliases
    "gpt-4o": "auto",
    "gpt-4": "gpt-5",
    "gpt-3.5-turbo": "gpt-5-mini",
}


class APIServer:
    """OpenAI-compatible API backed by CDP automation."""

    def __init__(
        self, config: Config, driver: CDPDriver, breakers: BreakerRegistry | None = None
    ) -> None:
        self._config = config
        self._driver = driver
        self._cdp_port = config.chrome.cdp_port
        self._parallel_tabs = config.chatgpt.parallel_tabs
        self._request_count = 0
        # Health telemetry (event-derived, not polled). These are the only
        # fields that make sense to cache: they mark WHEN something happened,
        # not whether something is alive right now (that's computed live in
        # _handle_health). Without last_successful_send_at, a zombie process
        # that never connected (cdp_connected=false, requests_served=0) looks
        # identical to a freshly-started healthy one — both report "waiting".
        self._started_at = time.time()
        self._last_error: str | None = None
        self._last_successful_send_at: float | None = None
        # Non-rate-limit breaker registry (Phase 4). Injected by Service so the
        # REST process shares one registry across Chrome + driver + server.
        # Default-constructed for back-compat with tests that don't pass one.
        self._breakers = breakers or BreakerRegistry()
        # Track last conversation for multi-turn continuity
        self._last_conv_id: str | None = None
        self._last_project_id: str | None = None

        self.app = web.Application(client_max_size=10 * 1024 * 1024)
        self.app.router.add_post("/v1/chat/completions", self._handle_chat)
        self.app.router.add_post("/chat/completions", self._handle_chat)
        self.app.router.add_get("/v1/models", self._handle_models)
        self.app.router.add_get("/v1/projects", self._handle_projects)
        self.app.router.add_get("/v1/send-status", self._handle_send_status)
        self.app.router.add_get("/health", self._handle_health)
        self.app.router.add_get("/", self._handle_health)

    # ── Auth ──────────────────────────────────────────────────

    def _check_auth(self, request: web.Request) -> web.Response | None:
        """Check API key if configured. Returns error response or None."""
        keys = self._config.server.api_keys
        if not keys:
            return None
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            key = auth[7:]
        else:
            key = request.query.get("key", "")
        if key not in keys:
            return web.json_response(
                {"error": {"message": "Invalid API key", "type": "auth_error"}},
                status=401,
            )
        return None

    # ── Handlers ──────────────────────────────────────────────

    async def _handle_health(self, request: web.Request) -> web.Response:
        """Honest health endpoint — observes current reality, not a stale mirror.

        The old version returned ``"waiting"`` when CDP was disconnected, which
        is indistinguishable from "freshly started, connecting now" — a zombie
        process (HTTP listener up, CDP never connected) reported the same
        status as a healthy one. Readiness is independent of request history:
        - ``healthy``: Chrome alive AND driver connected
        - ``degraded``: Chrome alive but driver disconnected (zombie/recovering)
        - ``broken``: Chrome itself unreachable

        Live fields (chrome_running, driver_connected) are computed fresh on
        each call — /health is infrequent (supervisor poll), and cached state
        would lag reality. Event-derived fields (started_at, last_error,
        last_successful_send_at, requests_served) are tracked on the instance.
        """
        import urllib.request

        driver_connected = bool(self._driver.is_connected)

        # Chrome liveness: cheap HTTP GET to /json/version. If Chrome is dead,
        # this fails fast (connection refused). Run synchronously — /health is
        # infrequent and the call is sub-millisecond on loopback.
        chrome_running = False
        try:
            loop = asyncio.get_event_loop()

            def _probe():
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{self._cdp_port}/json/version", timeout=2
                    ) as r:
                        return r.status == 200
                except Exception:
                    return False

            chrome_running = await loop.run_in_executor(None, _probe)
        except Exception:
            chrome_running = False

        # Status logic — zombie case (Chrome up, driver dead) is "degraded",
        # never "ok"/"waiting". The old "waiting" non-answer is gone.
        if not chrome_running:
            status = "broken"
        elif not driver_connected:
            status = "degraded"
        else:
            status = "healthy"

        # An open breaker can only DOWNGRADE healthy -> degraded. It
        # must never override "broken" (Chrome down is a harder failure than a
        # tripped circuit) and never force "broken" — auth_required is serious,
        # but "broken" invites a destructive supervisor restart, while
        # "degraded" correctly signals "up but refusing some/all traffic". A
        # disconnect-degraded stays degraded (not worse).
        if status == "healthy" and self._breakers.first_open() is not None:
            status = "degraded"

        # Current-state summary, distinct from the historical/latching last_error.
        open_kinds = [k.value for k in BreakerKind if self._breakers.is_open(k)]

        return web.json_response(
            {
                "status": status,
                "ready": status == "healthy",
                "usage_state": "unused" if self._request_count == 0 else "used",
                "build": send_receipts.BUILD_ID,
                "readiness_scope": "transport",
                "chrome_running": chrome_running,
                "cdp_connected": driver_connected,
                "driver_connected": driver_connected,
                "requests_served": self._request_count,
                "started_at": self._started_at,
                "last_successful_send_at": self._last_successful_send_at,
                "last_error": self._last_error,
                "open_breakers": open_kinds,
                "breakers": self._breakers.snapshot(),
            }
        )

    async def _handle_models(self, request: web.Request) -> web.Response:
        if err := self._check_auth(request):
            return err
        try:
            raw = await self._driver.get_models()
        except Exception:
            raw = []

        models = []
        for m in raw:
            slug = m.get("slug", "")
            models.append(
                {
                    "id": slug,
                    "object": "model",
                    "created": 1700000000,
                    "owned_by": "chatgpt-web",
                }
            )

        if not models:
            for slug in ["auto", "gpt-5-5", "gpt-5-mini"]:
                models.append(
                    {
                        "id": slug,
                        "object": "model",
                        "created": 1700000000,
                        "owned_by": "chatgpt-web",
                    }
                )

        return web.json_response({"object": "list", "data": models})

    async def _handle_projects(self, request: web.Request) -> web.Response:
        if err := self._check_auth(request):
            return err
        try:
            projects = await self._driver.get_projects()
        except Exception as e:
            logger.error("Failed to get projects: %s", e)
            projects = []
        return web.json_response({"object": "list", "data": projects})

    async def _handle_chat(self, request: web.Request) -> web.Response:
        if err := self._check_auth(request):
            return err
        try:
            body = await request.json()
        except (ValueError, TypeError):
            return await self._handle_chat_impl(request)
        if not isinstance(body, dict):
            return web.json_response({"error": {"message": "Expected a JSON object"}}, status=400)
        operation_id = request.headers.get("Idempotency-Key") or body.get("operation_id")
        logical = {k: v for k, v in body.items() if k not in {"confirm", "operation_id", "stream"}}
        logical["tool"] = "rest_chat_completion"
        logical.setdefault("model", self._config.chatgpt.default_model)
        logical["project_id"] = (body.get("project_id") or body.get("gizmo_id")
                                 or (body.get("metadata") or {}).get("project_id")
                                 or self._config.chatgpt.default_project_id)

        async def action():
            response = await self._handle_chat_impl(request)
            receipt = send_receipts.current()
            if isinstance(response, web.Response) and receipt is not None and not response.prepared:
                record = send_receipts.get(receipt.operation_id)
                if record["state"] == "preparing":
                    record = receipt.mark(state="not_sent")
                if response.content_type == "application/json":
                    data = json.loads(response.body)
                    data["operation_id"] = receipt.operation_id
                    data["send_receipt"] = send_receipts.public_record(record)
                    response.body = json.dumps(data, ensure_ascii=False).encode()
                response.headers["X-Operation-ID"] = receipt.operation_id
            return response

        try:
            return await send_receipts.run(logical, operation_id, action)
        except send_receipts.SendAlreadyRecorded as exc:
            return web.json_response({"error": str(exc), "send_receipt": exc.receipt}, status=409)
        except (send_receipts.SendConflictError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=409)

    async def _handle_send_status(self, request):
        if err := self._check_auth(request):
            return err
        from .mcp_server import do_get_send_status

        return web.json_response(await do_get_send_status(self._driver, {
            "operation_id": request.query.get("operation_id"),
            "refresh": request.query.get("refresh", "false").lower() == "true",
        }))

    async def _handle_chat_impl(self, request: web.Request) -> web.Response:
        if err := self._check_auth(request):
            return err

        self._request_count += 1

        try:
            body = await request.json()
        except json.JSONDecodeError:
            return web.json_response(
                {"error": {"message": "Invalid JSON", "type": "invalid_request_error"}},
                status=400,
            )

        messages = body.get("messages", [])
        if not messages:
            return web.json_response(
                {"error": {"message": "No messages provided", "type": "invalid_request_error"}},
                status=400,
            )

        model = body.get("model", self._config.chatgpt.default_model)
        stream = body.get("stream", False)
        project_id = (
            body.get("project_id")
            or body.get("gizmo_id")
            or (body.get("metadata", {}) or {}).get("project_id")
            or self._config.chatgpt.default_project_id
        )
        conversation_id = body.get("conversation_id")

        # Name-or-id project resolution — "REDACTED" → gizmo id; unknown or
        # ambiguous names raise instead of silently landing in a wrong project.
        if project_id:
            try:
                project_id = await self._driver.resolve_project_id(project_id)
            except Exception as e:
                return web.json_response(
                    {"error": {"message": str(e), "type": "invalid_request_error"}},
                    status=400,
                )

        # Build conversation text from all messages
        # Includes prior assistant context for stateless clients (OpenAI SDK)
        system_parts = []
        conversation_lines = []
        user_msg_count = 0
        MAX_HISTORY_TURNS = 10  # Cap to avoid textarea overflow

        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")
            if isinstance(content, list):
                content = "\n".join(
                    p.get("text", "") if isinstance(p, dict) else str(p) for p in content
                )
            else:
                content = str(content)

            if role == "system":
                system_parts.append(content)
            elif role == "user":
                conversation_lines.append(f"[User]\n{content}")
                user_msg_count += 1
            elif role == "assistant":
                conversation_lines.append(f"[Assistant]\n{content}")

        # Trim to last N turns if too many messages
        if len(conversation_lines) > MAX_HISTORY_TURNS * 2:
            conversation_lines = conversation_lines[-(MAX_HISTORY_TURNS * 2) :]

        # Verify at least one user message exists
        if user_msg_count == 0:
            return web.json_response(
                {"error": {"message": "No user message", "type": "invalid_request_error"}},
                status=400,
            )

        # Compose final text
        prefix = ""
        if system_parts:
            prefix = "[System Instructions]\n" + "\n".join(system_parts) + "\n\n"
        full_text = prefix + "\n".join(conversation_lines)

        model_slug = MODEL_MAP.get(model, model)
        timeout = self._config.server.request_timeout

        logger.info(
            "Request #%d: model=%s->%s conv=%s project=%s stream=%s msg=%.60s",
            self._request_count,
            model,
            model_slug,
            conversation_id,
            project_id,
            stream,
            full_text,
        )

        # Serialize — cross-process lock so MCP + REST don't corrupt each other
        try:
            # Circuit-open fail-fast (Phase 4 PR2): refuse before touching Chrome
            # if a breaker is open. Placed inside the try so it flows through
            # the except below → _error_response + _last_error, consistent with
            # every other failure path. Checked before acquiring the lock so a
            # process that already knows it will refuse doesn't block on the
            # browser lock. If AUTH_EXPIRED is open, probes auth recovery first
            # (the user may have logged back in).
            await self._check_circuit_or_recover()

            # PR4/5: per-target lock in parallel mode (port-wide otherwise).
            # Resolver raises OwnedTabRequiredError (→ 503) if parallel mode
            # has no owned target rather than silently degrading to the port
            # lock (split-brain guard). When parallel mode is OFF, skip the
            # resolver entirely and use the cached port — preserves the exact
            # legacy path (the resolver would read driver.port, which is the
            # same value but needlessly couples the legacy path to the driver).
            # Conv-affinity: if a tab already shows this conversation, switch
            # the daemon driver onto it BEFORE the lock key is resolved — the
            # key names the target, so the target must be final here. A miss
            # just means the route below navigates our own tab onto it.
            if conversation_id and self._driver._current_conv_id != conversation_id:
                try:
                    await self._driver.adopt_conversation_tab(conversation_id)
                except Exception:
                    logger.debug(
                        "conv-tab adopt failed (will navigate)", exc_info=True
                    )
            if self._parallel_tabs:
                _port, _key = resolve_mutation_lock(self._driver, True)
            else:
                _port, _key = self._cdp_port, None
            async with MutationLock(_port, _key):
                # Drift guard (parallel mode only): if the owned target changed
                # while we waited for the lock, the key we hold no longer names
                # the active tab. Fail retryably instead of mutating under a
                # stale key.
                if self._parallel_tabs:
                    _, _current_key = resolve_mutation_lock(self._driver, True)
                    if _current_key != _key:
                        raise OwnedTabRequiredError(
                            "owned target changed while waiting for mutation lock"
                        )
                # Second circuit-open check, now that we hold the lock. A
                # concurrent request may have tripped a breaker while we were
                # waiting. Without this, we'd drive Chrome despite the process
                # already knowing the circuit is open.
                await self._check_circuit_or_recover()

                # Select model if specified (non-fatal on failure)
                if model_slug and model_slug != "auto":
                    selected = await self._driver.select_model(model_slug)
                    if not selected:
                        logger.warning(
                            "Could not select model '%s', proceeding with active model",
                            model_slug,
                        )

                # Decide: continue existing conversation or start fresh?
                # Shared rule (driver.route_chat_target, same function the
                # MCP path calls): an explicit conversation_id ALWAYS
                # continues that conversation — project_id only scopes NEW
                # conversations and must never veto an explicit target.
                route = await self._driver.route_chat_target(
                    conversation_id=conversation_id,
                    project_id=project_id,
                    # REST auto-continue heuristic: same conversation AND same
                    # project context as the previous request, no system
                    # prompt override. Reconciles against the live tab URL —
                    # another process may have navigated a shared tab,
                    # leaving _current_conv_id stale (fail-closed).
                    auto_continue=bool(
                        self._last_conv_id
                        and self._driver._current_conv_id == self._last_conv_id
                        and project_id == self._last_project_id
                        and not system_parts
                    ),
                )
                if route == "auto-continue":
                    logger.info("Continuing conversation: %s", self._last_conv_id)
                elif route == "new":
                    self._last_project_id = project_id

                # Conversation-binding gate (same contract as the MCP
                # chat_completion tool): the first send that binds this
                # client to an existing conversation needs explicit user
                # confirmation — resend the same body with "confirm": true.
                # Session identity comes from X-Session-Id; REST callers
                # without one share the "rest:default" identity.
                rest_session = request.headers.get("X-Session-Id")
                rest_session = f"rest:{rest_session}" if rest_session else "rest:default"
                target_conv = conversation_id or (
                    self._driver._current_conv_id
                    if route == "auto-continue"
                    else None
                )
                binding_gate = await conv_binding.gate_check(
                    self._driver,
                    target_conv,
                    rest_session,
                    confirmed=bool(body.get("confirm")),
                    project_label=project_id,
                )
                if binding_gate is not None:
                    return web.json_response(
                        {
                            "error": {
                                "message": (
                                    "First send to this conversation requires "
                                    "user confirmation — show the binding "
                                    "details to the user, then resend with "
                                    "\"confirm\": true."
                                ),
                                "type": "invalid_request_error",
                                "param": "conversation_id",
                                "code": "confirmation_required",
                                "binding": binding_gate,
                            }
                        },
                        status=409,
                    )

                if stream:
                    return await self._stream_response(
                        request, model_slug, full_text, timeout, session_key=rest_session
                    )
                else:
                    return await self._full_response(
                        request, model_slug, full_text, timeout, session_key=rest_session
                    )

        except Exception as e:
            logger.error("Chat error: %s", e, exc_info=True)
            self._last_error = f"{type(e).__name__}: {e}"
            return self._error_response(e)

    async def _check_circuit_or_recover(self) -> None:
        """Fail-fast if a breaker is open, with one exception: if AUTH_EXPIRED
        is the open breaker, probe auth recovery first (the user may have logged
        back in via the browser since the trip). If recovery succeeds the breaker
        is reset and the request proceeds; if it fails, or if a non-auth breaker
        is open, raise CircuitOpenError.

        Called at each fail-fast checkpoint (pre-lock, post-lock, streaming
        pre-prepare). Does NOT drive a chat send — recovery is a lightweight
        ``/api/auth/session`` token fetch via ``driver.recover_auth()``.
        """
        open_kind = self._breakers.first_open()
        if open_kind is None:
            return
        if open_kind is BreakerKind.AUTH_EXPIRED:
            if await self._driver.recover_auth():
                # Auth restored — re-check in case another breaker is also open.
                open_kind = self._breakers.first_open()
                if open_kind is None:
                    return
        raise CircuitOpenError(open_kind)

    # ── Error mapping ─────────────────────────────────────────

    def _error_response(self, exc: Exception) -> web.Response:
        """Map a driver exception to an OpenAI-shaped error response.

        - RateLimitError → HTTP 429 with the canonical OpenAI
          ``rate_limit_exceeded`` type/code and a ``Retry-After`` header, so any
          OpenAI-aware agent framework (SDK, LangChain, LlamaIndex) automatically
          backs off and retries with zero client integration.
        - AuthExpiredError → HTTP 401 ``invalid_api_key`` — the ChatGPT session
          expired; previously this surfaced as silent empty data or a generic
          timeout.
        - GenerationStuckError → HTTP 504 ``generation_stuck`` — the generation
          stalled (no DOM progress within the stall window); the phase is in the
          message for diagnosis.
        - Everything else stays a 500 ``server_error`` (a real failure, not
          retriable).
        """
        from .navigation import NavigationError

        if isinstance(exc, NavigationError):
            return web.json_response({"error": {
                "message": str(exc), "type": "navigation_failed", "code": exc.reason,
                "stage": exc.stage, "evidence": exc.evidence,
            }}, status=503)
        if isinstance(exc, (RateLimitError, ReadThrottledError)):
            retry_after = str(int(exc.retry_after))
            return web.json_response(
                {
                    "error": {
                        "message": str(exc),
                        "type": "rate_limit_exceeded",
                        "param": None,
                        "code": "rate_limit_exceeded",
                    }
                },
                status=429,
                headers={"Retry-After": retry_after},
            )
        if isinstance(exc, AuthExpiredError):
            return web.json_response(
                {
                    "error": {
                        "message": str(exc),
                        "type": "invalid_api_key",
                        "param": None,
                        "code": "invalid_api_key",
                    }
                },
                status=401,
            )
        if isinstance(exc, GenerationInProgressError):
            # 409 Conflict: the conversation is mid-generation; a send would
            # interrupt the streaming reply. Retry-After carries the gate's
            # remaining window so clients can schedule a retry.
            return web.json_response(
                {
                    "error": {
                        "message": str(exc),
                        "type": "invalid_request_error",
                        "param": "conversation_id",
                        "code": "generation_in_progress",
                    }
                },
                status=409,
                headers={"Retry-After": str(int(exc.retry_after))},
            )
        if isinstance(exc, GenerationStuckError):
            return web.json_response(
                {
                    "error": {
                        "message": str(exc),
                        "type": "server_error",
                        "param": None,
                        "code": "generation_stuck",
                    }
                },
                status=504,
            )
        if isinstance(exc, LockAcquisitionError):
            return web.json_response(
                {
                    "error": {
                        "message": str(exc),
                        "type": "server_error",
                        "param": None,
                        "code": "lock_timeout",
                    }
                },
                status=503,
            )
        if isinstance(exc, CircuitOpenError):
            return web.json_response(
                {
                    "error": {
                        "message": (
                            f"Circuit open for {exc.kind.value} — cooling down. Retry later."
                        ),
                        "type": "server_error",
                        "param": None,
                        "code": "circuit_open",
                    }
                },
                status=503,
            )
        if isinstance(exc, OwnedTabRequiredError):
            return web.json_response(
                {
                    "error": {
                        "message": f"{exc}. Retry later.",
                        "type": "server_error",
                        "param": None,
                        "code": "owned_tab_required",
                    }
                },
                status=503,
            )
        return web.json_response(
            {"error": {"message": str(exc), "type": "server_error"}},
            status=500,
        )

    # ── Response formatters ───────────────────────────────────

    async def _full_response(
        self, request: web.Request, model: str, text: str, timeout: float,
        session_key: str | None = None,
    ) -> web.Response:
        """Non-streaming: collect all chunks, return one JSON.

        The send is wrapped in ``retry_on_rate_limit`` so a transient
        ChatGPT "Too many requests" pop-up is dismissed and retried
        transparently — the client only sees it (as a 429) if the limit
        persists across all retries.
        """
        # P1: resolve model-aware detector budgets from config.
        from .completion_detector import DetectorBudgets

        budgets = DetectorBudgets.from_config(self._config.chatgpt, model)

        async def _send_and_collect() -> str:
            collected = ""
            async for chunk in self._driver.send_and_stream(
                text, timeout=timeout, budgets=budgets, model=model,
            ):
                collected += chunk.delta
            return collected

        full_text = await retry_on_rate_limit(self._driver, _send_and_collect)

        conv_id = self._driver._current_conv_id or ""
        self._last_conv_id = conv_id
        self._last_successful_send_at = time.time()
        # Bind this conversation to the REST session (covers fresh convs —
        # no conv_id existed at gate-check time — and heartbeats bound ones).
        if conv_id and session_key:
            conv_binding.claim(conv_id, session_key)

        return web.json_response(
            {
                "id": f"chatcmpl-{uuid.uuid4().hex[:29]}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "conversation_id": conv_id,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": full_text},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
        )

    async def _stream_response(
        self, request: web.Request, model: str, text: str, timeout: float,
        session_key: str | None = None,
    ) -> web.Response:
        """Streaming: SSE chunks as they arrive.

        Rate-limit handling for streaming is split, because once
        ``resp.prepare()`` commits the HTTP 200 status we can no longer send a
        429:

        - **Pre-flight** (before prepare): a single DOM scan. If throttled, we
          retry transparently (dismiss + backoff). If it persists, we return a
          proper 429 here while the status is still changeable.
        - **Mid-stream** (after prepare): a throttle is rare here (pre-flight
          cleared it), but if one occurs it falls back to the inline
          ``[Error: ...]`` SSE chunk — documented as a known limitation.
        """
        # P1: resolve model-aware detector budgets from config.
        from .completion_detector import DetectorBudgets

        budgets = DetectorBudgets.from_config(self._config.chatgpt, model)

        async def _preflight() -> None:
            """Raise RateLimitError if the pop-up is present right now."""
            try:
                scan = await self._driver._js_strict(
                    "(function(){var t=(document.body&&document.body.innerText)||'';"
                    "return JSON.stringify({text:t.slice(0,4000)});})()",
                    timeout=10,
                )
            except Exception:
                # CDP/JS error during scan — assume no rate limit (proceed).
                return
            try:
                body = json.loads(scan).get("text", "") if scan else ""
            except (json.JSONDecodeError, TypeError):
                body = ""
            if is_rate_limited_text(body):
                raise RateLimitError.from_text(body)

        # Transparent pre-flight retry — dismisses the pop-up and retries so a
        # transient limit never reaches the client as an error.
        try:
            await retry_on_rate_limit(self._driver, _preflight, max_attempts=3)
        except RateLimitError:
            # Persistent at pre-flight: still pre-prepare, so send a clean 429.
            raise

        # Circuit-open fail-fast (Phase 4 PR2): final check, after rate-limit
        # preflight but still before prepare() commits HTTP 200. A breaker may
        # have opened during model selection/navigation. After prepare() no
        # status change is possible, so this must stay pre-prepare.
        await self._check_circuit_or_recover()

        resp = web.StreamResponse()
        resp.content_type = "text/event-stream"
        resp.headers["Cache-Control"] = "no-cache"
        resp.headers["Connection"] = "keep-alive"
        if receipt := send_receipts.current():
            resp.headers["X-Operation-ID"] = receipt.operation_id
        await resp.prepare(request)

        cid = f"chatcmpl-{uuid.uuid4().hex[:29]}"
        created = int(time.time())

        # Role chunk
        await self._send_sse(
            resp,
            {
                "id": cid,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": ""},
                        "finish_reason": None,
                    }
                ],
            },
        )

        try:
            async for chunk in self._driver.send_and_stream(
                text, timeout=timeout, budgets=budgets, model=model,
            ):
                if chunk.delta:
                    await self._send_sse(
                        resp,
                        {
                            "id": cid,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model,
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {"content": chunk.delta},
                                    "finish_reason": None,
                                }
                            ],
                        },
                    )
                if chunk.finish_reason:
                    conv_id = self._driver._current_conv_id or ""
                    self._last_conv_id = conv_id
                    if conv_id and session_key:
                        conv_binding.claim(conv_id, session_key)
                    if chunk.finish_reason == "stop":
                        self._last_successful_send_at = time.time()
                    await self._send_sse(
                        resp,
                        {
                            "id": cid,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model,
                            "conversation_id": conv_id,
                            "choices": [
                                {"index": 0, "delta": {}, "finish_reason": chunk.finish_reason}
                            ],
                        },
                    )
        except RateLimitError as e:
            # Mid-stream throttle (rare after pre-flight). Status is locked at
            # 200, so we can't upgrade to 429; surface as an inline error chunk
            # with a recognizable marker so clients can detect it.
            logger.warning("Mid-stream rate limit: %s", e)
            await self._send_sse(
                resp,
                {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "content": f"\n\n[Error: rate_limit_exceeded — retry in {e.retry_after}s]"
                            },
                            "finish_reason": "error",
                        }
                    ],
                },
            )
        except AuthExpiredError:
            # Session expired mid-stream (status locked at 200). Surface with a
            # recognizable marker so clients can prompt re-login.
            logger.warning("Mid-stream auth expiry")
            await self._send_sse(
                resp,
                {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": "\n\n[Error: auth_expired — re-login required]"},
                            "finish_reason": "error",
                        }
                    ],
                },
            )
        except GenerationStuckError as e:
            # Generation stalled mid-stream (status locked at 200). Surface the
            # phase + duration so the client can decide whether to retry.
            logger.warning("Mid-stream generation stuck: %s", e)
            await self._send_sse(
                resp,
                {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "content": f"\n\n[Error: generation_stuck — stalled in {e.phase} for {e.stalled_for_s:.0f}s]"
                            },
                            "finish_reason": "error",
                        }
                    ],
                },
            )
        except Exception as e:
            logger.error("Stream error: %s", e)
            await self._send_sse(
                resp,
                {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": f"\n\n[Error: {e}]"},
                            "finish_reason": "error",
                        }
                    ],
                },
            )

        await resp.write(b"data: [DONE]\n\n")
        await resp.write_eof()
        return resp

    @staticmethod
    async def _send_sse(resp: web.StreamResponse, data: dict) -> None:
        await resp.write(f"data: {json.dumps(data)}\n\n".encode())
