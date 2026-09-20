"""DOM-first conversation reads via a throwaway CDP session.

Why this exists: ``GET /backend-api/conversation/{id}`` is a
navigation-grade endpoint — the real web app calls it once per open, not
on a poll loop. wait_reply hammering it (140+/hr across sessions) is what
kept tripping account-level 429 cooldowns (matching public reports:
openai/codex#37518, #38763). The conversation's own tab already renders
everything wait_reply needs — role, tail text, streaming state — and
reading it costs zero API requests.

Design: rather than routing the call through the conversation's owning
driver (which would pin the pool slot for the whole wait), we open a
short-lived websocket straight to the conv's page target — CDP allows
multiple sessions per target, and Runtime.evaluate is read-only here.
The owning driver/process never knows we looked.

Caveat: long conversations virtualize — ``rendered_total`` counts
RENDERED message nodes, a lower bound on the backend total, and
``read_messages`` returns only the rendered tail. Callers that need
absolute totals still fall back to the backend fetch.
"""
from __future__ import annotations

import asyncio
import json
import logging
import urllib.parse
import urllib.request
import urllib.error
from typing import Any

logger = logging.getLogger(__name__)


class ConvDOMReadError(RuntimeError):
    """A throwaway CDP read failed after a conversation target was found.

    ``None`` is reserved for an unavailable/not-yet-open conversation tab.
    Protocol failures, permission denials, malformed CDP replies and timed
    reads must stay distinguishable so callers cannot turn them into an empty
    conversation or silently use the fallback as a permission bypass.
    """


class ConvDOMTimeoutError(ConvDOMReadError, TimeoutError):
    """The isolated CDP read exceeded its single wall-clock budget."""


class ConvDOMPermissionError(ConvDOMReadError, PermissionError):
    """Chrome refused the isolated CDP operation."""


class ConvDOMProtocolError(ConvDOMReadError):
    """The target answered with a malformed or failed CDP protocol frame."""


class ConvDOMTargetUnavailable(ConvDOMReadError):
    """The target disappeared after discovery (retry may be appropriate)."""

_TAIL_EXPR = (
    "(function(){"
    "  var msgs = document.querySelectorAll('[data-message-author-role]');"
    "  if (!msgs.length) return null;"
    "  var last = msgs[msgs.length-1];"
    "  var md = last.querySelector('.markdown');"
    "  var stopBtn = document.querySelector('[data-testid=\"stop-button\"], button[aria-label*=\"Stop\" i], button[aria-label*=\"停止\"]');"
    "  var gen = document.querySelector('[class*=\"result-thinking\"], [class*=\"generating\"]');"
    "  var visible = function(el){ return !!(el && el.isConnected && el.getClientRects && el.getClientRects().length); };"
    "  var stopVisible = visible(stopBtn);"
    "  var genVisible = visible(gen);"
    "  return JSON.stringify({"
    "    rendered_total: msgs.length,"
    "    last_role: last.getAttribute('data-message-author-role'),"
    "    generating: !!(stopVisible || genVisible),"
    "    generation_signal: stopVisible ? 'stop_button' : (genVisible ? 'thinking_indicator' : null),"
    "    tail_text: (md ? md.textContent : last.textContent || '').slice(-2000)"
    "  });"
    "})()"
)

_MSGS_EXPR = (
    "(function(){"
    "  var msgs = document.querySelectorAll('[data-message-author-role]');"
    "  var out = [];"
    "  var start = Math.max(0, msgs.length - __LIM__);"
    "  for (var i = start; i < msgs.length; i++) {"
    "    var m = msgs[i];"
    "    var md = m.querySelector('.markdown');"
    "    out.push({"
    "      role: m.getAttribute('data-message-author-role'),"
    "      content: (md ? md.textContent : m.textContent || '').trim()"
    "    });"
    "  }"
    "  return JSON.stringify(out);"
    "})()"
)


def _conv_ws_url(cdp_port: int, conv_id: str) -> str | None:
    """webSocketDebuggerUrl of the page target showing ``conv_id``."""
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{cdp_port}/json/list"
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            targets = json.loads(resp.read())
    except PermissionError:
        raise
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise ConvDOMPermissionError(
                f"CDP target discovery permission denied (HTTP {exc.code})"
            ) from exc
        return None
    except Exception:
        return None
    # Match the actual ChatGPT origin and route segments.  A substring test
    # such as ``needle in url`` can select a look-alike host or a different
    # route whose query/fragment merely contains the conversation id.
    expected_hosts = {"chatgpt.com", "chat.openai.com"}
    for t in targets:
        if t.get("type") != "page":
            continue
        try:
            parsed = urllib.parse.urlsplit(t.get("url", ""))
        except ValueError:
            continue
        host = (parsed.hostname or "").lower().rstrip(".")
        if host not in expected_hosts:
            continue
        parts = [part for part in parsed.path.split("/") if part]
        if any(
            parts[i] == "c" and parts[i + 1] == conv_id
            for i in range(len(parts) - 1)
        ):
            return t.get("webSocketDebuggerUrl")
    return None


async def _eval_on_conv_tab(
    cdp_port: int, conv_id: str, expr: str, timeout: float = 10,
    await_promise: bool = False,
) -> str | None:
    """Evaluate ``expr`` on the conv's page target via a fresh WS session."""
    import websockets

    try:
        budget = max(0.0, float(timeout))
    except (TypeError, ValueError):
        raise ValueError(f"invalid conversation DOM timeout: {timeout!r}") from None
    loop = asyncio.get_running_loop()
    deadline = loop.time() + budget

    # ``urllib.request.urlopen`` is synchronous.  Keep discovery off the
    # event loop so the waiter's absolute deadline can still cancel this
    # operation when CDP is unavailable or the local endpoint stalls.
    try:
        discovery_remaining = deadline - loop.time()
        if discovery_remaining <= 0:
            return None
        ws_url = await asyncio.wait_for(
            asyncio.to_thread(_conv_ws_url, cdp_port, conv_id),
            timeout=min(discovery_remaining, 5.0),
        )
    except asyncio.CancelledError:
        raise
    except asyncio.TimeoutError:
        # No target was obtained. This is the normal "conversation tab is not
        # open" signal used by the DOM-first callers, not an empty read.
        return None
    except ConvDOMReadError:
        raise
    except Exception as exc:
        raise ConvDOMProtocolError(
            f"conversation target discovery failed for {conv_id}: {exc}"
        ) from exc
    if not ws_url:
        return None

    params: dict = {"expression": expr, "returnByValue": True}
    if await_promise:
        params["awaitPromise"] = True
    def _remaining(phase: str) -> float:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise ConvDOMTimeoutError(
                f"conversation DOM {phase} timed out after {budget:.3f}s"
            )
        return remaining

    def _detail_text(detail: Any) -> str:
        if isinstance(detail, str):
            return detail
        if not isinstance(detail, dict):
            return str(detail)
        parts: list[str] = []
        for key in ("message", "text", "description"):
            value = detail.get(key)
            if value:
                parts.append(str(value))
        exception = detail.get("exception")
        if isinstance(exception, dict):
            for key in ("description", "value"):
                value = exception.get(key)
                if value:
                    parts.append(str(value))
        return "; ".join(parts) or str(detail)

    def _is_permission(detail: Any) -> bool:
        text = _detail_text(detail).lower()
        return any(
            phrase in text
            for phrase in (
                "permission denied",
                "access denied",
                "not allowed",
                "forbidden",
                "permissionerror",
                "notallowederror",
                "securityerror",
                "blocked by permissions",
            )
        )

    async def _run_session() -> str | None:
        remaining = _remaining("connect")
        async with websockets.connect(
            ws_url,
            open_timeout=min(5.0, remaining),
            close_timeout=min(1.0, remaining),
            max_size=10 * 1024 * 1024,
        ) as ws:
            frame = json.dumps({
                "id": 1,
                "method": "Runtime.evaluate",
                "params": params,
            })
            await asyncio.wait_for(ws.send(frame), _remaining("send"))
            while True:
                raw = await asyncio.wait_for(ws.recv(), _remaining("response"))
                try:
                    msg = json.loads(raw)
                except (json.JSONDecodeError, TypeError) as exc:
                    raise ConvDOMProtocolError(
                        f"conversation DOM returned invalid CDP JSON: {exc}"
                    ) from exc
                if msg.get("id") == 1:
                    if msg.get("error") is not None:
                        detail = msg.get("error")
                        if _is_permission(detail):
                            raise ConvDOMPermissionError(
                                f"conversation DOM permission denied: "
                                f"{_detail_text(detail)}"
                            )
                        raise ConvDOMProtocolError(
                            f"conversation DOM CDP error: {_detail_text(detail)}"
                        )
                    result = msg.get("result")
                    if not isinstance(result, dict):
                        raise ConvDOMProtocolError(
                            "conversation DOM CDP reply has no result object"
                        )
                    exception_details = result.get("exceptionDetails")
                    if exception_details is not None:
                        if _is_permission(exception_details):
                            raise ConvDOMPermissionError(
                                "conversation DOM permission denied: "
                                f"{_detail_text(exception_details)}"
                            )
                        raise ConvDOMProtocolError(
                            "conversation DOM Runtime.evaluate exception: "
                            f"{_detail_text(exception_details)}"
                        )
                    inner = result.get("result")
                    if not isinstance(inner, dict) or "value" not in inner:
                        raise ConvDOMProtocolError(
                            "conversation DOM Runtime.evaluate returned no value"
                        )
                    return inner["value"]

    try:
        session_budget = _remaining("connect")
        return await asyncio.wait_for(_run_session(), session_budget)
    except (ConvDOMReadError, asyncio.CancelledError):
        raise
    except asyncio.TimeoutError as exc:
        raise ConvDOMTimeoutError(
            f"conversation DOM read timed out after {budget:.3f}s"
        ) from exc
    except PermissionError:
        raise
    except Exception as exc:
        logger.debug("conv_dom_read: eval failed for %s", conv_id, exc_info=True)
        raise ConvDOMTargetUnavailable(
            f"conversation DOM target unavailable for {conv_id}: {exc}"
        ) from exc


async def conv_backend_eval(
    cdp_port: int,
    conv_id: str,
    expr_template: str,
    data: dict,
    timeout: float = 15,
) -> str | None:
    """Evaluate an async ``__D``-template on the conv tab via a fresh session.

    Isolated fallback for backend-api reads: when the owning driver's
    session is wedged or recovering, completion detection must not share
    its fate.  CDP allows multiple sessions per target and the page's
    cookies are origin-scoped, so the same fetch succeeds on a throwaway
    session.  ``expr_template``/``data`` follow the transport's
    ``_js_with_data`` injection contract (``__D`` passed as an argument,
    never string-concatenated).  ``None`` means that no matching conversation
    target was available. Protocol, timeout and permission failures raise
    typed ``ConvDOMReadError`` subclasses instead of becoming an empty body.
    """
    wrapped = f"( (__D) => ({expr_template}) )({json.dumps(data)})"
    return await _eval_on_conv_tab(
        cdp_port, conv_id, wrapped, timeout=timeout, await_promise=True
    )


async def conv_tail_state(cdp_port: int, conv_id: str) -> dict | None:
    """Rendered tail state of ``conv_id``'s tab, or None if unavailable.

    Keys: rendered_total, last_role, generating, generation_signal, tail_text.
    ``rendered_total`` is a lower bound for a virtualized page and must not be
    compared with an absolute backend message total.
    """
    raw = await _eval_on_conv_tab(cdp_port, conv_id, _TAIL_EXPR)
    if raw is None:
        return None
    if isinstance(raw, str) and not raw:
        raise ConvDOMProtocolError(
            f"conversation DOM tail returned an empty value for {conv_id}"
        )
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError) as exc:
        raise ConvDOMProtocolError(
            f"conversation DOM tail returned invalid JSON for {conv_id}: {exc}"
        ) from exc
    if not isinstance(data, dict):
        raise ConvDOMProtocolError(
            f"conversation DOM tail returned {type(data).__name__}, expected object"
        )
    return data


async def conv_messages(
    cdp_port: int, conv_id: str, limit: int = 50
) -> list | None:
    """Rendered tail messages (role + content), oldest-first, or None.

    The browser may virtualize older history, so this function intentionally
    has no absolute ``offset``/``total`` contract. Callers must label its
    result as a partial DOM observation rather than a backend page.
    """
    expr = _MSGS_EXPR.replace("__LIM__", str(int(limit)))
    raw = await _eval_on_conv_tab(cdp_port, conv_id, expr)
    if raw is None:
        return None
    if isinstance(raw, str) and not raw:
        raise ConvDOMProtocolError(
            f"conversation DOM messages returned an empty value for {conv_id}"
        )
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError) as exc:
        raise ConvDOMProtocolError(
            f"conversation DOM messages returned invalid JSON for {conv_id}: {exc}"
        ) from exc
    if not isinstance(data, list):
        raise ConvDOMProtocolError(
            f"conversation DOM messages returned {type(data).__name__}, expected list"
        )
    return data
