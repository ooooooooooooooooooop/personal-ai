"""Regression tests for the session-wedge resilience work (3 layers).

Field incident: a hung in-page backend fetch (no AbortController) left a
never-settling Runtime.evaluate parked on the main CDP session.  Chromium
serializes evaluates per session, so every later command — sends included
— starved behind it with identical response-phase timeouts, while fresh
sessions answered the same page instantly.  The three layers under test:

  1. self-settling evaluates — every expression is wrapped in a
     Promise.race watchdog so one hung in-page promise can never
     head-of-line block the session queue again (cdp_transport).
  2. poisoned-session recovery — a response-phase timeout marks the
     session poisoned and the next command reattaches a fresh session,
     with in-flight forensics logged (cdp_transport).
  3. fate separation — the completion detector's backend projection read
     falls back to a throwaway session so a wedged main session cannot
     blind completion detection (backend_client + conv_dom_read).
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from chatgpt_web2api.cdp_transport import (
    _EVAL_WATCHDOG_MARKER,
    _EVAL_WATCHDOG_MARGIN_MS,
    CDPTimeoutError,
    CDPTransport,
    _wrap_self_settling,
)


# ── Layer 1: self-settling evaluates ─────────────────────────────────


def test_wrap_self_settling_shape():
    """The wrapper races the original expression against a timer that fires
    just before the transport budget, and strips trailing semicolons that
    would be a syntax error in argument position."""
    wrapped = _wrap_self_settling("(async () => { return 1; })();", 3.0)
    assert wrapped.startswith("Promise.race([Promise.resolve((")
    assert "(async () => { return 1; })()" in wrapped
    # Trailing ";" must not survive into the argument position.
    assert "(async () => { return 1; })();)" not in wrapped
    assert _EVAL_WATCHDOG_MARKER in wrapped
    # 3000ms budget - 250ms margin.
    assert f"}}, {3000 - _EVAL_WATCHDOG_MARGIN_MS})".replace(" ", "") in wrapped.replace(" ", "")


def test_wrap_self_settling_min_budget_floor():
    """Tiny budgets still get a positive watchdog (floor 100ms)."""
    wrapped = _wrap_self_settling("1", 0.1)
    assert "},100)" in wrapped


def test_wrap_self_settling_marker_reads_as_timeout():
    """The marker must trip _is_timeout_detail so both _js and _js_strict
    raise CDPTimeoutError (typed, recoverable) rather than a generic JS error."""
    assert CDPTransport._is_timeout_detail(_EVAL_WATCHDOG_MARKER) is True


@pytest.mark.asyncio
async def test_js_sends_wrapped_expression():
    """_js wraps the caller's expression in the watchdog while leaving the
    Chrome-side timeout param and budget untouched."""
    transport_driver = MagicMock()
    captured = {}

    async def _fake_cdp(method, params=None, timeout=15, _retry=True):
        captured["params"] = params
        captured["timeout"] = timeout
        return {"result": {"result": {"value": "ok"}}}

    transport_driver._cdp = _fake_cdp
    transport = CDPTransport(transport_driver)
    assert await transport._js("location.href", timeout=4) == "ok"
    expr = captured["params"]["expression"]
    assert _EVAL_WATCHDOG_MARKER in expr
    assert "location.href" in expr
    assert captured["params"]["timeout"] == 4000
    assert captured["timeout"] == 4


@pytest.mark.asyncio
async def test_js_watchdog_rejection_raises_typed_timeout():
    """A watchdog rejection (evaluate settled, promise lost the race) must
    surface as CDPTimeoutError on BOTH the soft and strict paths — this is
    what converts a silent queue wedge into a recoverable error."""
    for wrapper in ("_js", "_js_strict"):
        driver = MagicMock()

        async def _fake_cdp(method, params=None, timeout=15, _retry=True):
            return {
                "result": {
                    "exceptionDetails": {
                        "text": f"Uncaught (in promise) Error: {_EVAL_WATCHDOG_MARKER}"
                    }
                }
            }

        driver._cdp = _fake_cdp
        transport = CDPTransport(driver)
        with pytest.raises(CDPTimeoutError):
            await getattr(transport, wrapper)("expr", timeout=2)


# ── Layer 2: poisoned-session recovery + forensics ───────────────────


class _NeverRespondingWebSocket:
    """Accepts sends but never delivers a response — the wedge signature."""

    def __init__(self):
        self.sent: list[str] = []

    async def send(self, data):
        self.sent.append(data)

    async def recv(self):  # pragma: no cover - not used without a reader
        await asyncio.sleep(3600)

    async def close(self):
        pass


def _wire_driver():
    driver = MagicMock()
    driver._ws = _NeverRespondingWebSocket()
    driver._msg_id = 0
    driver._pending = {}
    driver._pending_meta = {}
    driver._session_poisoned = False
    driver._poison_lock = asyncio.Lock()
    driver.reconnect_for_send_recovery = AsyncMock()
    return driver


@pytest.mark.asyncio
async def test_response_timeout_poisons_session_with_forensics(caplog):
    """A response-phase timeout must poison the session and dump the other
    in-flight commands (method + age) so the next wedge report identifies
    the culprit instead of just 'timed out'."""
    driver = _wire_driver()
    loop = asyncio.get_running_loop()
    # Another command parked in flight — the forensic dump must name it.
    driver._pending_meta[999] = ("Runtime.evaluate", loop.time() - 12.0)
    transport = CDPTransport(driver)

    with caplog.at_level("ERROR"):
        with pytest.raises(CDPTimeoutError) as excinfo:
            await transport._cdp("Runtime.evaluate", {}, timeout=0.2)

    assert excinfo.value.phase == "response"
    assert driver._session_poisoned is True
    assert "poisoned" in caplog.text
    assert "Runtime.evaluate(age=" in caplog.text


@pytest.mark.asyncio
async def test_next_command_recovers_poisoned_session_before_sending():
    """With the flag set, _cdp reattaches via reconnect_for_send_recovery
    BEFORE writing anything, then proceeds on the fresh session."""
    driver = _wire_driver()
    driver._session_poisoned = True
    transport = CDPTransport(driver)

    # After "recovery", the fresh socket answers normally.
    class _AnsweringWS(_NeverRespondingWebSocket):
        async def send(self, data):
            self.sent.append(data)
            mid = json.loads(data)["id"]
            # Resolve the pending future directly (reader-equivalent).
            fut = driver._pending.get(mid)
            if fut is not None and not fut.done():
                fut.set_result({"id": mid, "result": {"ok": True}})

    driver._ws = _AnsweringWS()

    result = await transport._cdp("Browser.getVersion", {}, timeout=2)

    driver.reconnect_for_send_recovery.assert_awaited_once()
    assert driver._session_poisoned is False
    assert result["result"] == {"ok": True}


@pytest.mark.asyncio
async def test_failed_recovery_rearms_poison_and_propagates():
    """If reattachment fails (target gone), the error propagates and the
    flag is re-armed so the NEXT command retries recovery instead of
    queueing behind the suspect socket."""
    driver = _wire_driver()
    driver._session_poisoned = True
    driver.reconnect_for_send_recovery = AsyncMock(
        side_effect=RuntimeError("original target unavailable")
    )
    transport = CDPTransport(driver)

    with pytest.raises(RuntimeError, match="original target unavailable"):
        await transport._cdp("Browser.getVersion", {}, timeout=2)

    assert driver._session_poisoned is True
    # Nothing was written to the suspect socket.
    assert driver._ws.sent == []


# ── Layer 3: isolated-session fallback for the projection read ───────


def _make_backend_client():
    from chatgpt_web2api.backend_client import BackendClient

    driver = MagicMock()
    driver._access_token = "tok"
    driver._breakers = None
    driver.port = 9222
    driver._js_with_data_strict = AsyncMock()
    driver.ensure_token = AsyncMock(return_value="tok")
    driver._pace = MagicMock()
    driver._pace.pace = AsyncMock()
    driver._pace.read_blocked_seconds = MagicMock(return_value=0.0)
    return BackendClient(driver), driver


@pytest.mark.asyncio
async def test_projection_falls_back_to_isolated_session(monkeypatch):
    """Main-session transport failure must retry the SAME projection template
    on a throwaway session to the conv tab, and the fallback payload flows
    through the normal decode path."""
    client, driver = _make_backend_client()
    driver._js_with_data_strict.side_effect = CDPTimeoutError(
        "Runtime.evaluate", 15, phase="response"
    )
    fallback = AsyncMock(return_value='{"nodes": {"n1": {}}, "current_node": "n1"}')
    monkeypatch.setattr(
        "chatgpt_web2api.conv_dom_read.conv_backend_eval", fallback
    )

    result = await client._fetch_recent_conversation_projection("conv-1")

    assert result == {"nodes": {"n1": {}}, "current_node": "n1"}
    fallback.assert_awaited_once()
    args = fallback.await_args.args
    assert args[0] == 9222  # driver's CDP port
    assert args[1] == "conv-1"
    assert args[3]["token"] == "tok"  # same __D payload as the primary path


@pytest.mark.asyncio
async def test_projection_fallback_failure_reraises_original(monkeypatch):
    """A fallback that also fails carries no diagnostic of its own — the
    ORIGINAL transport error must propagate."""
    client, driver = _make_backend_client()
    original = CDPTimeoutError("Runtime.evaluate", 15, phase="response")
    driver._js_with_data_strict.side_effect = original
    monkeypatch.setattr(
        "chatgpt_web2api.conv_dom_read.conv_backend_eval",
        AsyncMock(return_value=None),
    )

    with pytest.raises(CDPTimeoutError) as excinfo:
        await client._fetch_recent_conversation_projection("conv-1")
    assert excinfo.value is original


@pytest.mark.asyncio
async def test_conv_backend_eval_wraps_data_and_awaits_promise(monkeypatch):
    """conv_backend_eval applies the transport's __D injection contract and
    evaluates with awaitPromise on the fresh session."""
    import chatgpt_web2api.conv_dom_read as cdr

    monkeypatch.setattr(cdr, "_conv_ws_url", lambda port, conv: "ws://127.0.0.1/devtools/page/X")
    captured = {}

    class _FakeWS:
        async def send(self, data):
            captured["frame"] = json.loads(data)

        async def recv(self):
            return json.dumps({"id": 1, "result": {"result": {"value": "v"}}})

    class _FakeConnect:
        async def __aenter__(self):
            return _FakeWS()

        async def __aexit__(self, *exc):
            return False

    import websockets

    monkeypatch.setattr(websockets, "connect", lambda *a, **k: _FakeConnect())

    out = await cdr.conv_backend_eval(9222, "conv-1", "doThing(__D.x)", {"x": 1})
    assert out == "v"
    params = captured["frame"]["params"]
    assert params["awaitPromise"] is True
    assert "__D) => (doThing(__D.x))" in params["expression"]
    assert '{"x": 1}' in params["expression"]


@pytest.mark.asyncio
async def test_conv_tail_state_still_sync_eval(monkeypatch):
    """The DOM-read callers keep the original sync-eval contract (no
    awaitPromise) — only the backend fallback opted into promise awaiting."""
    import chatgpt_web2api.conv_dom_read as cdr

    monkeypatch.setattr(cdr, "_conv_ws_url", lambda port, conv: "ws://127.0.0.1/devtools/page/X")
    captured = {}

    class _FakeWS:
        async def send(self, data):
            captured["frame"] = json.loads(data)

        async def recv(self):
            payload = {"rendered_total": 1, "last_role": "assistant",
                       "generating": False, "generation_signal": None,
                       "tail_text": "hi"}
            return json.dumps({"id": 1, "result": {"result": {"value": json.dumps(payload)}}})

    class _FakeConnect:
        async def __aenter__(self):
            return _FakeWS()

        async def __aexit__(self, *exc):
            return False

    import websockets

    monkeypatch.setattr(websockets, "connect", lambda *a, **k: _FakeConnect())

    state = await cdr.conv_tail_state(9222, "conv-1")
    assert state["last_role"] == "assistant"
    assert "awaitPromise" not in captured["frame"]["params"]
