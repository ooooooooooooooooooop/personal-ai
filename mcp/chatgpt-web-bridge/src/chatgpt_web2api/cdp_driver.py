"""CDP Driver — browser automation via Chrome DevTools Protocol.

Connects to an existing Chrome instance via CDP websocket.
Provides typed primitives for:
  - Auth token management
  - JS evaluation
  - Page navigation
  - Message input via synthetic paste event on the ProseMirror composer
    (execCommand fallback for the legacy textarea)
  - Response retrieval via conversation API
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import re
import time
import urllib.parse
import urllib.request
from collections.abc import AsyncIterator
from dataclasses import dataclass
from enum import Enum

from .breakers import BreakerKind, BreakerRegistry
from .diagnostics import diagnose
from .lock_resolver import (
    MutationLock,
    OwnedTabRequiredError,
    resolve_mutation_lock,
)

try:
    import websockets
except ImportError:
    raise ImportError("pip install websockets")

logger = logging.getLogger(__name__)


@dataclass
class StreamChunk:
    """A single streaming chunk."""

    delta: str
    finish_reason: str | None = None


# Conservative fallback wait (seconds) when ChatGPT's pop-up gives no exact
# number (it usually says "a few minutes"). Chosen to be long enough to let
# a real cooldown clear but short enough that a transient blip recovers fast.
RATE_LIMIT_DEFAULT_RETRY_AFTER = 60


class DeliveryStage(str, Enum):
    """How far a mutating web send got before it failed.

    The distinction is deliberately conservative.  A rate-limit or transport
    error is safe to retry automatically only while it is still known that no
    submit action was attempted.  Once the click was dispatched, the bridge
    must surface the ambiguity to the caller instead of risking a duplicate
    user message.
    """

    NOT_STARTED = "not_started"
    SUBMISSION_ATTEMPTED = "submission_attempted"
    ACKNOWLEDGED = "acknowledged"
    UNKNOWN = "unknown"


def _delivery_stage_value(stage: str | DeliveryStage | None) -> str:
    """Return a stable wire value for a delivery stage."""

    if isinstance(stage, DeliveryStage):
        return stage.value
    if stage in {item.value for item in DeliveryStage}:
        return str(stage)
    return DeliveryStage.UNKNOWN.value

# Re-exported from backend_client (Phase 5 PR1 extraction) for back-compat.
# Canonical home is now backend_client.py.
from .backend_client import TOKEN_TTL_SECONDS  # noqa: E402,F401

# Phase 5 PR4: generation-completion stall window + rate-limit pop-up text
# matcher extracted into completion_detector.py; re-exported here for back-compat
# (is_rate_limited_text is imported from cdp_driver by api_server, chatgpt_dom,
# and tests). _RATE_LIMIT_PHRASES stays private to completion_detector.
from .completion_detector import (  # noqa: E402,F401
    PHASE_STALL_SECONDS,
    is_rate_limited_text,
)

# How long to wait (seconds) for a freshly-created owned tab to settle on
# chatgpt.com before refreshing the access token. ``_create_owned_tab`` only
# waits for the target's webSocketDebuggerUrl to appear in /json/list, which
# fires within milliseconds of Target.createTarget — well before the page has
# navigated to chatgpt.com. Calling ``_refresh_token`` on that cold tab races:
# the relative ``fetch('/api/auth/session')`` resolves against the wrong origin
# (e.g. about:blank) and returns an empty accessToken, tripping the auth gate
# and killing the whole MCP process on startup. Polling for readiness first
# (page on chatgpt.com + readyState !== 'loading') lets the fetch resolve
# correctly. 10s is generous for even a slow first load; the 0.5s poll cadence
# matches ``navigate_new_chat``.
_CONNECT_READY_TIMEOUT = 10

# ChatGPT composer / send-button selectors.
#
# Canonical home moved to chatgpt_dom.py in Phase 5 PR3; re-exported here for
# back-compat (tests import these from cdp_driver, and the navigation methods
# that stay here still reference them).
from .chatgpt_dom import (  # noqa: E402,F401
    COMPOSER_FALLBACK_SELECTOR,
    COMPOSER_SELECTOR,
    SEND_BUTTON_FALLBACK_SELECTOR,
    SEND_BUTTON_SELECTOR,
)

# ── P2: Navigation readiness probe ────────────────────────────────────────
#
# Co-designed with ChatGPT (vision-alignment cycle, conversation 6a4ebb2a).
# Replaces the opaque "ready composer" poll with a staged probe that captures
# WHICH readiness stage passed and which failed. When the poll fails, the
# error message names the stage (e.g. "url correct but composer not present")
# instead of the old "did not reach a ready composer within the timeout".
#
# Stages (each must pass for the next to matter):
#   url_correct → document_ready → app_shell_present → composer_present

@dataclass
class NavigationReadinessProbe:
    """Results of a single navigation-readiness probe poll.

    Captured each poll iteration so the caller can build a diagnostic error
    message naming the stage that failed. The JS probe evaluates all stages
    in one ``Runtime.evaluate`` call (no extra round-trips).
    """
    url: str
    ready_state: str
    app_shell_present: bool
    composer_present: bool

    @property
    def document_ready(self) -> bool:
        return self.ready_state == "complete"

    def is_ready(self, url_correct: bool) -> bool:
        """All stages passed — page loaded AND composer ready AND URL matches.

        ``url_correct`` is passed by the caller (it knows the target
        conversation_id; the probe doesn't).
        """
        return (
            url_correct
            and self.document_ready
            and self.app_shell_present
            and self.composer_present
        )

    def diagnostic_summary(self, url_correct: bool) -> str:
        """Human-readable description of which stage failed.

        Names the first failing stage so the error message points at the
        real problem instead of an opaque 'timeout'.
        """
        if not url_correct:
            return f"url displaced (got {self.url[:80]})"
        if not self.document_ready:
            return f"document still loading (readyState={self.ready_state})"
        if not self.app_shell_present:
            return "app shell not present (ChatGPT nav/sidebar missing)"
        if not self.composer_present:
            return "composer not present (selector did not match after page loaded)"
        return "all stages passed"


class RateLimitError(RuntimeError):
    """Raised when ChatGPT shows its 'Too many requests' rate-limit pop-up.

    Carries ``retry_after`` (seconds) so consumer layers can surface a
    standard OpenAI 429 with a ``Retry-After`` header, or an MCP structured
    result with a machine-readable wait. When the pop-up text is available,
    construct via :meth:`from_text` to parse the duration automatically.

    ChatGPT temporarily throttles rapid conversation access. When this fires
    the assistant never responds, so without detection ``send_and_stream``
    would spin for 60s and time out. Catching the pop-up lets callers fail
    fast with a clear, actionable message.
    """

    def __init__(
        self,
        message: str | None = None,
        retry_after: int = RATE_LIMIT_DEFAULT_RETRY_AFTER,
        *,
        delivery_stage: str | DeliveryStage = DeliveryStage.UNKNOWN,
        conversation_id: str | None = None,
        user_message_id: str | None = None,
    ) -> None:
        if message is None:
            message = f"ChatGPT rate limit reached (Too many requests). Retry in {retry_after}s."
        super().__init__(message)
        self.retry_after = int(retry_after)
        self.delivery_stage = _delivery_stage_value(delivery_stage)
        self.conversation_id = conversation_id
        self.user_message_id = user_message_id

    @property
    def retryable(self) -> bool:
        """Whether retrying the whole operation is known to be safe."""

        return self.delivery_stage == DeliveryStage.NOT_STARTED.value

    @classmethod
    def from_text(cls, text: str) -> RateLimitError:
        """Build a RateLimitError, parsing the wait from the pop-up *text*."""
        retry_after = parse_retry_after(text)
        return cls(retry_after=retry_after)


class AuthExpiredError(RuntimeError):
    """Raised when the ChatGPT access token is stale or rejected (HTTP 401).

    Previously a 401 from /backend-api/* was silently swallowed (reads
    returned []/{}/'', send_and_stream blocked 60s then raised a generic
    "Timed out waiting for assistant response"). This error surfaces the
    real cause so callers can prompt re-login instead of misdiagnosing it
    as a timeout or empty data.
    """

    def __init__(self, message: str | None = None) -> None:
        if message is None:
            message = "ChatGPT session expired — re-login required"
        super().__init__(message)


class GenerationStuckError(RuntimeError):
    """Raised when a generation stalls — no DOM progress within the stall window.

    Distinct from a *slow* generation (which keeps making progress and is
    allowed the full timeout). The ``phase`` and ``stalled_for_s`` attributes
    are machine-readable so MCP/REST layers can surface them in structured
    results; the message is for humans.

    - ``phase == "phase_1_appear"``: assistant message node never appeared.
    - ``phase == "phase_2_stream"``: streaming started but text stopped changing.

    P1 (2026-07-08): phase-2 stalls now carry richer structured fields for
    observability and caller-side reconciliation decisions:

    - ``stall_kind``: ``"first_content_timeout"`` (no text appeared within the
      first-content budget — common for reasoning models in the thinking phase)
      or ``"stream_idle_timeout"`` (text appeared then stopped progressing) or
      ``"hard_timeout"`` (absolute wall-clock cap exceeded).
    - ``model_class``: ``"reasoning"`` or ``"default"`` (from classify_model).
    - ``elapsed_seconds``: total time spent in phase-2 observation.
    - ``generation_active_signal``: whether a DOM thinking/generating indicator
      was present at the moment of the stall (advisory — a liveness hint).
    - ``turn_id``: the turn anchor's captured UUID if available, for caller-side
      reconciliation/retry of OBSERVATION (never retry the send).

    The structured fields are optional (keyword-only) so existing phase-1
    construction sites remain compatible. Callers should NEVER auto-retry the
    SEND on a phase-2 stall (the generation may still be running and would
    duplicate the message). Safe retry is observation-only: re-read the
    conversation and reconcile against the same turn.
    """

    def __init__(
        self,
        phase: str,
        stalled_for_s: float,
        *,
        stall_kind: str | None = None,
        model_class: str | None = None,
        elapsed_seconds: float | None = None,
        generation_active_signal: bool | None = None,
        turn_id: str | None = None,
    ) -> None:
        self.phase = phase
        self.stalled_for_s = float(stalled_for_s)
        # P1 structured fields (optional for back-compat with phase-1 sites).
        self.stall_kind = stall_kind
        self.model_class = model_class
        self.elapsed_seconds = float(elapsed_seconds) if elapsed_seconds is not None else None
        self.generation_active_signal = generation_active_signal
        self.turn_id = turn_id
        # Human-readable message includes the stall kind if available.
        kind_str = f" ({stall_kind})" if stall_kind else ""
        super().__init__(
            f"Generation stalled in {phase}{kind_str} for {stalled_for_s:.0f}s — no DOM progress"
        )


class CDPJSError(RuntimeError):
    """Raised by _js_strict when a JS evaluation fails (exceptionDetails or
    CDP-level error). The soft _js collapses these to "" silently; _js_strict
    surfaces them so callers can distinguish "the JS threw" from "the result
    is genuinely empty." Carries the raw exceptionDetails for diagnosis.
    """

    def __init__(self, message: str, details: dict | None = None) -> None:
        self.details = details or {}
        super().__init__(message)


class SendReadinessError(RuntimeError):
    """Raised when the composer / send-readiness path fails — no composer found,
    the composer wouldn't focus, or the send button didn't fire.

    Typed (not bare ``RuntimeError``) so the breaker wiring can classify it
    explicitly at the catch site as ``BreakerKind.COMPOSER_SEND_READINESS``
    rather than guessing from a string. Raised by ``_ensure_send_ready``,
    ``type_message``, and ``click_send``.
    """

    def __init__(
        self,
        message: str = "",
        *,
        delivery_stage: str | DeliveryStage = DeliveryStage.NOT_STARTED,
        conversation_id: str | None = None,
        user_message_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.delivery_stage = _delivery_stage_value(delivery_stage)
        self.conversation_id = conversation_id
        self.user_message_id = user_message_id


class ModelSelectionError(RuntimeError):
    """Raised when a caller-requested model cannot be selected in the UI."""

    def __init__(self, requested_model: str, message: str | None = None) -> None:
        self.requested_model = requested_model
        super().__init__(
            message
            or f"Requested model '{requested_model}' could not be selected in ChatGPT"
        )


class GenerationInProgressError(RuntimeError):
    """Raised when a send targets a conversation that is mid-generation.

    ChatGPT's web UI lets a new message interrupt the streaming reply —
    observed in the field as 1-2 char truncated answers when two harness
    sessions shared one conv_id across different tabs/processes (the
    MutationLock is per-target, not per-conversation). The gate is checked
    before typing: fail fast with ``retry_after`` so the caller waits or
    polls ``wait_reply`` instead of murdering the in-flight generation.
    """

    def __init__(self, conversation_id: str, retry_after: float = 0.0) -> None:
        super().__init__(
            f"conversation {conversation_id} is mid-generation; "
            f"sending now would interrupt the streaming reply"
        )
        self.conversation_id = conversation_id
        self.retry_after = retry_after


class CDPReconnectError(RuntimeError):
    """Raised when CDP reconnect exhausts its 3-attempt backoff without
    re-establishing the websocket.

    Typed (not bare ``RuntimeError``) so the breaker wiring can classify it
    explicitly as ``BreakerKind.CDP_RECONNECT``.
    """


# Phrases ChatGPT uses in its rate-limit pop-up + the ``is_rate_limited_text``
# matcher moved to completion_detector.py (Phase 5 PR4); re-exported above.

def parse_retry_after(text: str, default: int = RATE_LIMIT_DEFAULT_RETRY_AFTER) -> int:
    """Extract a retry-after duration in seconds from ChatGPT's pop-up text.

    The pop-up usually says "Please wait a few minutes" with no exact number;
    in that case we return *default*. When an explicit number is present
    ("try again in 2 minutes", "wait 30 seconds"), parse and convert it.

    Words like "a few minutes" are deliberately NOT parsed to a specific value
    (they're vague); the conservative default is safer than guessing.
    """
    if not text:
        return default
    lowered = text.lower()

    # Look for "<n> minute(s)" or "<n> min", "<n> second(s)" / "<n> sec(s)".
    # Match digits or number words.
    _NUM_WORDS = {
        "one": 1,
        "two": 2,
        "three": 3,
        "four": 4,
        "five": 5,
        "six": 6,
        "seven": 7,
        "eight": 8,
        "nine": 9,
        "ten": 10,
    }

    def _to_num(token: str) -> int | None:
        if token.isdigit():
            return int(token)
        return _NUM_WORDS.get(token)

    # "<n> minute(s)" → seconds = n * 60
    m = re.search(
        r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:minutes?|mins?)", lowered
    )
    if m:
        n = _to_num(m.group(1))
        if n is not None:
            return n * 60

    # "<n> second(s)" / "<n> sec(s)"
    m = re.search(
        r"(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:seconds?|secs?)", lowered
    )
    if m:
        n = _to_num(m.group(1))
        if n is not None:
            return n

    return default


class CDPDriver:
    """Chrome DevTools Protocol driver for ChatGPT automation."""

    def __init__(
        self,
        cdp_port: int = 9222,
        tab_mode: str = "owned",
        instance_id: str | None = None,
        breakers: BreakerRegistry | None = None,
        *,
        parallel_tabs: bool = False,
        conv_affinity: str | None = None,
        pace_send_seconds: float | None = None,
        pace_read_seconds: float | None = None,
        pace_cooldown_seconds: float | None = None,
    ) -> None:
        # Conversation-affine mode (conv_affinity): this driver is bound to ONE
        # conversation. On connect it prefers a tab already showing /c/{id}
        # (cross-process shared resource) over creating a new tab; if none
        # exists it creates one AT the conversation URL — a tab's URL is its
        # conversation identity. Conv-bound tabs are persistent (never closed
        # by any driver) and never navigated to another conversation.
        self._conv_affinity = conv_affinity
        self._conv_target = False  # current target is a conv-bound shared tab
        self._scratch_target_id: str | None = None  # our own home/scratch tab
        # Shared-home target: current target is a bare chatgpt.com/ tab we
        # adopted rather than created — the single workspace tab that all
        # non-conv drivers converge on. Lockable like a conv-bound tab (the
        # lock key is the targetId), but never closed by us and free to be
        # navigated by whichever driver needs a scratch surface.
        self._shared_home_target = False
        self.port = cdp_port
        # PR4/5: when True, owned-tab creation is mandatory (no shared-tab
        # fallback) and the resolver grants per-target locks. Config validates
        # tab_mode=owned when this is True; here we just store the flag.
        self._parallel_tabs = parallel_tabs
        # Tab isolation strategy: "owned" creates a dedicated chatgpt.com tab
        # per driver (multi-session safe — two drivers get two DOMs). "adopt"
        # reuses an existing chatgpt.com tab (single-process compat). The
        # default is "owned" because adoption lets one session navigate
        # another's shared tab out from under it. See connect().
        self.tab_mode = tab_mode if tab_mode in ("owned", "adopt") else "owned"
        # Owned-tab registry (R3): persists this instance's owned tab so a
        # restarted process reclaims its OWN prior tab instead of orphaning it
        # and creating a new one. Reclaim is instance-scoped (never cross-
        # session adoption) and lease-protected (never steals a live owner's
        # tab). None disables the registry (e.g. adopt mode, tests).
        from .tab_registry import TabRegistry

        self.instance_id = instance_id or TabRegistry.derive_instance_id(cdp_port=cdp_port)
        self._tab_registry = TabRegistry(self.instance_id) if tab_mode == "owned" else None
        self._heartbeat_task: asyncio.Task | None = None
        self._ws = None
        self._msg_id = 0
        self._access_token = ""
        self._user_name = ""
        self._token_fetched_at: float = 0.0
        # Observability for refresh attempts distinct from the last *accepted*
        # token time. _token_fetched_at advances only on a non-empty token;
        # _last_refresh_attempt_at advances on every fetch attempt (success
        # or fail), so backoff/diagnostics can distinguish "stale token, last
        # refresh tried Ns ago" from "never refreshed."
        self._last_refresh_attempt_at: float = 0.0
        self._current_conv_id: str | None = None
        self._current_model: str | None = None
        # Per-send delivery state.  This is reset at the beginning of every
        # ``send_and_stream`` invocation so a retry or a later request can
        # never inherit an ambiguous state from an earlier turn.
        self._delivery_stage = DeliveryStage.NOT_STARTED.value
        self._delivery_conversation_id: str | None = None
        self._delivery_user_message_id: str | None = None
        # ``True`` is set only after anchored final reconciliation proves that
        # this turn persisted. ``None`` is retained for DOM-only/degraded
        # paths where the browser showed a response but the backend could not
        # attest persistence.
        self._delivery_reply_persisted: bool | None = None
        # Account-level request pacing (shared file gate — see request_pace).
        # Sends and backend-api fetches both count toward ChatGPT's per-account
        # throttle; pacing here prevents the "请求过于频繁" interstitial instead
        # of only reacting to it.
        from .request_pace import RequestPace

        self._pace = RequestPace(
            send_interval=pace_send_seconds,
            read_interval=pace_read_seconds,
            cooldown_seconds=pace_cooldown_seconds,
        )
        # CDP response routing (#7): id-keyed futures + background reader
        self._pending: dict[int, asyncio.Future] = {}
        # Forensic twin of _pending: id → (method, sent-at loop time).  The
        # transport dumps it when a session is poisoned so a wedge report
        # shows WHICH commands were in flight instead of just "timed out".
        self._pending_meta: dict[int, tuple[str, float]] = {}
        # Session-poison state (transport-owned): set when a command's
        # response never arrives (possible head-of-line queue wedge); the
        # next command reattaches a fresh session under _poison_lock before
        # sending.  See CDPTransport._poison_session/_recover_poisoned_session.
        self._session_poisoned: bool = False
        self._poison_lock = asyncio.Lock()
        self._reader_task: asyncio.Task | None = None
        # A2: unsolicited CDP event dispatch table. The reader loop consults
        # this for events without an id (Network.requestWillBeSent, etc.).
        # Handlers must be fast and non-blocking — the reader loop is the sole
        # ws.recv() consumer and resolves all pending command futures; heavy
        # work must be scheduled via loop.create_task. See CDPTransport._reader_loop.
        self._cdp_event_handlers: dict[str, callable] = {}
        # A2: identity listener (network-event-driven UUID capture). Owned by
        # the driver (Layer 2), attached on connect/reconnect. Lazy-imported
        # at attach time to avoid a module-load circular dependency.
        self._identity_listener = None
        # Tab isolation: the targetId of the tab this driver is attached to.
        # _owns_target records whether *we* created it: only tabs we created are
        # closed in close(), so a driver that adopted an existing tab (e.g.
        # Chrome's launch tab) never closes a tab it didn't open — preventing
        # tab accumulation across service restarts while preserving the user's
        # open tabs on clean shutdown.
        self._target_id: str | None = None
        self._owns_target: bool = False
        # Phase 4 PR2: optional circuit-breaker registry. When set, failure
        # sites record/trip their kind and success sites clear failures /
        # recover half-open breakers. None = back-compat (tests, legacy
        # construction) — every recorder checks `if self._breakers:`.
        self._breakers = breakers
        # Phase 5 PR1: backend-api fetch helpers extracted into BackendClient.
        # Lazy import (like _tab_registry) to avoid load-time coupling; the
        # client holds a back-reference to this driver for transport + state.
        from .backend_client import BackendClient

        self._backend_client = BackendClient(self)
        # Phase 5 PR2: CDP wire primitives extracted into CDPTransport. Lazy
        # import for the same reason; the transport reaches through this driver
        # for _ws/_msg_id/_pending and calls back into reconnect() on socket death.
        from .cdp_transport import CDPTransport

        self._transport = CDPTransport(self)
        # Phase 5 PR3: ChatGPT composer DOM interaction extracted into
        # ChatGPTDom. Lazy import for the same reason; the DOM layer reaches
        # through this driver for _js/_cdp/_breakers and calls back into
        # navigate_new_chat() for the send-readiness path.
        from .chatgpt_dom import ChatGPTDom

        self._dom = ChatGPTDom(self)
        # Phase 5 PR4: streaming completion detection (Phase-1 appear loop +
        # Phase-2 stream loop) extracted into CompletionDetector. Lazy import
        # for the same reason; the detector reaches through this driver for
        # _js_strict, _fetch_end_turn_for_turn,
        # _get_live_conversation_id_best_effort, and reads _current_conv_id
        # (read-only — never assigned by the detector). It yields delta chunks
        # only; the terminal stop chunk and the _current_conv_id mutation stay
        # in send_and_stream.
        from .completion_detector import CompletionDetector

        self._completion = CompletionDetector(self)

    def _reset_delivery_metadata(self) -> None:
        """Reset delivery metadata before starting a new send attempt."""

        self._delivery_stage = DeliveryStage.NOT_STARTED.value
        self._delivery_conversation_id = self._current_conv_id
        self._delivery_user_message_id = None
        self._delivery_reply_persisted = None

    def _set_delivery_stage(
        self,
        stage: str | DeliveryStage,
        *,
        conversation_id: str | None = None,
        user_message_id: str | None = None,
    ) -> None:
        """Record the most conservative known delivery state for this send."""

        self._delivery_stage = _delivery_stage_value(stage)
        if conversation_id is not None:
            self._delivery_conversation_id = conversation_id
        if user_message_id is not None:
            self._delivery_user_message_id = user_message_id

    @property
    def delivery_metadata(self) -> dict[str, str | bool | None]:
        """Return the current send's delivery metadata for callers/diagnostics."""

        return {
            "delivery_stage": self._delivery_stage,
            "conversation_id": self._delivery_conversation_id,
            "user_message_id": self._delivery_user_message_id,
            "reply_persisted": self._delivery_reply_persisted,
        }

    @property
    def last_delivery(self) -> dict[str, str | bool | None]:
        """Compatibility alias for transports exposing the latest receipt."""

        return self.delivery_metadata

    def _annotate_delivery_error(self, exc: Exception) -> None:
        """Attach send state and IDs to an error without changing its type.

        Existing exception classes and third-party errors remain usable by
        callers.  The attributes are best-effort because a few extension
        exceptions may use ``__slots__``; failure to annotate must never hide
        the original error.
        """

        fields = {
            "delivery_stage": self._delivery_stage,
            "conversation_id": self._delivery_conversation_id or self._current_conv_id,
            "user_message_id": self._delivery_user_message_id,
        }
        for name, value in fields.items():
            try:
                setattr(exc, name, value)
            except Exception:
                pass

    async def _notify_send_progress(
        self,
        callback,
        phase: str,
    ) -> None:
        """Best-effort phase notification for long pre-send operations."""

        if callback is None:
            return
        try:
            result = callback(phase)
            if inspect.isawaitable(result):
                await result
        except asyncio.CancelledError:
            # A caller cancellation must remain a cancellation, even if it
            # arrives while a progress callback is running.
            raise
        except Exception:
            logger.debug("send progress callback failed for phase=%s", phase, exc_info=True)

    async def _attach_identity_listener(self) -> None:
        """A2: attach (or re-attach) the identity listener on the current ws.

        Called from ``connect()`` and ``reconnect()`` after the reader loop is
        running. The listener registers its ``Network.requestWillBeSent``
        handler on ``self._cdp_event_handlers`` and enables the Network domain
        for POST-body capture. Best-effort: a failure logs and leaves the
        listener unready — ``send_and_stream`` will fall back to dual-anchor
        correlation on the next send via the pre-send health check.
        """
        # Lazy import to avoid the module-load circular dependency
        # (identity_listener imports nothing from cdp_driver, but keeping
        # the pattern consistent with BackendClient/CompletionDetector).
        from .identity_listener import IdentityListener

        if self._identity_listener is None:
            self._identity_listener = IdentityListener(self)
        # Re-attach is idempotent: detach clears the old handler, attach
        # re-registers and re-enables Network on the new websocket.
        self._identity_listener.detach()
        try:
            await self._identity_listener.attach()
        except PermissionError:
            raise
        except Exception as e:
            logger.warning("identity_listener_attach_failed (will degrade to dual-anchor): %s", e)

    async def _stop_cdp_session(
        self,
        *,
        fail_pending: bool = True,
        reset_poison: bool = False,
        timeout: float = 2.0,
    ) -> None:
        """Stop the current reader/socket as one lifecycle transaction.

        The ownership fields are cleared *before* closing the websocket.  A
        cancellation-resistant reader can therefore finish on its pinned old
        socket without touching a replacement socket's pending table or
        poisoning the replacement session.  All lifecycle entry points use
        this helper so connect, reconnect, send-recovery, and close cannot
        drift into four subtly different teardown orders.
        """

        ws = self._ws
        reader = self._reader_task
        # Make the old reader stale before any await.  The transport checks
        # this identity on both frame and exception paths.
        self._ws = None
        self._reader_task = None

        # Cancel reader/pending state synchronously before the first await.
        # If close() itself is cancelled, callers still cannot be left with a
        # live reader or futures that wait on the old session forever.
        if reader is not None and reader is not asyncio.current_task():
            try:
                if not reader.done():
                    reader.cancel()
            except Exception:
                logger.debug("Could not synchronously cancel CDP reader", exc_info=True)
        if fail_pending:
            for future in list(self._pending.values()):
                if not future.done():
                    future.cancel()
            self._pending.clear()
            if getattr(self, "_pending_meta", None) is not None:
                self._pending_meta.clear()

        if ws is not None:
            if timeout <= 0:
                # Failure cleanup must not consume the already exhausted CDP
                # command budget.  Schedule the normal websocket close and
                # consume its result without blocking the caller.
                try:
                    close_result = ws.close()
                    if inspect.isawaitable(close_result):
                        close_task = asyncio.create_task(close_result)

                        def _consume_close(task):
                            try:
                                task.result()
                            except BaseException:
                                pass

                        close_task.add_done_callback(_consume_close)
                except Exception:
                    logger.debug("CDP websocket close scheduling failed", exc_info=True)
            else:
                try:
                    await asyncio.wait_for(ws.close(), timeout=timeout)
                except asyncio.CancelledError:
                    raise
                except asyncio.TimeoutError:
                    logger.error("CDP websocket did not close within teardown budget")
                except Exception:
                    logger.debug("CDP websocket close failed during teardown", exc_info=True)

        if reader is not None and reader is not asyncio.current_task():
            try:
                if not reader.done():
                    if timeout > 0:
                        try:
                            await asyncio.wait_for(reader, timeout=timeout)
                        except asyncio.CancelledError:
                            if asyncio.current_task().cancelling():
                                raise
                        except asyncio.TimeoutError:
                            logger.error("CDP reader did not stop within teardown budget")
            except (asyncio.CancelledError, asyncio.TimeoutError):
                raise
            except Exception:
                logger.debug("CDP reader teardown failed", exc_info=True)
        if reset_poison:
            self._session_poisoned = False

    def _start_cdp_reader(self, ws) -> None:
        """Start one reader bound to the exact websocket just installed."""

        self._ws = ws
        try:
            # Passing ws at task creation is the important part: a reader that
            # starts after reconnect must not resolve self._ws dynamically.
            coroutine = self._reader_loop(ws)
        except TypeError:
            # A few offline tests replace the delegator with a legacy no-arg
            # coroutine.  Keep that seam working; production CDPDriver uses
            # the explicit-argument branch above.
            coroutine = self._reader_loop()
        self._reader_task = asyncio.create_task(coroutine)

    async def connect(self) -> None:
        """Connect to Chrome's CDP and authenticate.

        Tab isolation: creates a dedicated chatgpt.com tab via Target.createTarget
        so this process owns its own DOM (no cross-process tab sharing). Falls back
        to the shared-tab discover-and-grab pattern if createTarget fails.

        If already connected (e.g. Service reconnects after login), reuses the
        existing owned tab instead of creating a new one.
        """
        # If we already own a tab from a prior connect attempt, reuse it.  The
        # unified teardown marks the old socket stale before close/cancel.
        await self._stop_cdp_session(fail_pending=True, reset_poison=True)

        # Resolve which tab to attach to, in priority order. The strategy is
        # governed by self.tab_mode:
        #
        #   "owned" (default, multi-session safe): each driver creates its own
        #     chatgpt.com tab via Target.createTarget. Two simultaneous drivers
        #     get two DOMs and cannot navigate each other's tab. Adoption is
        #     skipped unless _target_id is already set (reconnect/restart).
        #
        #   "adopt" (single-process compat): reuse an existing chatgpt.com tab
        #     when present (the pre-multi-session behavior). Cheaper on tab
        #     count, but two drivers adopting the same tab will contend on the
        #     shared DOM — only safe when you know there's a single driver.
        #
        #   1. Re-attach to a tab we already know about (_target_id set from a
        #      prior connect), whether we created it or adopted it. Both modes.
        #   2. owned mode → create a new owned tab.
        #      adopt mode → adopt an existing chatgpt.com tab, else create.
        #   3. Fallback (both modes): attach to any available page tab.
        ws_url = None
        if self._target_id:
            # Reuse the tab we already attached to on a prior connect attempt.
            ws_url = self._find_owned_tab_ws()
            if ws_url:
                logger.info("Reusing tab: %s", self._target_id)
        if not ws_url and self.tab_mode == "adopt":
            # Single-process compat: try to adopt an existing chatgpt.com tab.
            ws_url = self._adopt_existing_chatgpt_tab()
        if not ws_url and self._conv_affinity:
            # Conversation-affine: adopt the tab already showing this
            # conversation (shared cross-process resource) before creating.
            ws_url = self._adopt_conversation_tab(self._conv_affinity)
            if ws_url:
                logger.info(
                    "Adopted existing conversation tab for %s",
                    self._conv_affinity,
                )
        if not ws_url and not self._conv_affinity:
            # Shared home workspace: non-conv drivers (utility slot, unbound
            # session slots, the REST driver) adopt one existing bare
            # chatgpt.com/ tab instead of each parking a private homepage.
            # Converges to a single background tab — fewer live ChatGPT
            # clients means less unthrottled background traffic on the
            # rate-limited conversations endpoints. Reads are async JS
            # fetches that don't contend on DOM state; the rare mutations
            # serialize on the per-target MutationLock.
            ws_url = self._adopt_bare_home_tab()
        if not ws_url:
            # Registry reclaim (R3): before creating a new tab, check if THIS
            # instance owned a tab in a prior run that's still alive. Reclaim
            # is instance-scoped and lease-protected — never cross-session
            # adoption, never steals a live owner's tab. Skipped in adopt mode.
            if self._tab_registry:
                try:
                    live_ids = await self._live_target_ids()
                    reclaimed = self._tab_registry.reclaim(live_ids)
                    if reclaimed:
                        self._target_id = reclaimed
                        self._owns_target = True
                        ws_url = self._find_owned_tab_ws()
                        if ws_url:
                            logger.info(
                                "Reclaimed owned tab from registry: %s (instance %s)",
                                reclaimed,
                                self.instance_id,
                            )
                except Exception as e:
                    logger.debug("Tab registry reclaim failed (will create new): %s", e)
        if not ws_url:
            # Default path (owned mode) and adopt-mode fallback: create a new
            # dedicated tab so this driver owns its own DOM.
            try:
                ws_url = await self._create_owned_tab()
                logger.info("Connected via owned tab: %s", self._target_id)
                # Record the new tab in the registry so a restart can reclaim it.
                if self._tab_registry and self._target_id:
                    try:
                        self._tab_registry.record(self._target_id)
                    except Exception as e:
                        logger.debug("Tab registry record failed: %s", e)
            except (OwnedTabRequiredError, PermissionError):
                # Never swallow the parallel-mode fail-closed signal — it must
                # propagate as REST 503 / MCP isError, not become a login wait.
                raise
            except Exception as e:
                if self._parallel_tabs:
                    # Parallel mode: refuse the shared-tab fallback. A fallback
                    # tab cannot be per-target locked, so silently adopting one
                    # would reintroduce the split-brain the bundle eliminates.
                    raise OwnedTabRequiredError(
                        f"Owned-tab creation failed in parallel mode; refusing "
                        f"shared-tab fallback: {e}"
                    ) from e
                if self.tab_mode == "owned":
                    # Owned mode: never adopt an arbitrary tab. The adopt
                    # fallback (_find_page_ws) picks ANY chatgpt.com tab,
                    # which could belong to another process — causing two
                    # drivers to race on the same tab. Fail closed with
                    # OwnedTabRequiredError (consistent with reconnect path)
                    # so callers have one stable failure contract.
                    # (ChatGPT design review, conv 6a507b4c + 6a526e19.)
                    raise OwnedTabRequiredError(
                        f"Owned-tab creation failed and shared-tab fallback "
                        f"is disabled in owned mode: {e}"
                    ) from e
                logger.warning("Tab isolation failed (%s) — falling back to shared tab", e)
                self._target_id = None
                self._owns_target = False
                ws_url = await self._find_page_ws()
        # Keepalive: ping every 20s, allow 10s for pong response. This is
        # the pre-A2 production value (set during parallel-tabs PR2); the A2
        # plan proposed ping_timeout=60, but the existing value of 10 passed
        # the post-idle survival test (130s idle, listener stayed alive) and
        # is tighter against transient stalls. Kept deliberately; see PR #39
        # review finding #4.
        connected_ws = await websockets.connect(
            ws_url,
            max_size=100 * 1024 * 1024,
            ping_interval=20,
            ping_timeout=10,
        )
        self._start_cdp_reader(connected_ws)
        logger.info("CDP connected to Chrome")
        # A2: attach the identity listener now that the reader loop is running.
        # Persistent from connect — re-attached on reconnect. The listener
        # registers its Network.requestWillBeSent handler on the dispatch
        # table (Step 1) and enables the Network domain for POST-body capture.
        try:
            await self._attach_identity_listener()
            # Wait for the freshly-grabbed tab to actually be on chatgpt.com before
            # fetching the token — see _wait_for_chatgpt_ready. Without this the
            # fetch races the page load and returns an empty accessToken, killing
            # the MCP process on startup. Best-effort: a False return falls through
            # to _refresh_token, which has its own retry loop as a safety net.
            await self._wait_for_chatgpt_ready()
            await self._refresh_token()
        except BaseException:
            # Do not leave a half-attached reader/socket behind when auth or
            # identity setup fails.  The caller can retry connect cleanly.
            try:
                await self._stop_cdp_session(
                    fail_pending=True,
                    reset_poison=True,
                    timeout=0 if asyncio.current_task().cancelling() else 2,
                )
            except asyncio.CancelledError:
                if asyncio.current_task().cancelling():
                    raise
            raise
        # Establish the send-readiness invariant before connect() returns: a
        # connected driver must be able to type a message. connect() may have
        # attached to a chatgpt.com/ home/landing tab (or adopted an arbitrary
        # existing tab) that is auth-valid but lacks the composer — without
        # this, the next type_message raises "No composer found" and surfaces
        # as an opaque 500. Done AFTER auth so we never navigate on an
        # unauthenticated page. Best-effort: a failure logs and falls through
        # (send_and_stream has its own defensive check); it does not abort
        # startup, since reads (list_models etc.) work without a composer.
        try:
            if self._shared_home_target and self._parallel_tabs:
                # The shared home tab is mutated by whichever driver needs a
                # scratch surface — send-readiness may navigate it, so
                # serialize with other drivers' sends on this target.
                _port, _key = resolve_mutation_lock(self, True)
                async with MutationLock(_port, _key):
                    await self._ensure_send_ready()
            else:
                await self._ensure_send_ready()
        except Exception as e:
            logger.warning(
                "connect(): send-readiness not established (%s) — reads still "
                "work; sends will fail until the tab reaches a chat page",
                e,
            )
        # Start the heartbeat lease for our owned tab (R3), so a long
        # generation (60-90s) doesn't let the lease expire and let another
        # process reclaim our tab mid-stream. Background task, cancelled in
        # close(). Also opportunistically heartbeats on send/connect.
        self._start_heartbeat()

    def _start_heartbeat(self) -> None:
        """Start the background heartbeat task for the owned-tab lease."""
        if self._heartbeat_task and not self._heartbeat_task.done():
            return
        if not self._tab_registry:
            return
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def _heartbeat_loop(self) -> None:
        """Refresh this instance's tab lease every HEARTBEAT_INTERVAL_SECONDS.

        Runs for the driver's lifetime so a 90s generation can't expire the
        60s TTL. Self-healing: a single heartbeat exception is logged and the
        loop continues — if the task died, the lease would expire and another
        process could reclaim our tab mid-session (ensure_current_conversation
        guards wrong-conversation sends, but not the tab being closed/reused).
        Only CancelledError (close/shutdown) stops the loop.
        """
        from .tab_registry import HEARTBEAT_INTERVAL_SECONDS

        try:
            while True:
                try:
                    await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
                    self._tab_registry.heartbeat(self._target_id)
                except asyncio.CancelledError:
                    raise  # shutdown — let it propagate
                except Exception as e:
                    logger.warning("Heartbeat failed (will retry): %s", e)
        except asyncio.CancelledError:
            pass

    async def _live_target_ids(self) -> set[str]:
        """Return the set of currently-live page target IDs from /json/list."""
        import urllib.request

        try:
            loop = asyncio.get_event_loop()

            def _fetch():
                with urllib.request.urlopen(
                    f"http://localhost:{self.port}/json", timeout=5
                ) as resp:
                    import json as _json

                    targets = _json.loads(resp.read())
                return {t.get("id") for t in targets if t.get("type") == "page"}

            return await loop.run_in_executor(None, _fetch)
        except Exception:
            return set()

    def tab_status(self) -> dict:
        """Snapshot of this driver's tab/session state (R6 observability).

        Surfaced for logging at connect() and available for /health or
        debugging. Includes the registry entry (instance_id, target_id,
        heartbeat age) plus the live driver state (tab_mode, owns_target,
        current conversation).
        """
        status = {
            "tab_mode": self.tab_mode,
            "target_id": self._target_id,
            "owns_target": self._owns_target,
            "instance_id": self.instance_id,
            "conv_id": self._current_conv_id,
        }
        if self._tab_registry:
            status["registry"] = self._tab_registry.status()
        return status

    async def reconnect(self) -> None:
        """Reconnect after a socket drop (#4).

        Re-discovers the page websocket URL (Chrome may have restarted with a
        different one), re-opens the connection, and restarts the background
        reader. Resets stale state (#18): _current_conv_id and _current_model
        are cleared because a socket death almost certainly means the page
        navigated or the tab was closed — the old conversation/model context
        is no longer valid.

        Backoff: 3 attempts at 2s/5s/10s before giving up.
        """
        # Close the old socket FIRST, then reap its pinned reader through the
        # common lifecycle helper.  The old reader loses ownership before any
        # await and cannot fail pending calls on the replacement session.
        await self._stop_cdp_session(fail_pending=True, reset_poison=True)
        # Clear stale state (#18) — the page we reconnect to may be different
        self._current_conv_id = None
        # PR4: capture the pre-reconnect target so we can detect a target change
        # (drift) after a successful reconnect in parallel mode.
        _pre_reconnect_target_id = self._target_id
        self._current_model = None
        # Reconnect with backoff
        for attempt, delay in enumerate([2, 5, 10], 1):
            try:
                ws_url = None
                # Reuse priority mirrors connect(): re-attach to a known
                # _target_id (both modes), then honor tab_mode for the
                # create-vs-adopt decision.
                if self._target_id:
                    ws_url = self._find_owned_tab_ws()
                    if ws_url:
                        logger.info("Re-finding tab: %s", self._target_id)
                if not ws_url and self.tab_mode == "adopt":
                    ws_url = self._adopt_existing_chatgpt_tab()
                if not ws_url:
                    logger.info("No reusable tab — creating new one")
                    try:
                        ws_url = await self._create_owned_tab()
                    except PermissionError:
                        raise
                    except Exception as create_err:
                        if self._parallel_tabs:
                            # Ownership-invariant violation: parallel mode
                            # cannot fall back to a shared tab. Raise inside
                            # the try so the OwnedTabRequiredError escape
                            # (not the broad retry) handles it.
                            raise OwnedTabRequiredError(
                                f"Reconnect owned-tab creation failed in "
                                f"parallel mode; refusing fallback: {create_err}"
                            ) from create_err
                        if self.tab_mode == "owned":
                            # Owned mode: tab creation failed and we must not
                            # fall back to adopting an arbitrary tab. Raise
                            # OwnedTabRequiredError so the reconnect retry
                            # loop doesn't swallow it.
                            raise OwnedTabRequiredError(
                                f"Reconnect owned-tab creation failed and "
                                f"shared-tab fallback is disabled in owned "
                                f"mode: {create_err}"
                            ) from create_err
                        raise
                if not ws_url:
                    if self._parallel_tabs:
                        # Parallel mode: no shared-tab fallback (split-brain guard).
                        raise OwnedTabRequiredError(
                            "Reconnect could not obtain an owned tab; refusing "
                            "shared-tab fallback in parallel mode"
                        )
                    if self.tab_mode == "owned":
                        # Owned mode: never adopt an arbitrary tab on reconnect.
                        # The adopt fallback could steal another process's tab,
                        # causing two drivers to race on the same DOM. Fail
                        # closed — raise OwnedTabRequiredError so the reconnect
                        # retry loop doesn't swallow it (it's in the immediate-
                        # raise list at line 802).
                        raise OwnedTabRequiredError(
                            "Reconnect could not obtain an owned tab and "
                            "shared-tab fallback is disabled in owned mode"
                        )
                    ws_url = await self._find_page_ws()
                connected_ws = await websockets.connect(
                    ws_url,
                    max_size=100 * 1024 * 1024,
                    ping_interval=20,
                    ping_timeout=10,
                )
                self._start_cdp_reader(connected_ws)
                # Same settle wait as connect() — the reconnected tab (re-found
                # or re-created) may have just navigated. See _wait_for_chatgpt_ready.
                await self._wait_for_chatgpt_ready()
                await self._refresh_token()
                logger.info("CDP reconnected on attempt %d", attempt)
                # A2: re-attach the identity listener on the new websocket.
                await self._attach_identity_listener()
                # Success: clear CDP failure history and recover a half-open
                # breaker. Only after refresh_token succeeds — a reconnect that
                # reopens the socket but can't auth isn't a clean recovery.
                if self._breakers:
                    self._breakers.record_success(BreakerKind.CDP_RECONNECT)
                # PR4 drift guard: raise if the owned target changed during
                # reconnect (parallel mode only). See _assert_reconnect_target_stable.
                self._assert_reconnect_target_stable(_pre_reconnect_target_id)
                return
            except (OwnedTabRequiredError, PermissionError):
                # Never let the parallel-mode fail-closed signal be swallowed by
                # the reconnect retry loop / CDPReconnectError wrapping below.
                await self._stop_cdp_session(fail_pending=True, reset_poison=True)
                raise
            except asyncio.CancelledError:
                await self._stop_cdp_session(
                    fail_pending=True, reset_poison=True, timeout=0
                )
                raise
            except Exception as e:
                # Transient WS/auth/CDP errors still retry (parallel mode does
                # NOT change retry policy for same-target reconnect failures —
                # only ownership-invariant violations raise OwnedTabRequiredError
                # inside the try, above).
                logger.warning("Reconnect attempt %d failed: %s", attempt, e)
                await self._stop_cdp_session(fail_pending=True, reset_poison=True)
                if attempt < 3:
                    await asyncio.sleep(delay)
        if self._breakers:
            self._breakers.record_failure(BreakerKind.CDP_RECONNECT)
        raise CDPReconnectError("CDP reconnect failed after 3 attempts")

    async def reconnect_for_send_recovery(self, timeout: float | None = None) -> None:
        """Reattach once to the same authorized target within one budget.

        Unlike general lifecycle reconnect, this cannot create/adopt a tab,
        navigate, reload, launch Chrome, or change browser permissions.
        ``timeout`` is supplied by the transport so discovery, teardown,
        handshake, and same-page sanity checks share the caller's remaining
        command budget.  Direct callers retain the historic 15-second bound.
        """
        recovery_budget = 15.0 if timeout is None else max(0.0, float(timeout))
        target_id = self._target_id
        conv_id = self._current_conv_id
        if not target_id:
            raise OwnedTabRequiredError("Send recovery requires the original target")

        def discover():
            request = urllib.request.Request(f"http://127.0.0.1:{self.port}/json/list")
            with urllib.request.urlopen(request, timeout=5) as response:
                targets = json.loads(response.read())
            for target in targets:
                if target.get("id") != target_id or target.get("type") != "page":
                    continue
                page = urllib.parse.urlparse(target.get("url", ""))
                ws_url = target.get("webSocketDebuggerUrl", "")
                ws = urllib.parse.urlparse(ws_url)
                if (page.scheme != "https" or page.hostname != "chatgpt.com"
                        or ws.scheme != "ws" or ws.hostname not in {"127.0.0.1", "localhost"}
                        or ws.port != self.port or ws.path != f"/devtools/page/{target_id}"):
                    raise OwnedTabRequiredError("Recovery target identity/origin changed")
                return ws_url
            raise OwnedTabRequiredError("Original target unavailable; recovery will not adopt another tab")

        try:
            async with asyncio.timeout(recovery_budget):
                ws_url = await asyncio.to_thread(discover)
                if self._target_id != target_id:
                    raise OwnedTabRequiredError("Recovery target changed during discovery")
                # Mark the poisoned socket stale before close/cancel.  The
                # common helper also cancels pending callers and clears their
                # forensic metadata before a replacement reader starts.
                await self._stop_cdp_session(fail_pending=True, reset_poison=False)
                connected_ws = await websockets.connect(
                    ws_url, max_size=100 * 1024 * 1024,
                    ping_interval=20, ping_timeout=10, open_timeout=5, close_timeout=1,
                )
                self._start_cdp_reader(connected_ws)
                # The transport recovery owner has already passed the poison
                # gate.  Mark this newly attached session healthy before the
                # sanity probe so the probe can use _cdp on the same task;
                # any probe timeout will re-poison it conservatively.
                self._session_poisoned = False
                # Keep the sanity probe inside the same outer timeout.  The
                # transport owner task remains the recovery owner because the
                # transport uses asyncio.timeout rather than wait_for.
                url = await self._js_strict("location.href", timeout=3)
                parsed = urllib.parse.urlparse(url)
                if parsed.scheme != "https" or parsed.hostname != "chatgpt.com":
                    raise OwnedTabRequiredError("Recovery landed outside the authorized origin")
                if conv_id and not self._is_url_at_conversation(url, conv_id):
                    raise OwnedTabRequiredError("Conversation changed during send recovery")
                # Keep model/route state: the same page was reattached, not reset.
                # Re-arm network observation without the general reconnect's
                # token refresh or alternate-target fallbacks.
                if self._identity_listener is not None:
                    self._identity_listener.detach()
                    await self._identity_listener.attach()
        except BaseException:
            # If discovery, handshake, probe, or listener setup fails after a
            # replacement socket was opened, leave no half-live reader behind.
            # Cancellation/pending cleanup is synchronous; websocket close is
            # scheduled without adding another multi-second wait to the
            # already exhausted command budget.
            try:
                await self._stop_cdp_session(
                    fail_pending=True, reset_poison=False, timeout=0
                )
            except BaseException:
                logger.debug("send-recovery cleanup failed", exc_info=True)
            raise

    async def _find_page_ws(self) -> str:
        """Find a suitable page's websocket URL."""
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/json/list")
        with urllib.request.urlopen(req, timeout=5) as resp:
            targets = json.loads(resp.read())

        pages = [t for t in targets if t.get("type") == "page"]
        if not pages:
            raise RuntimeError("No browser pages found — is Chrome running with chatgpt.com?")

        # A fallback still needs the authorized ChatGPT origin. A title or
        # query containing "chatgpt.com" does not make another site eligible.
        chatgpt = [
            t
            for t in pages
            if self._is_chatgpt_url(t.get("url", ""))
        ]
        if not chatgpt:
            raise OwnedTabRequiredError("No page at the authorized ChatGPT origin")
        candidates = chatgpt

        # #16: liveness check — skip targets whose WS URL is unreachable
        # (crashed tab, about:blank after recovery, etc.)
        for target in candidates:
            ws_url = target.get("webSocketDebuggerUrl")
            if not ws_url:
                continue
            try:
                # Quick HTTP check that the page target is alive
                check_url = f"http://127.0.0.1:{self.port}/json"
                with urllib.request.urlopen(
                    urllib.request.Request(check_url), timeout=3
                ) as check_resp:
                    _alive = json.loads(check_resp.read())
                # If we can reach /json and the target has a WS URL, it's alive
                logger.info("Using page: %s", target.get("title", "")[:60])
                return ws_url
            except Exception:
                logger.debug("Target not alive: %s", target.get("title", "")[:40])
                continue
        # Fallback: return the first candidate even if liveness check failed
        target = candidates[0]
        logger.info("Using page (fallback): %s", target.get("title", "")[:60])
        return target["webSocketDebuggerUrl"]

    async def _browser_cdp(self, method: str, params: dict = None, timeout: float = 10) -> dict:
        """Send a browser-domain CDP command via a short-lived browser WS.

        Used for Target.createTarget and Target.closeTarget. Opens a fresh
        connection to the browser-level endpoint (/devtools/browser/...),
        sends one command, awaits the response, closes. Does NOT use the
        page-level _cdp/_reader_loop machinery — those are for the persistent
        page WS only.
        """
        version = json.loads(
            urllib.request.urlopen(
                urllib.request.Request(f"http://127.0.0.1:{self.port}/json/version"),
                timeout=5,
            ).read()
        )
        browser_ws_url = version["webSocketDebuggerUrl"]
        mid = self._msg_id + 100000  # offset to avoid collision with page-level ids
        async with websockets.connect(browser_ws_url, max_size=10 * 1024 * 1024) as bws:
            await bws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                raw = await asyncio.wait_for(
                    bws.recv(), timeout=max(1, deadline - time.monotonic())
                )
                resp = json.loads(raw)
                if resp.get("id") == mid:
                    detail = json.dumps(resp.get("error", {}), ensure_ascii=False)
                    if self._transport._is_permission_detail(detail):
                        raise PermissionError(f"Browser CDP {method}: {detail}")
                    return resp
            raise TimeoutError(f"Browser CDP timeout: {method}")

    async def _create_owned_tab(self, *, scratch: bool = False) -> str:
        """Create a new chatgpt.com tab and return its page WS URL.

        Calls Target.createTarget via the browser WS, stores the targetId,
        then looks up the new tab's webSocketDebuggerUrl via /json/list.
        Returns the page WS URL. Sets self._target_id.

        Conv-affinity: when ``_conv_affinity`` is set the tab is created
        directly AT ``/c/{conv_id}`` and flagged ``_conv_target`` — a
        persistent shared resource: ``_owns_target`` stays False so no
        driver ever closes it, and it is never navigated to a different
        conversation (navigate_conversation switches target instead).
        ``scratch=True`` forces the bare-home owned tab even under affinity —
        used by ensure_scratch_tab when a conv-affine driver must detach
        from its conversation tab.
        """
        if self._conv_affinity and not scratch:
            url = f"https://chatgpt.com/c/{self._conv_affinity}"
        else:
            url = "https://chatgpt.com/"
        # background=True so new tabs never steal window focus — the bridge
        # must not pop the browser to the foreground on every materialization.
        resp = await self._browser_cdp(
            "Target.createTarget", {"url": url, "background": True}
        )
        if "error" in resp:
            raise RuntimeError(f"Target.createTarget failed: {resp['error']}")
        self._target_id = resp.get("result", {}).get("targetId")
        if not self._target_id:
            raise RuntimeError("Target.createTarget returned no targetId")
        if self._conv_affinity and not scratch:
            # Persistent shared conv tab: nobody owns it for close purposes.
            self._owns_target = False
            self._conv_target = True
            self._shared_home_target = False
            logger.info(
                "Created conversation-bound tab for %s: %s",
                self._conv_affinity,
                self._target_id,
            )
        else:
            self._owns_target = True  # we created it → close() will tear it down
            self._conv_target = False
            self._shared_home_target = False
            self._scratch_target_id = self._target_id
            logger.info("Created owned tab: %s", self._target_id)
        # Wait for the tab to appear in /json/list, then get its WS URL
        for _ in range(20):
            targets = json.loads(
                urllib.request.urlopen(
                    urllib.request.Request(f"http://127.0.0.1:{self.port}/json/list"),
                    timeout=5,
                ).read()
            )
            for t in targets:
                if t.get("id") == self._target_id:
                    ws_url = t.get("webSocketDebuggerUrl")
                    if ws_url:
                        logger.info("Owned tab WS: %s", ws_url[:80])
                        return ws_url
            await asyncio.sleep(0.5)
        raise RuntimeError(f"Created tab {self._target_id} but couldn't find its WS URL")

    def _find_owned_tab_ws(self) -> str | None:
        """Look up an owned tab's WS URL from /json/list. Returns None if gone."""
        try:
            targets = json.loads(
                urllib.request.urlopen(
                    urllib.request.Request(f"http://127.0.0.1:{self.port}/json/list"),
                    timeout=5,
                ).read()
            )
            for t in targets:
                if t.get("id") == self._target_id:
                    return t.get("webSocketDebuggerUrl")
        except Exception:
            pass
        return None

    def _adopt_existing_chatgpt_tab(self) -> str | None:
        """Find an existing chatgpt.com tab in /json/list to adopt.

        ``Target.createTarget`` always opens a new tab, but at startup Chrome
        is typically already on chatgpt.com (the launch URL) and/or a prior
        service run left an owned tab behind. Reusing one of those instead of
        creating yet another keeps the tab count stable across restarts.

        Adopts (in priority order):
          1. A tab we previously owned (id == self._target_id).
          2. The first chatgpt.com page target with a live WS URL.

        Returns the WS URL and sets self._target_id / self._owns_target on a
        hit; returns None when no suitable tab exists (caller should create
        one). Never raises — a /json/list failure collapses to None.
        """
        try:
            targets = json.loads(
                urllib.request.urlopen(
                    urllib.request.Request(f"http://127.0.0.1:{self.port}/json/list"),
                    timeout=5,
                ).read()
            )
        except Exception:
            return None

        # 1. A previously-owned tab we can re-attach to.
        if self._target_id:
            for t in targets:
                if t.get("id") == self._target_id:
                    ws_url = t.get("webSocketDebuggerUrl")
                    if ws_url:
                        # Ownership state is preserved — _owns_target unchanged.
                        return ws_url

        # 2. Any existing chatgpt.com page tab. Adopting it flips ownership to
        #    False so close() will NOT close it (it's not ours to close).
        for t in targets:
            if t.get("type") != "page":
                continue
            url = t.get("url", "")
            if not self._is_chatgpt_url(url):
                continue
            ws_url = t.get("webSocketDebuggerUrl")
            if not ws_url:
                continue
            self._target_id = t.get("id")
            self._owns_target = False
            # An adopted bare home tab is the shared workspace; an adopted
            # /c/ tab is conversation-bound but not flagged _conv_target by
            # this legacy path, so it stays non-lockable either way.
            self._shared_home_target = "/c/" not in url
            logger.info(
                "Adopted existing chatgpt.com tab: %s (will not close on shutdown)",
                self._target_id,
            )
            return ws_url

        return None

    def _adopt_bare_home_tab(self) -> str | None:
        """Adopt an existing bare chatgpt.com tab as the shared workspace.

        The non-conv counterpart to ``_adopt_conversation_tab``: several
        drivers may attach to the same home tab — per-target MutationLock
        serializes mutations on it, and read-only backend fetches don't
        contend on DOM state. Only tabs NOT showing a conversation (no
        ``/c/`` in the URL) qualify; conv-bound tabs keep their dedicated
        adoption path.

        Sets ``_owns_target=False`` (never ours to close) and
        ``_shared_home_target=True`` (a lockable shared target — see
        ``has_lockable_target``). Returns the page WS URL, or None when no
        bare home tab exists. Never raises.
        """
        for t in self._list_page_targets():
            url = t.get("url") or ""
            if not self._is_chatgpt_url(url) or "/c/" in url:
                continue
            ws_url = t.get("webSocketDebuggerUrl")
            if not ws_url:
                continue
            self._target_id = t.get("id")
            self._owns_target = False
            self._conv_target = False
            self._shared_home_target = True
            logger.info("Adopted shared home tab: %s", self._target_id)
            return ws_url
        return None

    # ── Conversation-affine tabs ──────────────────────────────
    #
    # Invariant: a page tab's URL is its conversation identity. A tab showing
    # /c/{conv_id} belongs to that conversation — it is a shared cross-process
    # resource: any driver may attach to it (per-target MutationLock
    # serializes mutations), no driver closes it, and it is never navigated
    # to a different conversation. To leave a conv-bound tab, drivers switch
    # target instead (ensure_scratch_tab / adopt_conversation_tab).

    def _list_page_targets(self) -> list[dict]:
        """All live CDP page targets (best-effort; [] on any failure)."""
        try:
            targets = json.loads(
                urllib.request.urlopen(
                    urllib.request.Request(f"http://127.0.0.1:{self.port}/json/list"),
                    timeout=5,
                ).read()
            )
        except Exception:
            return []
        return [t for t in targets if t.get("type") == "page"]

    def _adopt_conversation_tab(self, conv_id: str) -> str | None:
        """Find the tab already showing /c/{conv_id}; return its WS URL.

        Shared adoption: sets _owns_target=False (never closed by us) and
        _conv_target=True (persistent conv-bound tab — never navigate it
        elsewhere). No-op sets nothing when absent. Never raises.
        """
        for t in self._list_page_targets():
            url = t.get("url", "")
            if not self._is_url_at_conversation(url, conv_id):
                continue
            ws_url = t.get("webSocketDebuggerUrl")
            if not ws_url:
                continue
            self._target_id = t.get("id")
            self._owns_target = False
            self._conv_target = True
            self._shared_home_target = False
            logger.info(
                "Adopted conversation-bound tab for %s: %s",
                conv_id,
                self._target_id,
            )
            return ws_url
        return None

    async def adopt_conversation_tab(self, conv_id: str) -> bool:
        """Attach this driver to the conversation's own tab, if one exists.

        True when afterwards this driver's target IS a tab showing
        /c/{conv_id} (whether it already was, or we just adopted it). False
        when no such tab exists — the caller should navigate/create instead.

        Retargeting re-runs connect(): it closes the current page WS/reader
        and attaches to the conv tab's WS (registry/heartbeat/token/send-ready
        all re-established for the new target).
        """
        # Already bound to this conversation's tab?
        if self._conv_target and self._current_conv_id == conv_id and self._target_id:
            if self._find_owned_tab_ws():
                return True
        # Scan for a tab already showing the conversation (may be OUR OWN
        # current tab — e.g. a conv-affinity driver created at /c/{id} before
        # _current_conv_id was set; adopting ourselves just sets the flags).
        found_id = None
        for t in self._list_page_targets():
            if self._is_url_at_conversation(t.get("url") or "", conv_id):
                found_id = t.get("id")
                break
        if not found_id:
            return False
        if found_id == self._target_id:
            # We're already attached to the right tab — just record binding.
            self._conv_target = True
            self._shared_home_target = False
            self._current_conv_id = conv_id
            return True
        self._target_id = found_id
        self._owns_target = False
        self._conv_target = True
        self._shared_home_target = False
        await self.connect()
        self._current_conv_id = conv_id
        return True

    async def _create_conv_tab(self, conv_id: str) -> None:
        """Create a NEW persistent tab at /c/{conv_id} and attach to it."""
        resp = await self._browser_cdp(
            "Target.createTarget",
            {"url": f"https://chatgpt.com/c/{conv_id}", "background": True},
        )
        if "error" in resp:
            raise RuntimeError(f"Target.createTarget failed: {resp['error']}")
        target_id = resp.get("result", {}).get("targetId")
        if not target_id:
            raise RuntimeError("Target.createTarget returned no targetId")
        self._target_id = target_id
        self._owns_target = False
        self._conv_target = True
        self._shared_home_target = False
        logger.info("Created conversation-bound tab for %s: %s", conv_id, target_id)
        # Re-attach to the new target (connect resolves _target_id first).
        await self.connect()
        # Wait until the conversation page is actually usable.
        await self._wait_for_chatgpt_ready()
        try:
            await self._ensure_send_ready()
        except PermissionError:
            raise
        except Exception as e:
            logger.warning("conv tab %s send-readiness failed: %s", conv_id, e)
        self._current_conv_id = conv_id

    async def ensure_scratch_tab(self) -> None:
        """Move this driver OFF a conv-bound tab onto a scratch/home tab.

        Conv-bound tabs are shared persistent resources — a driver must not
        navigate one away from its conversation. Called by the fresh-chat /
        new-chat paths when the current target is conv-bound.
        """
        if not self._conv_target:
            return
        # Prefer our own scratch tab if it is still alive.
        if self._scratch_target_id:
            for t in self._list_page_targets():
                if t.get("id") == self._scratch_target_id:
                    self._target_id = self._scratch_target_id
                    self._owns_target = True
                    self._conv_target = False
                    self._shared_home_target = False
                    self._current_conv_id = None
                    await self.connect()
                    return
            self._scratch_target_id = None
        # Adopt an existing bare chatgpt.com home tab (not conv-bound).
        for t in self._list_page_targets():
            url = t.get("url") or ""
            if "chatgpt.com" in url and "/c/" not in url:
                self._target_id = t.get("id")
                self._owns_target = False
                self._conv_target = False
                self._shared_home_target = True
                self._current_conv_id = None
                await self.connect()
                return
        # None exists: create our own scratch tab. A conv-affine driver must
        # NOT bootstrap through a bare connect() — its _conv_affinity would
        # re-adopt the conversation tab we are trying to leave (or create the
        # "scratch" tab AT /c/{affinity}), re-binding us to the conv we meant
        # to detach from. Create the tab with scratch=True, then connect()
        # attaches to it via the _target_id reuse branch.
        self._target_id = None
        self._owns_target = False
        self._conv_target = False
        self._shared_home_target = False
        self._current_conv_id = None
        if self._conv_affinity:
            await self._create_owned_tab(scratch=True)
        await self.connect()

    async def ensure_conversation_tab(self, conv_id: str) -> None:
        """Guarantee this driver is attached to a tab showing /c/{conv_id}.

        Order: already there → adopt existing tab → create a new tab at the
        conversation URL. Never navigates a conv-bound tab off its own
        conversation.
        """
        if await self.adopt_conversation_tab(conv_id):
            return
        await self._create_conv_tab(conv_id)

    async def _wait_for_chatgpt_ready(self) -> bool:
        """Wait for the connected tab to actually be on chatgpt.com.

        ``connect``/``reconnect`` grab a page websocket whose target exists
        milliseconds after ``Target.createTarget`` — before the page has
        navigated to chatgpt.com. A relative ``fetch('/api/auth/session')``
        fired against that cold tab resolves against the wrong origin (e.g.
        ``about:blank``) and returns an empty accessToken, tripping the auth
        gate and killing the MCP process on startup.

        Polls until ``location.href`` is on chatgpt.com AND ``readyState`` is
        past 'loading'. The token fetch only needs the page to be on the right
        origin with cookies attached — the full SPA (#prompt-textarea) is not
        required, so this is lighter than the ``navigate_*`` readiness checks.

        Mirrors ``_wait_for_login`` (conftest.py): uses the soft ``_js``
        evaluator so a transient CDP error collapses to '' instead of aborting,
        and never raises — a False return falls through to ``_refresh_token``,
        whose own retry loop is the safety net.

        Returns True if ready within the deadline, False on timeout.
        """
        deadline = time.monotonic() + _CONNECT_READY_TIMEOUT
        while time.monotonic() < deadline:
            try:
                raw = await self._js(
                    "(function(){"
                    "  return JSON.stringify({"
                    "    href: location.href,"
                    "    ready: document.readyState"
                    "  });"
                    "})()"
                )
                state = json.loads(raw) if raw else {}
                if "chatgpt.com" in (state.get("href") or "") and state.get("ready") != "loading":
                    return True
            except (ValueError, TypeError):
                pass
            await asyncio.sleep(0.5)
        logger.warning(
            "Owned tab did not report chatgpt.com ready within %ds — "
            "proceeding (token refresh will retry)",
            _CONNECT_READY_TIMEOUT,
        )
        return False

    async def _refresh_token(self) -> None:
        """Get a fresh access token from /api/auth/session, with retry.

        Delegated to BackendClient (Phase 5 PR1 extraction). Kept as a thin
        delegator so callers, reconnect/connect paths, and test stubs that
        patch ``driver._refresh_token`` keep working unchanged.
        """
        await self._backend_client._refresh_token()

    # ── CDP primitives ────────────────────────────────────────

    async def _reader_loop(self, ws=None) -> None:
        """Background reader: sole consumer of self._ws.recv().

        Delegated to CDPTransport (Phase 5 PR2 extraction). Preserved exactly:
        sole ``_ws.recv()`` consumer, routes responses to ``_pending`` by id,
        fails all pending futures on socket close.
        """
        await self._transport._reader_loop(ws)

    async def _cdp(
        self, method: str, params: dict = None, timeout: float = 15, _retry: bool = True
    ) -> dict:
        """Send a CDP command and await its response.

        Delegated to CDPTransport (Phase 5 PR2 extraction). Preserved exactly:
        id-keyed future routing, one reconnect-and-retry through
        ``self.reconnect()`` on socket death (Layer-2 breaker semantics stay
        there), ``_retry`` recursion guard.
        """
        return await self._transport._cdp(method, params, timeout, _retry)

    @staticmethod
    def _should_reconnect(exc: Exception) -> bool:
        """True for socket-death signatures; False otherwise.

        Delegated to CDPTransport (Phase 5 PR2 extraction). Pure classifier,
        no state."""
        from .cdp_transport import CDPTransport

        return CDPTransport._should_reconnect(exc)

    async def _js(self, expr: str, timeout: float = 15) -> str:
        """Soft ``Runtime.evaluate`` — returns "" on failure.

        Delegated to CDPTransport (Phase 5 PR2 extraction)."""
        return await self._transport._js(expr, timeout)

    async def _js_with_data(self, expr_template: str, data: dict, timeout: float = 15) -> str:
        """Evaluate JS with safely injected ``__D`` data variables (soft).

        Delegated to CDPTransport (Phase 5 PR2 extraction)."""
        return await self._transport._js_with_data(expr_template, data, timeout)

    async def _js_strict(self, expr: str, timeout: float = 15) -> str:
        """Strict ``Runtime.evaluate`` — raises CDPJSError on failure.

        Delegated to CDPTransport (Phase 5 PR2 extraction)."""
        return await self._transport._js_strict(expr, timeout)

    async def _js_with_data_strict(
        self, expr_template: str, data: dict, timeout: float = 15
    ) -> str:
        """Strict variant of _js_with_data — raises CDPJSError on failure.

        Delegated to CDPTransport (Phase 5 PR2 extraction)."""
        return await self._transport._js_with_data_strict(expr_template, data, timeout)

    # ── Model Selection ───────────────────────────────────────

    async def select_model(self, slug: str) -> bool:
        """Select a model in the ChatGPT model picker.

        Clicks the model picker button, waits for the dropdown,
        finds the item matching *slug*, and clicks it.

        Returns True if the model was selected, False if it failed
        (e.g. model not found, picker not available).  The active-model
        bookkeeping is updated only after the picker confirms the click; a
        failed selection must never masquerade as a successful request.
        """
        if slug in ("auto", None, ""):
            return True  # auto is the default, no action needed

        # Click the model picker button
        picker_clicked = await self._js(
            "(function() {"
            "  var btn = document.querySelector('#model-selector-btn') "
            "    || document.querySelector('button[aria-label*=\"Model\"]') "
            "    || document.querySelector('[data-testid*=\"model\"]') "
            "    || document.querySelector('button[class*=\"model\"]');"
            "  if (!btn) return 'no picker';"
            "  btn.click();"
            "  return 'clicked';"
            "})()"
        )
        if picker_clicked != "clicked":
            logger.warning(
                "Model picker not found: %s — refusing requested model", picker_clicked
            )
            return False

        # Wait for dropdown to appear
        await asyncio.sleep(0.8)

        # Find and click the target model item
        # The dropdown renders model items as buttons or list items with the slug
        result = await self._js_with_data(
            "(function() {"
            "  function norm(value) {"
            "    return String(value || '').toLowerCase().trim()"
            "      .replace(/[^a-z0-9]+/g, '-')"
            "      .replace(/^-+|-+$/g, '');"
            "  }"
            "  function isDisabled(el) {"
            "    return !!el.disabled"
            "      || el.getAttribute('disabled') !== null"
            "      || (el.getAttribute('aria-disabled') || '').toLowerCase() === 'true'"
            "      || (el.getAttribute('data-disabled') || '').toLowerCase() === 'true';"
            "  }"
            "  function matches(el) {"
            "    if (isDisabled(el)) return false;"
            "    var target = norm(__D.slug);"
            "    var attrs = ['data-slug', 'data-model-slug', 'data-value', 'value'];"
            "    for (var i = 0; i < attrs.length; i++) {"
            "      if (norm(el.getAttribute(attrs[i])) === target) return true;"
            "    }"
            "    var labels = [el.getAttribute('aria-label'),"
            "      el.getAttribute('title'), el.textContent];"
            "    for (var j = 0; j < labels.length; j++) {"
            "      if (norm(labels[j]) === target) return true;"
            "    }"
            "    return false;"
            "  }"
            "  var items = document.querySelectorAll("
            '    \'button[data-testid*="model"], '
            '    \'[class*="model-item"], '
            '    \'[class*="modelOption"], '
            '    \'li[class*="model"], '
            "    'div[class*=\"model\"] button'"
            "  );"
            "  for (var i = 0; i < items.length; i++) {"
            "    var el = items[i];"
            "    if (matches(el)) {"
            "      el.click();"
            "      return 'selected';"
            "    }"
            "  }"
            "  // Fallback: try broader search in the dropdown"
            "  var allBtns = document.querySelectorAll('button, [role=\"menuitem\"]');"
            "  for (var j = 0; j < allBtns.length; j++) {"
            "    if (matches(allBtns[j])) {"
            "      allBtns[j].click();"
            "      return 'selected-fallback';"
            "    }"
            "  }"
            "  return 'not-found';"
            "})()",
            {"slug": slug.lower()},
        )

        if result in ("selected", "selected-fallback"):
            logger.info("Model selected: %s (%s)", slug, result)
            # Do not set this optimistically before the UI operation succeeds:
            # callers use the field for diagnostics and model-aware budgets.
            self._current_model = slug
            await asyncio.sleep(0.5)  # Let UI settle
            return True

        # #8: Close the dropdown if model wasn't found, so it doesn't
        # overlay the textarea and corrupt subsequent type/send operations.
        if result == "not-found":
            try:
                await self._js_strict("document.body.click()")  # dismiss dropdown
            except Exception:
                pass  # best-effort
        logger.warning(
            "Model '%s' not found in picker: %s — refusing requested model", slug, result
        )
        return False

    # ── Navigation ────────────────────────────────────────────

    async def navigate_new_chat(self, gizmo_id: str = None) -> None:
        """Navigate only after preserving drafts/generation; report the failed stage."""
        from .navigation import navigate_new_chat

        await navigate_new_chat(self, gizmo_id)

    async def _has_composer(self) -> bool:
        """Is a send-capable composer present on the live tab?

        Delegated to ChatGPTDom (Phase 5 PR3 extraction)."""
        return await self._dom._has_composer()

    async def _ensure_send_ready(self) -> None:
        """Guarantee the live tab can accept a typed message.

        Delegated to ChatGPTDom (Phase 5 PR3 extraction). Preserved exactly:
        poll-then-navigate-via-``navigate_new_chat``, COMPOSER_SEND_READINESS
        breaker record_failure on persistent failure (registry stays on driver).
        """
        await self._dom._ensure_send_ready()

    async def _wait_for_composer(self, timeout: float = 8) -> bool:
        """Poll until a composer appears, or *timeout* seconds elapse.

        Delegated to ChatGPTDom (Phase 5 PR3 extraction)."""
        return await self._dom._wait_for_composer(timeout)

    async def navigate_conversation(self, conversation_id: str) -> None:
        """Navigate to an existing conversation for multi-turn.

        Sets ``self._current_conv_id`` ONLY after the live tab is verified
        to be at ``/c/{conversation_id}`` with the composer ready. On a
        verified failure (wrong landing URL, or readiness never observed)
        clears any stale ``_current_conv_id`` matching the request and
        raises — never admits an unverified conversation as current. This
        is the invariant the auto-continue paths depend on: ``_current_conv_id``
        means "the live tab is here", not "we attempted to go here".

        P2 (2026-07-09): the readiness poll is now staged — it probes
        url → document.readyState → app shell → composer in one JS call
        and captures which stage failed. The error message names the stage
        instead of the old opaque "did not reach a ready composer." Also
        fast-fails with ``nav_displaced`` if the URL moves away from the
        target mid-poll (detects SPA redirects / access-denied states).
        """
        # Conv-affinity: a conv-bound tab belongs to its conversation. If this
        # driver is on conv B's tab but asked for conv A, switch TARGET to A's
        # tab (adopt-or-create) rather than navigating B's tab away.
        if (
            self._conv_target
            and self._current_conv_id is not None
            and self._current_conv_id != conversation_id
        ):
            await self.ensure_conversation_tab(conversation_id)
            return
        if self._conv_target and self._current_conv_id == conversation_id:
            return  # already on this conversation's tab
        if (
            self._conv_target
            and self._conv_affinity == conversation_id
            and self._current_conv_id is None
        ):
            # Conv-affinity driver created its tab AT this conversation's URL
            # but _current_conv_id was never recorded — the tab is already
            # where it belongs; just verify readiness, skip the reload.
            try:
                await self._wait_for_chatgpt_ready()
                await self._ensure_send_ready()
                self._current_conv_id = conversation_id
                return
            except Exception as exc:
                from .send_recovery import is_recoverable_transport_error

                if isinstance(exc, PermissionError) or is_recoverable_transport_error(exc):
                    raise
                # Other readiness failures retain the existing navigation path.
        url = f"https://chatgpt.com/c/{conversation_id}"
        logger.info("Navigate to conversation: %s", url)
        await self._cdp("Page.navigate", {"url": url})
        await asyncio.sleep(3)

        # P2: staged readiness probe. Evaluates all stages in one JS call
        # (no extra round-trips). Uses _js_strict so transient JS failures
        # are visible (logged) rather than silently burning poll iterations.
        probe_js = (
            "(function() {"
            "  return JSON.stringify({"
            "    url: location.href,"
            "    ready_state: document.readyState,"
            f"    app_shell: !!document.querySelector('nav') || !!document.querySelector('[class*=\"sidebar\"]'),"
            f"    composer: !!document.querySelector('{COMPOSER_SELECTOR}') || !!document.querySelector('{COMPOSER_FALLBACK_SELECTOR}')"
            "  });"
            "})()"
        )

        last_probe: NavigationReadinessProbe | None = None
        last_js_error: str | None = None
        url_was_correct = False  # track if URL was ever correct (for displacement)
        displacement_count = 0  # P2 review: debounce — require 2 consecutive wrong polls

        for _ in range(30):
            try:
                result = await self._js_strict(probe_js)
                data = json.loads(result)
                last_js_error = None  # successful probe clears the error
            except Exception as e:
                # P2: log transient JS failures instead of silently swallowing.
                from .send_recovery import is_recoverable_transport_error

                if isinstance(e, PermissionError) or is_recoverable_transport_error(e):
                    raise
                # Distinguish "probe execution failed" from "stage failed" per
                # ChatGPT review finding C.
                last_js_error = str(e)
                logger.debug("Navigation probe JS failed (will retry): %s", e)
                await asyncio.sleep(0.5)
                continue

            probe = NavigationReadinessProbe(
                url=data.get("url", ""),
                ready_state=data.get("ready_state", ""),
                app_shell_present=bool(data.get("app_shell")),
                composer_present=bool(data.get("composer")),
            )
            last_probe = probe
            url_correct = self._is_url_at_conversation(probe.url, conversation_id)

            # P2: fast-fail on URL displacement with debounce (review finding B).
            # If the URL was correct on a prior poll but is now wrong, the page
            # may have navigated away (SPA redirect, access denied, conversation
            # deleted). Require 2 CONSECUTIVE wrong-URL polls to avoid
            # false-positive on SPA route normalization / param stripping.
            if url_correct:
                url_was_correct = True
                displacement_count = 0
            elif url_was_correct:
                displacement_count += 1
                if displacement_count >= 2:
                    if self._current_conv_id == conversation_id:
                        self._current_conv_id = None
                    raise RuntimeError(
                        f"Navigation to {conversation_id} displaced — URL moved "
                        f"to {probe.url[:80]} after initially loading (nav_displaced)"
                    )

            if probe.is_ready(url_correct):
                logger.info("Conversation ready: %s", probe.url)
                break
            await asyncio.sleep(0.5)
        else:
            # Loop exhausted without a verified landing. Clear any stale
            # state and raise with P2 staged diagnostics.
            if self._current_conv_id == conversation_id:
                self._current_conv_id = None
            if last_probe is not None:
                url_correct = self._is_url_at_conversation(last_probe.url, conversation_id)
                stage = last_probe.diagnostic_summary(url_correct)
                raise RuntimeError(
                    f"Navigation to {conversation_id} failed after 15s — "
                    f"stage: {stage}"
                )
            raise RuntimeError(
                f"Navigation to {conversation_id} failed — all probes errored "
                f"(no readiness data obtained, last_js_error={last_js_error})"
            )

        await asyncio.sleep(1)
        # A shared home tab we just navigated into /c/{id} becomes that
        # conversation's tab — flag it conv-bound so a later new-chat request
        # switches to a scratch surface instead of navigating it away from
        # under other drivers sharing it.
        if self._shared_home_target:
            self._shared_home_target = False
            self._conv_target = True
        self._current_conv_id = conversation_id

    @staticmethod
    def _is_chatgpt_url(url: str) -> bool:
        try:
            parsed = urllib.parse.urlparse(url)
            return parsed.scheme == "https" and parsed.hostname == "chatgpt.com"
        except ValueError:
            return False

    @staticmethod
    def _is_url_at_conversation(url: str, conversation_id: str) -> bool:
        """Exact path-segment match: is *url* at ``/c/{conversation_id}``?

        Handles both non-project URLs (``/c/{id}``) and project-scoped URLs
        (``/g/{gizmo_id}/c/{id}``). Finds the ``c`` path segment and checks
        if the segment immediately after it matches the conversation ID.
        Query strings and trailing slashes are tolerated; a different
        conversation id or a non-conversation URL returns False.
        """
        if not url or not conversation_id:
            return False
        try:
            parsed = urllib.parse.urlparse(url)
        except ValueError:
            return False
        if parsed.scheme != "https" or parsed.hostname != "chatgpt.com":
            return False
        parts = [p for p in parsed.path.split("/") if p]
        # Find the ("c", conversation_id) adjacent pair — the conversation
        # route marker in both non-project (["c", "{id}"]) and project-scoped
        # (["g", "{gizmo}", "c", "{id}"]) URL shapes. Using the adjacent pair
        # (rather than just finding the first "c") avoids false-positives if
        # a "c" segment appears earlier in a different context.
        return any(
            parts[i] == "c" and parts[i + 1] == conversation_id
            for i in range(len(parts) - 1)
        )

    async def _is_live_conversation_url(self, conversation_id: str) -> bool:
        """Read ``location.href`` and check it is at *conversation_id*.

        Returns False on any read/parse failure rather than raising — callers
        that need fail-closed behavior use ``ensure_current_conversation``,
        which turns an unreadable URL into a navigation attempt.
        """
        try:
            url = await self._js_strict("location.href")
        except CDPJSError:
            return False
        return self._is_url_at_conversation(url or "", conversation_id)

    async def ensure_current_conversation(self, conversation_id: str) -> None:
        """Guarantee the live tab is at *conversation_id* before sending.

        If the live URL already matches, returns without navigating. Otherwise
        navigates and verifies the landing. Raises if the tab cannot be brought
        to the requested conversation — fail-closed, never silently proceeding
        into an unknown tab state. ``_current_conv_id`` is only set on success
        (by ``navigate_conversation``); on failure it is cleared if it matched.
        """
        if await self._is_live_conversation_url(conversation_id):
            return
        await self.navigate_conversation(conversation_id)
        # navigate_conversation raises on failure, so reaching here means it
        # verified the landing. Belt-and-braces: re-check before returning.
        if not await self._is_live_conversation_url(conversation_id):
            if self._current_conv_id == conversation_id:
                self._current_conv_id = None
            raise RuntimeError(f"Failed to restore conversation context: {conversation_id}")

    async def route_chat_target(
        self,
        *,
        conversation_id: str | None,
        project_id: str | None = None,
        auto_continue: bool = False,
    ) -> str:
        """Route this driver's live tab to where the request must be sent.

        ``conversation_id`` is the request's explicit target and ALWAYS wins:
        the conversation already lives inside its project/system context, so
        an explicit id continues it — ``project_id`` is never consulted (it
        only scopes NEW conversations). Both MCP and REST call this one
        function so the rule cannot drift.

        Context: the 2026-09-17 misroute — conv-affine tabs preset
        ``_current_conv_id``, which skipped the old "navigate if different"
        branch, while a non-empty ``project_id`` vetoed auto-continue; the
        request fell through to ``navigate_new_chat`` and sent the message
        into a brand-new conversation.

        ``auto_continue`` lets each transport apply its own "same context as
        last turn" heuristic for the no-explicit-id case. Returns the route
        taken: ``"explicit"``, ``"auto-continue"`` or ``"new"``.
        """
        if conversation_id:
            # ensure_current_conversation verifies the LIVE url even when
            # _current_conv_id already matches — a conv-affine tab may have
            # been redirected since adoption.
            await self.ensure_current_conversation(conversation_id)
            return "explicit"
        if auto_continue and self._current_conv_id:
            await self.ensure_current_conversation(self._current_conv_id)
            return "auto-continue"
        await self.navigate_new_chat(gizmo_id=project_id)
        return "new"

    # ── Message Input ─────────────────────────────────────────

    async def type_message(self, text: str) -> None:
        """Type text into the ChatGPT composer.

        Delegated to ChatGPTDom (Phase 5 PR3 extraction). Preserved exactly:
        focus → platform-aware select-all → paste-event insert → canonical
        verify with one retry; COMPOSER_SEND_READINESS breaker record_failure
        on persistent failure (registry stays on driver).
        """
        await self._dom.type_message(text)

    async def _detect_select_all_modifier(self) -> int:
        """Return the CDP modifiers value for select-all on the live platform.

        Delegated to ChatGPTDom (Phase 5 PR3 extraction)."""
        return await self._dom._detect_select_all_modifier()

    async def _verify_composer_text(self, selector: str, expected: str) -> bool:
        """Canonical-equality check: does the composer hold *expected*?

        Delegated to ChatGPTDom (Phase 5 PR3 extraction)."""
        return await self._dom._verify_composer_text(selector, expected)

    async def click_send(self) -> None:
        """Click the send button via JS MouseEvent sequence.

        Delegated to ChatGPTDom (Phase 5 PR3 extraction). Preserved exactly:
        aria-label-then-legacy selector, COMPOSER_SEND_READINESS breaker
        record_failure on miss / record_success on confirmed send (registry
        stays on driver)."""
        await self._dom.click_send()

    async def _clear_composer(self, selector: str | None = None) -> bool:
        """Best-effort composer clear — never raises.

        Delegated to ChatGPTDom (Phase 5 PR3 extraction). Used on send-failure
        paths so a half-inserted draft cannot poison the next send's verify.
        """
        return await self._dom._clear_composer(selector)

    # ── Response Retrieval ────────────────────────────────────

    async def _read_assistant_count_baseline(self) -> int:
        """Read the pre-send assistant-message count with bounded retry + fail-closed.

        This baseline is the completion detector's reference point: Phase-1
        waits for ``current_count > initial_count``. If this returns 0 on a
        conversation that already has assistant messages, the detector
        immediately treats a pre-existing assistant node as "new" and returns
        the previous turn's text (stale-return).

        The old code fell back to ``initial_count = 0`` on any JS failure —
        the dominant root cause of stale-return during the parallel-tabs
        operational validation. This helper retries, logs structured
        diagnostics, and raises if it cannot establish a trusted baseline.
        """
        import time as _time

        selector = (
            "document.querySelectorAll("
            "'[data-message-author-role=\"assistant\"]'"
            ").length"
        )
        user_selector = (
            "document.querySelectorAll("
            "'[data-message-author-role=\"user\"]'"
            ").length"
        )
        max_attempts = 3
        for attempt in range(1, max_attempts + 1):
            t0 = _time.monotonic()
            err: Exception | None = None
            try:
                raw = await self._js_strict(selector)
            except CDPJSError as e:
                err = e
            else:
                try:
                    # Explicit parse — do NOT use truthiness (numeric 0 from
                    # CDP is falsy but valid for a fresh chat). ChatGPT's
                    # review caught that `raw and int(raw)` rejects numeric 0.
                    count = int(raw)
                except (ValueError, TypeError) as e:
                    err = e
                else:
                    if count < 0:
                        err = ValueError(f"negative assistant count: {count}")

            # If we got a valid count, log + return.
            if err is None:
                elapsed_ms = int((_time.monotonic() - t0) * 1000)
                # Best-effort user-count for diagnostics (non-fatal).
                try:
                    user_raw = await self._js_strict(user_selector)
                    user_count = int(user_raw)
                except (CDPJSError, ValueError, TypeError):
                    user_count = None
                logger.info(
                    "send_baseline: attempt=%d assistant_count=%d "
                    "user_count=%s elapsed_ms=%d conv_id=%s",
                    attempt,
                    count,
                    user_count,
                    elapsed_ms,
                    self._current_conv_id or "(none)",
                )
                # Store for send-acknowledgment baseline (ChatGPT review A).
                self._pre_send_user_count = user_count
                return count

            # Retry or fail-closed.
            if attempt < max_attempts:
                logger.warning(
                    "send_baseline_failed: attempt=%d error=%s "
                    "conv_id=%s — retrying",
                    attempt,
                    err,
                    self._current_conv_id or "(none)",
                )
                await asyncio.sleep(0.3 * attempt)
            else:
                logger.error(
                    "send_baseline_unavailable: attempts=%d last_error=%s "
                    "conv_id=%s — refusing to send with untrusted baseline "
                    "(stale-return risk)",
                    attempt,
                    err,
                    self._current_conv_id or "(none)",
                )
                raise SendReadinessError(
                    f"Cannot establish pre-send assistant-count baseline "
                    f"after {max_attempts} attempts: {err}. Refusing to send "
                    f"with an untrusted baseline (would risk stale-return)."
                ) from err
        # Unreachable (the loop either returns or raises).
        raise SendReadinessError("send_baseline: exhausted retries unexpectedly")

    async def _verify_send_acknowledged(self) -> bool | None:
        """P0 send acknowledgment (ChatGPT review, conv 6a52f0f3).

        After click_send dispatches synthetic mouse events, verify the message
        was actually accepted by React — not just that the JS event loop ran.

        Composite condition: user-message count increased AND composer cleared.
        Uses the pre-send user count baseline (self._pre_send_user_count) to
        detect the delta, not just "userCount > 0" (which is always true on
        existing conversations).

        Tri-state return:
          - True: acknowledged (count increased AND composer cleared)
          - False: conclusively NOT acknowledged (valid probes showed no delta)
          - None: probe inconclusive (CDP errors, no valid probe obtained,
            missing composer, or no pre-send baseline) — non-blocking

        Polls briefly (3s at 0.5s intervals). Never raises.
        """
        import time as _time
        from .chatgpt_dom import COMPOSER_SELECTOR, COMPOSER_FALLBACK_SELECTOR

        pre_send_count = getattr(self, "_pre_send_user_count", None)
        if pre_send_count is None:
            # No baseline — can't verify a delta. Non-blocking.
            return None

        deadline = _time.monotonic() + 3.0
        valid_probe_seen = False
        while _time.monotonic() < deadline:
            try:
                result = await self._js_strict(
                    "(function() {"
                    "  var userMsgs = document.querySelectorAll("
                    "    '[data-message-author-role=\"user\"]').length;"
                    f"  var composer = document.querySelector('{COMPOSER_SELECTOR}')"
                    f"       || document.querySelector('{COMPOSER_FALLBACK_SELECTOR}');"
                    "  var composerPresent = !!composer;"
                    "  var composerEmpty = composer ? !(composer.innerText || composer.value || '').trim() : false;"
                    "  return JSON.stringify({userCount: userMsgs, composerPresent: composerPresent, composerEmpty: composerEmpty});"
                    "})()"
                )
                if not result or not result.strip().startswith("{"):
                    return None  # inconclusive — not a JSON object
                state = json.loads(result)
                if not isinstance(state, dict) or "userCount" not in state:
                    return None  # inconclusive — unexpected shape
                # Missing composer (composerPresent=False) is inconclusive —
                # could be navigation, selector drift, wrong page. Don't count
                # it as a valid probe; continue polling. (ChatGPT review C.)
                if not state.get("composerPresent"):
                    continue  # wait for next poll — might be transient
                # Only count as a valid probe when the composer is present
                # and we can actually evaluate the acknowledgment condition.
                valid_probe_seen = True
                current_count = state.get("userCount", 0)
                if current_count > pre_send_count and state.get("composerEmpty"):
                    return True
            except Exception as exc:
                from .send_recovery import is_recoverable_transport_error

                if isinstance(exc, PermissionError) or is_recoverable_transport_error(exc):
                    raise
            await asyncio.sleep(0.5)
        # If we got valid probes but none showed acknowledgment, return False.
        # If no valid probe was ever obtained (all CDP errors), return None.
        return False if valid_probe_seen else None

    async def _capture_pre_send_fallback_anchor(self, text: str):
        """A2: build the pre-send fallback TurnAnchor (NO captured UUID yet).

        Called between the baseline count and ``type_message``. The UUID is
        populated AFTER ``click_send`` via ``anchor.with_captured_id(uuid)``.

        Modes:
          - ``fresh_chat``: ``_current_conv_id`` is None (new chat). Text-only
            anchor; correlation by sent_text after conv_id resolves.
          - ``existing_conversation``: ``_current_conv_id`` set AND backend
            anchor fetch succeeds. Records latest user/assistant node-id/time.
          - ``degraded_existing``: ``_current_conv_id`` set but backend anchor
            fetch failed (transient). Falls back to sent_text + wall-clock
            freshness. Auth failure propagates hard (never degrades).

        The wall-clock (``pre_send_wall_time``) is always captured, even in
        ``existing_conversation`` mode, so the degraded freshness floor is
        available if the backend anchor later proves wrong.
        """
        import time as _time

        from .turn_anchor import TurnAnchor

        pre_send_wall = _time.time()
        conv_id = self._current_conv_id

        if conv_id is None:
            # Fresh chat — no backend anchor possible until URL resolves.
            return TurnAnchor(
                sent_text=text, mode="fresh_chat",
                pre_send_wall_time=pre_send_wall,
                conversation_id_at_capture=None,
            )

        # Existing conversation — fetch the pre-send backend mapping for anchor.
        try:
            mapping = await self._backend_client._fetch_recent_conversation_projection(conv_id)
            nodes = mapping.get("nodes") or {}
            # Find latest user + assistant nodes by create_time.
            latest_user_id, latest_user_ct = None, None
            latest_asst_id, latest_asst_ct = None, None
            for _nid, node in nodes.items():
                role = node.get("role") or ""
                ct = float(node.get("create_time") or 0)
                if role == "user" and (latest_user_ct is None or ct > latest_user_ct):
                    latest_user_id = node.get("id") or _nid
                    latest_user_ct = ct
                elif role == "assistant" and (latest_asst_ct is None or ct > latest_asst_ct):
                    latest_asst_id = node.get("id") or _nid
                    latest_asst_ct = ct
            return TurnAnchor(
                sent_text=text, mode="existing_conversation",
                latest_user_node_id=latest_user_id,
                latest_user_create_time=latest_user_ct,
                latest_assistant_node_id=latest_asst_id,
                latest_assistant_create_time=latest_asst_ct,
                pre_send_wall_time=pre_send_wall,
                conversation_id_at_capture=conv_id,
            )
        except Exception as e:
            # Transient backend failure — degrade to wall-clock freshness.
            # AuthExpiredError propagates (caller's responsibility).
            from .cdp_driver import AuthExpiredError
            from .send_recovery import is_recoverable_transport_error

            if isinstance(e, (AuthExpiredError, PermissionError)) or is_recoverable_transport_error(e):
                raise
            logger.warning(
                "turn_anchor_degraded: backend anchor fetch failed for %s: %s — "
                "using degraded_existing mode (sent_text + wall-clock freshness)",
                conv_id, e,
            )
            return TurnAnchor(
                sent_text=text, mode="degraded_existing",
                pre_send_wall_time=pre_send_wall,
                conversation_id_at_capture=conv_id,
            )

    async def _check_failed_send_receipt(self, capture_scope, anchor) -> dict:
        """Bounded read-only reconciliation; absence is never proof of no send."""
        from .backend_client import canonical_conversation_id_from_url
        from .turn_anchor import select_text_for_turn

        receipt = {"status": "unknown", "retry_safe": False}
        if self._delivery_stage != DeliveryStage.ACKNOWLEDGED.value:
            self._set_delivery_stage(DeliveryStage.UNKNOWN)
        try:
            async with asyncio.timeout(8):
                # Check the observed POST first, allowing a queued network
                # event one second to resolve within the SAME 8-second budget.
                future = capture_scope.future if capture_scope is not None else None
                captured_id = self._delivery_user_message_id
                if future is not None and not future.done():
                    try:
                        await asyncio.wait_for(asyncio.shield(future), timeout=1)
                    except TimeoutError:
                        pass
                if future is not None and future.done() and not future.cancelled():
                    captured_id = future.result().uuid or captured_id
                if captured_id:
                    self._set_delivery_stage(DeliveryStage.ACKNOWLEDGED, user_message_id=captured_id)
                    receipt["status"] = "post_observed"
                conv_id = self._delivery_conversation_id
                if not conv_id:
                    conv_id = canonical_conversation_id_from_url(
                        await self._js_strict("location.href", timeout=3)
                    )
                    if conv_id:
                        self._delivery_conversation_id = conv_id
                # Text equality, empty composer, or a missing tail node cannot
                # identify a repeated prompt. Only an exact captured ID can
                # upgrade persistence evidence during ambiguous delivery.
                if not conv_id or not captured_id:
                    receipt["reason"] = "exact_turn_identity_unavailable"
                    return receipt
                projection = await self._backend_client._fetch_recent_conversation_projection(conv_id)
                nodes = projection.get("nodes") or {}
                node = next((n for key, n in nodes.items()
                             if (n.get("id") or key) == captured_id and n.get("role") == "user"), None)
                if node is None:
                    receipt["reason"] = "captured_node_not_visible_yet"
                    return receipt
                receipt["status"] = "user_message_persisted"
                self._set_delivery_stage(DeliveryStage.ACKNOWLEDGED, conversation_id=conv_id)
                result = select_text_for_turn(projection, anchor.with_captured_id(captured_id))
                if result.status == "matched":
                    self._delivery_reply_persisted = True
                    receipt.update(status="reply_persisted", content=result.text)
        except PermissionError:
            # No alternate transport or browser-control path on denial.
            receipt["reason"] = "permission_denied"
        except Exception as exc:
            receipt["reason"] = type(exc).__name__
        return receipt

    async def send_and_stream(
        self, text: str, timeout: float = 120, *, budgets=None,
        model: str | None = None, on_progress=None,
    ) -> AsyncIterator[StreamChunk]:
        """Recover a proven pre-submission failure once, never replay a click."""
        from .send_recovery import recovery_scope, recover_before_submission

        with recovery_scope(self) as recovery_budget:
            while True:
                try:
                    async for chunk in self._send_and_stream_once(
                        text, timeout, budgets=budgets, model=model, on_progress=on_progress,
                    ):
                        yield chunk
                    return
                except Exception as exc:
                    self._annotate_delivery_error(exc)
                    if not await recover_before_submission(self, exc, recovery_budget, on_progress):
                        raise

    async def _send_and_stream_once(
        self,
        text: str,
        timeout: float = 120,
        *,
        budgets=None,
        model: str | None = None,
        on_progress=None,
    ) -> AsyncIterator[StreamChunk]:
        """Send a message and yield streaming response chunks.

        A2 turn-correlation sequence (peer-reviewed, conv ``6a482cfd``):
        1. Read assistant-count baseline (A1 fail-closed).
        2. Health-check the identity listener; re-enable if stale.
        3. Arm a per-send capture scope (IdentityListener).
        4. Build a pre-send fallback anchor (existing/degraded/fresh — NO
           captured UUID yet; the UUID only exists in the POST that
           click_send generates).
        5. type_message + click_send.
        6. Wait for the IdentityListener to capture the UUID (short timeout).
        7. Anchor = fallback.with_captured_id(uuid) if captured else fallback.
        8. stream_until_complete(turn_anchor=anchor) + anchored reconciliation.
        9. ALWAYS: scope.close() in finally (clears capture state on every
           terminal path — success, timeout, exception, cancellation).
        """
        from . import generation_gate, send_receipts
        from .identity_listener import hash_sent_text
        from .turn_anchor import TurnReconciliationError

        # Reset before any await so a later call can never inherit the prior
        # request's acknowledged/unknown state and accidentally become
        # retryable (or vice versa).
        self._reset_delivery_metadata()
        # PR4 belt-and-suspenders: refuse to mutate the DOM in parallel mode.
        self._assert_owned_tab_required()
        # A1: count existing assistants BEFORE sending (fail-closed baseline).
        await self._notify_send_progress(on_progress, "pre_send_baseline")
        initial_count = await self._read_assistant_count_baseline()

        # A2 Step 2: identity-listener health check.
        capture_scope = None
        if self._identity_listener is not None:
            await self._identity_listener.reenable_if_stale()

        # A2 Step 3+4: arm capture scope + build fallback anchor.
        # The fallback anchor captures pre-send state (backend node-ids/times
        # or wall-clock) for dual-anchor correlation if UUID capture fails.
        await self._notify_send_progress(on_progress, "pre_send_anchor")
        fallback_anchor = await self._capture_pre_send_fallback_anchor(text)
        # Generation gate (per-conversation, cross-process): a second send
        # into a conversation that is mid-generation kills the streaming
        # reply — observed as 1-2 char truncated answers when two harness
        # sessions shared one conv_id from different tabs/processes.
        # MutationLock is per-target and does not cover this. Fresh chats
        # skip the gate: a nonexistent conversation can't be generating.
        gen_gate_conv = self._current_conv_id
        if gen_gate_conv:
            busy_for = generation_gate.busy_remaining(gen_gate_conv)
            if busy_for > 0:
                raise GenerationInProgressError(gen_gate_conv, retry_after=busy_for)
            if await self._dom.is_generating():
                # Live generation this process never flagged — e.g. a manual
                # browser send or a flag that outlived its watcher. The DOM
                # can't tell us how much longer; retry on a short horizon.
                raise GenerationInProgressError(gen_gate_conv, retry_after=60.0)

        if self._identity_listener is not None and self._identity_listener.is_alive():
            capture_scope = self._identity_listener.arm_capture_scope(
                expected_text_hash=hash_sent_text(text),
                conversation_id=self._current_conv_id,
                target_id=self._target_id,
            )
            receipt = send_receipts.current()
            if receipt is not None:
                # The CDP reader has its own context. Capture the receipt here
                # so the POST identity survives cancellation of this waiter.
                capture_scope.on_capture = lambda result: receipt.mark(
                    state="dispatched", message_id=result.uuid,
                )

        try:
            # Account-level pace gate: sleep until the shared minimum send
            # interval / cooldown lets this POST through (cross-process).
            await self._notify_send_progress(on_progress, "pace")
            await self._pace.pace("send")
            # Type and send. If anything between the composer insert and the
            # send-acknowledgment fails (verify mismatch, click miss, cancel),
            # the typed text would linger as a composer draft and corrupt the
            # NEXT send's verification — field-observed 2026-09-15: a failed
            # nudge left a draft that needed manual evaluate_script surgery.
            # Best-effort clear, then let the real error propagate.
            input_verified = False
            try:
                await self._notify_send_progress(on_progress, "input")
                await self.type_message(text)
                input_verified = True
                # click_send marks the boundary immediately BEFORE dispatch.
                # Its read-only button-readiness probe can still recover.
                await self._notify_send_progress(on_progress, "click")
                # Commit BEFORE click: a crash/cancel after this point leaves
                # delivery uncertain, never permission to submit again.
                send_receipts.mark(
                    state="delivery_unknown", conversation_id=self._current_conv_id,
                )
                await self.click_send()

                # A2 Step 6: wait for the IdentityListener to capture the UUID.
                await self._notify_send_progress(on_progress, "ack")
                captured_uuid = None
                if capture_scope is not None:
                    captured_uuid = await self._identity_listener.wait_for_captured_uuid(timeout=5.0)
                if captured_uuid:
                    self._set_delivery_stage(
                        DeliveryStage.ACKNOWLEDGED,
                        user_message_id=captured_uuid,
                    )

                # P0 send acknowledgment (ChatGPT review, conv 6a52f0f3):
                # click_send dispatches synthetic mouse events — that proves the
                # JS ran, not that React accepted the submission. Under load, the
                # click can fire without producing a user message. Before entering
                # completion detection, verify at least one acknowledgment signal:
                #   1. UUID was captured, OR
                #   2. user-message count increased AND composer cleared
                # If none → raise before entering completion detection (which would
                # waste time polling for a response that will never come).
                #
                # Graceful: if the acknowledgment probe fails (JS error, mock
                # environment, unusual DOM), DON'T block the send. The check is a
                # safety net for the overloaded-page case, not a hard gate that
                # could prevent sends in edge cases we haven't seen.
                if not captured_uuid:
                    try:
                        acknowledged = await self._verify_send_acknowledged()
                        if acknowledged is False:  # explicitly False, not None
                            raise SendReadinessError(
                                "Send not acknowledged — click dispatched but no user "
                                "message appeared (no UUID captured, user count unchanged, "
                                "composer not cleared). The page may be overloaded or the "
                                "send was rejected. Do NOT retry automatically."
                            )
                        if acknowledged is True:
                            self._set_delivery_stage(DeliveryStage.ACKNOWLEDGED)
                        elif acknowledged is None:
                            # A click happened but neither the listener nor the
                            # DOM probe gave us a conclusive answer.
                            self._set_delivery_stage(DeliveryStage.UNKNOWN)
                    except SendReadinessError:
                        raise
                    except PermissionError:
                        raise
                    except Exception as ack_err:
                        from .send_recovery import is_recoverable_transport_error

                        if is_recoverable_transport_error(ack_err):
                            raise
                        # Probe failed (JS error, mock, unusual DOM). Don't block
                        # the send — let completion detection proceed. Log so the
                        # failure is traceable.
                        self._set_delivery_stage(DeliveryStage.UNKNOWN)
                        logger.debug("Send acknowledgment probe failed (non-blocking): %s", ack_err)
            except asyncio.CancelledError:
                if self._delivery_stage != DeliveryStage.NOT_STARTED.value:
                    self._set_delivery_stage(DeliveryStage.UNKNOWN)
                raise
            except Exception as exc:
                from .send_recovery import is_recoverable_transport_error

                if (input_verified
                        and self._delivery_stage == DeliveryStage.NOT_STARTED.value
                        and not is_recoverable_transport_error(exc)
                        and not isinstance(exc, PermissionError)):
                    await self._clear_composer()
                raise

            # Send verified → this conv is now mid-generation on OUR watch.
            # Flag it so a concurrent send (any process/tab) fails fast at
            # the gate instead of killing this stream. Cleared in finally
            # when our observation ends; TTL covers crash paths.
            # Re-resolve: a fresh-chat send had no conv_id at gate-check
            # time — the conversation only exists now.
            if not gen_gate_conv:
                gen_gate_conv = self._current_conv_id
            if gen_gate_conv:
                generation_gate.mark_generating(gen_gate_conv)

            # A2 Step 7: build the final anchor (fallback + captured UUID).
            turn_anchor = fallback_anchor.with_captured_id(captured_uuid)

            # A2 Step 8: stream + completion with the anchored turn.
            # P1: pass budgets + model for the model-aware two-state phase-2
            # machine. When None (no config available), the detector uses the
            # legacy single PHASE_STALL_SECONDS behavior.
            await self._notify_send_progress(on_progress, "generation")
            async for chunk in self._completion.stream_until_complete(
                initial_count=initial_count,
                timeout=timeout,
                turn_anchor=turn_anchor,
                budgets=budgets,
                model=model,
            ):
                yield chunk

            # Wait for URL to become /c/{id}. Provisional routes
            # ("/c/WEB:<uuid>" etc.) carry a client-side draft id that is
            # replaced by the server id once the conversation persists —
            # keep polling until the canonical segment appears.
            from .backend_client import canonical_conversation_id_from_url

            conv_id = ""
            for _ in range(60):
                try:
                    url = await self._js_strict("window.location.href")
                except CDPJSError:
                    await asyncio.sleep(0.5)
                    continue
                conv_id = canonical_conversation_id_from_url(url)
                if conv_id:
                    break
                await asyncio.sleep(0.5)

            if conv_id:
                logger.info("Conversation: %s", conv_id)
                self._current_conv_id = conv_id
                self._delivery_conversation_id = conv_id
                last_dom_text = self._completion.last_dom_text
                had_non_text_content = self._completion.had_non_text_content
                # A2: anchored final-text reconciliation. The selector resolves
                # the terminal assistant text for THIS turn (by captured UUID
                # or dual-anchor fallback); stale text from a prior turn is
                # never accepted.
                last_status = "not_ready"
                last_diagnostic = {}
                for _ in range(60):
                    result = await self._fetch_text_for_turn(conv_id, turn_anchor)
                    last_status = result.status
                    last_diagnostic = result.diagnostic or {}
                    if result.status == "matched" and result.text:
                        # The anchored backend projection found the terminal
                        # assistant node for this exact user turn. This is
                        # stronger evidence than the live DOM stream and lets
                        # the MCP layer skip its redundant post-send read.
                        self._delivery_reply_persisted = True
                        if len(result.text) > len(last_dom_text):
                            yield StreamChunk(delta=result.text[len(last_dom_text):])
                            last_dom_text = result.text
                        break
                    if result.status == "non_text":
                        # P2.5 RCA fix: non_text is NOT terminal here. The backend
                        # propagates intermediary nodes (reasoning_recap, thoughts,
                        # model_editable_context) BEFORE the final text node.
                        # Treating non_text as terminal caused an intermittent
                        # race: the reconciliation saw the intermediaries,
                        # concluded "non-text", and yielded the placeholder even
                        # though the text node would appear within seconds.
                        # Now: keep polling (like not_ready) — the text node may
                        # still be propagating. Only after the loop exhausts do we
                        # yield the placeholder.
                        pass
                    if result.status in ("ambiguous", "degraded_not_fresh", "fetch_failed"):
                        # Keep polling — these may resolve as the backend settles.
                        pass
                    # not_ready → keep polling.
                    await asyncio.sleep(0.5)
                else:
                    # Loop exhausted without a text match.
                    # If the last status was non_text (genuinely non-text
                    # response after full polling), fall through to the
                    # placeholder below. Otherwise raise a typed error.
                    if last_status != "non_text":
                        raise TurnReconciliationError(
                            conversation_id=conv_id,
                            anchor_mode=turn_anchor.mode,
                            last_status=last_status,
                            diagnostic={
                                "captured_id": turn_anchor.captured_user_message_id,
                                "had_non_text_content": had_non_text_content,
                                "last_fetch_diagnostic": last_diagnostic,
                            },
                        )
                    # The bounded reconciliation loop observed the anchored
                    # assistant as non-text on its final poll. Keep the
                    # persistence evidence only when the DOM detector also
                    # confirmed non-text content, which is the terminal guard
                    # used by the placeholder path below.
                    if had_non_text_content:
                        self._delivery_reply_persisted = True
                # Non-text placeholder (unchanged from pre-A2).
                if not last_dom_text and had_non_text_content:
                    placeholder = (
                        "[Non-text response generated (image/tool-use/etc.) — "
                        "use get_conversation to retrieve full content.]"
                    )
                    yield StreamChunk(delta=placeholder)
            # A completed assistant turn is an implicit acknowledgment even
            # when the listener/DOM probe was unavailable. This only runs on a
            # successful observation path; rate-limit/timeout errors keep the
            # earlier conservative stage and are never retried as a new send.
            if self._delivery_stage in {
                DeliveryStage.SUBMISSION_ATTEMPTED.value,
                DeliveryStage.UNKNOWN.value,
            }:
                self._set_delivery_stage(DeliveryStage.ACKNOWLEDGED)
        except asyncio.CancelledError:
            # Keep cancellation observable to the caller. If cancellation
            # happened after click dispatch, retain an unknown state for
            # diagnostics, but never turn it into a retryable exception.
            if self._delivery_stage != DeliveryStage.NOT_STARTED.value:
                self._set_delivery_stage(DeliveryStage.UNKNOWN)
            raise
        except Exception as exc:
            from .send_recovery import is_recoverable_transport_error

            if (self._delivery_stage != DeliveryStage.NOT_STARTED.value
                    and is_recoverable_transport_error(exc)):
                await self._notify_send_progress(on_progress, "checking_submission_receipt (budget 8s; no resend)")
                exc.receipt_check = await self._check_failed_send_receipt(capture_scope, fallback_anchor)
            self._annotate_delivery_error(exc)
            raise
        finally:
            # A2 Step 9: ALWAYS clear the capture scope (failure-mode E).
            if capture_scope is not None:
                capture_scope.close()
            # Our observation of this generation ended (completed, timed
            # out, or errored) — release the gate. If generation somehow
            # continues past our watch, the DOM probe remains as backstop.
            if gen_gate_conv:
                generation_gate.clear_generating(gen_gate_conv)

        send_receipts.mark(state="reply_received", conversation_id=self._current_conv_id)
        yield StreamChunk(delta="", finish_reason="stop")

    async def _fetch_text_for_turn(self, conversation_id: str, anchor):
        """A2 anchored final-text fetch. Delegated to BackendClient.

        Returns a ``TurnTextResult`` (rich status). The detector tail in
        ``send_and_stream`` uses this to resolve the terminal assistant text
        for the submitted turn via the captured anchor.
        """
        return await self._backend_client._fetch_text_for_turn(conversation_id, anchor)

    async def _fetch_end_turn_for_turn(
        self, conversation_id: str, anchor, *, had_non_text_content: bool
    ):
        """A2 anchored completion-status fetch. Delegated to BackendClient.

        Returns a ``TurnEndResult`` (internal status); the detector collapses
        to tri-state via ``collapse_to_end_turn_status``.
        """
        return await self._backend_client._fetch_end_turn_for_turn(
            conversation_id, anchor, had_non_text_content=had_non_text_content,
        )

    async def _conversation_id_from_url(self) -> str:
        """Parse the conversation id from the live tab's location.href.

        Delegated to BackendClient (Phase 5 PR1 extraction)."""
        return await self._backend_client._conversation_id_from_url()

    async def _get_live_conversation_id_best_effort(self) -> str:
        """Resolve the in-flight conversation id by cheapest available source.

        Delegated to BackendClient (Phase 5 PR1 extraction)."""
        return await self._backend_client._get_live_conversation_id_best_effort()

    async def dismiss_rate_limit(self) -> bool:
        """Dismiss ChatGPT's 'Too many requests' pop-up by clicking 'Got it'.

        Delegated to ChatGPTDom (Phase 5 PR3 extraction). Preserved exactly:
        text-targeted click + re-scan, tri-state return (True/False/None).
        """
        return await self._dom.dismiss_rate_limit()

    def _check_auth_in_raw(self, raw: str) -> None:
        """#20: Detect auth failure in raw response text and raise.

        Delegated to BackendClient (Phase 5 PR1 extraction)."""
        self._backend_client._check_auth_in_raw(raw)

    async def _capture_selector_diagnostic(self, selector_name: str) -> None:
        """#5: Capture DOM state when a selector fails to match.

        Delegated to ChatGPTDom (Phase 5 PR3 extraction). Best-effort — never
        raises."""
        await self._dom._capture_selector_diagnostic(selector_name)

    # ── API helpers ───────────────────────────────────────────

    @diagnose("get_models")
    async def get_models(self) -> list[dict]:
        """List available models.

        Delegated to BackendClient (Phase 5 PR1 extraction). @diagnose wraps
        the caller-facing entry point so timing/observability is unchanged.
        """
        return await self._backend_client.get_models()

    @diagnose("get_projects")
    async def get_projects(self) -> list[dict]:
        """List projects. Delegated to BackendClient (Phase 5 PR1 extraction)."""
        return await self._backend_client.get_projects()

    async def resolve_project_id(self, value: str) -> str:
        """Resolve a project reference to a gizmo id.

        ``g-``/``g-p-`` ids pass through verbatim. Anything else is treated as
        a project NAME and resolved against ``get_projects``: exact
        case-insensitive match first, then unique substring match. A no-match
        or ambiguous name raises — a caller must never silently land in the
        wrong project (observed: an agent passed a name and the chat landed
        in an unrelated project).
        """
        v = (value or "").strip()
        if v.startswith(("g-p-", "g-")):
            return v
        projects = await self.get_projects()
        named = [
            p for p in projects
            if p.get("id") and (p.get("name") or "").strip()
        ]
        low = v.lower()
        exact = [p for p in named if p["name"].strip().lower() == low]
        if len(exact) == 1:
            return exact[0]["id"]
        partial = [p for p in named if low in p["name"].strip().lower()]
        if len(exact) > 1 or len(partial) > 1:
            cands = ", ".join(f"{p['name']}({p['id']})" for p in (exact or partial))
            raise ValueError(f"Ambiguous project name {value!r}: {cands}")
        if partial:
            return partial[0]["id"]
        raise ValueError(
            f"Unknown project {value!r} — not a gizmo id and no project name "
            f"matches. Available: "
            + ", ".join(f"{p['name']}({p['id']})" for p in named)
        )

    # ── Conversation Management ──────────────────────────────

    @diagnose("get_conversations")
    async def get_conversations(
        self,
        offset: int = 0,
        limit: int = 28,
        order: str = "updated",
    ) -> list[dict]:
        """List recent conversations. Delegated to BackendClient (Phase 5 PR1)."""
        return await self._backend_client.get_conversations(offset, limit, order)

    @diagnose("get_conversation")
    async def get_conversation(self, conversation_id: str) -> dict:
        """Get full conversation detail with message mapping.

        Delegated to BackendClient (Phase 5 PR1 extraction)."""
        return await self._backend_client.get_conversation(conversation_id)

    @diagnose("delete_conversation")
    async def delete_conversation(self, conversation_id: str) -> bool:
        """Delete a conversation. Delegated to BackendClient (Phase 5 PR1)."""
        return await self._backend_client.delete_conversation(conversation_id)

    async def rename_conversation(self, conversation_id: str, title: str) -> bool:
        """Rename a conversation. Delegated to BackendClient (Phase 5 PR1)."""
        return await self._backend_client.rename_conversation(conversation_id, title)

    # ── Project Management ────────────────────────────────────

    @diagnose(
        "create_project",
        capture_js=lambda self: (
            "POST /backend-api/projects",
            {"name": "<arg>", "instructions": "<arg>", "memory_scope": "<arg>"},
        ),
    )
    async def create_project(
        self,
        name: str,
        instructions: str = "",
        memory_scope: str = "project_v2",
    ) -> dict:
        """Create a new ChatGPT project. Delegated to BackendClient (Phase 5 PR1)."""
        return await self._backend_client.create_project(name, instructions, memory_scope)

    @diagnose(
        "update_project_instructions",
        capture_js=lambda self: (
            "PATCH /backend-api/projects/{id}",
            {"instructions": "<arg>"},
        ),
    )
    async def update_project_instructions(
        self,
        project_id: str,
        instructions: str,
    ) -> bool:
        """Update a project's custom instructions.

        Delegated to BackendClient (Phase 5 PR1 extraction)."""
        return await self._backend_client.update_project_instructions(project_id, instructions)

    async def get_project_detail(self, project_id: str) -> dict:
        """Get full project/gizmo detail. Delegated to BackendClient (Phase 5 PR1)."""
        return await self._backend_client.get_project_detail(project_id)

    # ── Archive Conversation ────────────────────────────────

    @diagnose(
        "archive_conversation",
        capture_js=lambda self: (
            "PATCH /backend-api/conversation/{id}",
            {"archive": "<arg>"},
        ),
    )
    async def archive_conversation(self, conversation_id: str, archive: bool = True) -> bool:
        """Archive or unarchive a conversation. Delegated to BackendClient (Phase 5 PR1)."""
        return await self._backend_client.archive_conversation(conversation_id, archive)

    # ── Memory Management ─────────────────────────────────────

    @diagnose("get_memories")
    async def get_memories(self) -> list[dict]:
        """List all ChatGPT memories. Delegated to BackendClient (Phase 5 PR1)."""
        return await self._backend_client.get_memories()

    @diagnose("create_memory")
    async def create_memory(self, content: str) -> dict:
        """Create a memory via chat. Delegated to BackendClient (Phase 5 PR1)."""
        return await self._backend_client.create_memory(content)

    @diagnose("delete_memory")
    async def delete_memory(self, memory_id: str) -> bool:
        """Delete a ChatGPT memory by ID. Delegated to BackendClient (Phase 5 PR1)."""
        return await self._backend_client.delete_memory(memory_id)

    @diagnose("delete_project")
    async def delete_project(self, project_id: str) -> dict:
        """Delete a ChatGPT project by ID. Delegated to BackendClient (Phase 5 PR1)."""
        return await self._backend_client.delete_project(project_id)

    # ── Custom GPT Navigation ─────────────────────────────────

    async def navigate_gpt(self, gizmo_id: str) -> None:
        """Navigate to a Custom GPT for interaction."""
        url = f"https://chatgpt.com/g/{gizmo_id}"
        logger.info("Navigate to GPT: %s", url)
        await self._cdp("Page.navigate", {"url": url})
        await asyncio.sleep(3)
        for _ in range(30):
            result = await self._js(
                "(function() {"
                "  return JSON.stringify({"
                f"    ready: !!document.querySelector('{COMPOSER_SELECTOR}') || !!document.querySelector('{COMPOSER_FALLBACK_SELECTOR}'),"
                "    url: location.href"
                "  });"
                "})()",
            )
            try:
                state = json.loads(result)
                if state.get("ready"):
                    logger.info("GPT page ready: %s", state.get("url"))
                    break
            except (json.JSONDecodeError, TypeError):
                pass
            await asyncio.sleep(0.5)
        await asyncio.sleep(2)
        self._current_conv_id = None

    @diagnose("list_gpts")
    async def list_gpts(self) -> list[dict]:
        """List Custom GPTs (non-project gizmos). Delegated to BackendClient (Phase 5 PR1)."""
        return await self._backend_client.list_gpts()

    # ── Project Files ─────────────────────────────────────────

    @diagnose("get_project_files")
    async def get_project_files(self, project_id: str) -> list[dict]:
        """List files attached to a ChatGPT project. Delegated to BackendClient (Phase 5 PR1)."""
        return await self._backend_client.get_project_files(project_id)

    # ── Token Management ──────────────────────────────────────

    async def ensure_token(self) -> str:
        """Ensure a non-stale access token, refreshing if empty OR older than TTL.

        Delegated to BackendClient (Phase 5 PR1 extraction)."""
        return await self._backend_client.ensure_token()

    # ── Lifecycle ─────────────────────────────────────────────

    async def close(self) -> None:
        # Stop the page session through the same ownership-safe transaction as
        # connect, reconnect, and send recovery.  The helper cancels pending
        # callers and closes the websocket after making stale readers
        # non-current.
        await self._stop_cdp_session(fail_pending=True, reset_poison=True)
        # Stop the heartbeat lease task and clear our registry entry so a
        # future restart of THIS instance creates fresh rather than reclaiming
        # a tab we just closed.
        if self._heartbeat_task and not self._heartbeat_task.done():
            self._heartbeat_task.cancel()
            try:
                await asyncio.wait_for(self._heartbeat_task, timeout=2)
            except (TimeoutError, asyncio.CancelledError):
                pass
        self._heartbeat_task = None
        if self._tab_registry:
            try:
                # Only clear if the entry still belongs to us. If we crashed
                # earlier, went stale, and another process reclaimed our
                # instance's entry, unconditional clear would delete THEIR lease.
                self._tab_registry.clear_if_owner(self._target_id)
            except Exception as e:
                logger.debug("Tab registry clear failed: %s", e)
        # Only close the attached tab if WE created it. An adopted tab
        # (Chrome's launch tab, a leftover from a prior run, or a tab the
        # user opened) is left alone — closing it would accumulate negative
        # side-effects (killing a tab the user expects to stay open).
        #
        # Conv-affinity guard: an owned tab whose URL is now /c/<id> has
        # become a conversation's shared tab (e.g. a scratch tab that was
        # used to create a new chat, or navigated into a conv). Closing it
        # would kill the conversation's persistent tab — possibly adopted by
        # another driver. Leave it open.
        if self._target_id and self._owns_target:
            close_it = True
            try:
                for t in self._list_page_targets():
                    if t.get("id") == self._target_id and "/c/" in (t.get("url") or ""):
                        close_it = False
                        logger.info(
                            "Leaving conv-bound tab open: %s", self._target_id
                        )
                        break
            except Exception:
                pass
            if close_it:
                try:
                    await self._browser_cdp("Target.closeTarget", {"targetId": self._target_id})
                    logger.info("Closed owned tab: %s", self._target_id)
                except Exception as e:
                    logger.debug("Could not close owned tab %s: %s", self._target_id, e)
        elif self._target_id and not self._owns_target:
            logger.info("Leaving adopted tab open: %s", self._target_id)
        self._target_id = None
        self._owns_target = False
        self._conv_target = False
        self._shared_home_target = False
        self._scratch_target_id = None
        logger.info("CDP driver closed")

    async def recover_auth(self) -> bool:
        """Probe whether the ChatGPT session is valid again, and if so reset
        the AUTH_EXPIRED breaker.

        Delegated to BackendClient (Phase 5 PR1 extraction). The 401
        AUTH_EXPIRED trip/reset semantics are preserved exactly.
        """
        return await self._backend_client.recover_auth()

    @property
    def is_connected(self) -> bool:
        return self._ws is not None and self._ws.state.name == "OPEN"

    # PR3/5: read-only owned-target state for the lock resolver + observability.
    # Backs ``has_owned_target``, which the resolver uses to decide per-target
    # vs port-wide locking in parallel mode. Mirrors the close() guard at
    # :1535 — "a driver that adopted a tab never closes a tab it didn't open."
    @property
    def target_id(self) -> str | None:
        """The owned tab's CDP targetId, or None if none owned/adopted."""
        return self._target_id

    @property
    def owns_target(self) -> bool:
        """True iff this driver created its target (owned mode), not adopted."""
        return self._owns_target

    @property
    def has_owned_target(self) -> bool:
        """True iff the driver holds a dedicated owned tab target.

        The condition the parallel-tabs lock resolver checks before granting a
        per-target lock: ``tab_mode == "owned"`` AND ``_owns_target`` AND a
        non-empty ``_target_id``.
        """
        return self.tab_mode == "owned" and self._owns_target and bool(self._target_id)

    @property
    def conv_target(self) -> bool:
        """True iff the current target is a conv-bound shared (adopted/created-for-conv) tab."""
        return self._conv_target

    @property
    def has_lockable_target(self) -> bool:
        """True iff the driver holds a target that per-target locking can name.

        Owned tabs, conv-bound shared tabs, AND adopted shared home tabs all
        qualify: the per-target lock key is the targetId itself, so two
        drivers attached to the SAME tab still serialize on the same lock
        file. What must NOT qualify is the legacy arbitrary-adopt fallback
        (an unrelated tab we can't name), which is why ``owns_target or
        conv_target or shared_home_target`` — not just ``target_id`` — is
        required.
        """
        return self.tab_mode == "owned" and bool(self._target_id) and (
            self._owns_target or self._conv_target or self._shared_home_target
        )

    def _assert_owned_tab_required(self) -> None:
        """Fail-closed owned-tab enforcement for parallel mode.

        Raises ``OwnedTabRequiredError`` if ``parallel_tabs`` is on but the
        driver has no owned target. Called at the top of ``send_and_stream``
        as belt-and-suspenders (the resolver/drift guard at the lock site is
        the primary gate). Surfaces as REST 503 / MCP isError=True.
        """
        if self._parallel_tabs and not self.has_lockable_target:
            raise OwnedTabRequiredError(
                "parallel_tabs=true requires a lockable tab target, but the "
                f"driver has none (tab_mode={self.tab_mode!r}, "
                f"owns_target={self._owns_target}, "
                f"conv_target={self._conv_target}, "
                f"target_id={self._target_id!r})"
            )

    def _assert_reconnect_target_stable(self, pre_target_id: str | None) -> None:
        """Reconnect drift guard (PR4): raise if the owned target changed.

        Called after a successful reconnect. In parallel mode, a reconnect that
        ends on a DIFFERENT target than it started means any in-flight mutation
        holding the old target's lock no longer names the active tab. Fail
        retryably so the caller re-resolves and re-locks. Factored as a method
        so the guard is unit-testable without driving the full WS chain.
        """
        if (
            self._parallel_tabs
            and pre_target_id is not None
            and self._target_id is not None
            and self._target_id != pre_target_id
        ):
            raise OwnedTabRequiredError(
                f"Owned target changed during reconnect "
                f"({pre_target_id} -> {self._target_id}); retry the mutation "
                f"so it re-resolves the lock key"
            )
