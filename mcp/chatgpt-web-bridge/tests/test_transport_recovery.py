"""Safety tests for the low-level CDP transport recovery boundary.

The transport is allowed to clean up and classify an interrupted command, but
the driver owns recovery of a potentially mutating send.  These tests keep the
two policies separate: a timeout is typed and bounded, while only an explicit
read-only method may be replayed by the wire layer.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from chatgpt_web2api.cdp_transport import CDPTimeoutError, CDPTransport


class _Driver:
    def __init__(self, ws) -> None:
        self._ws = ws
        self._msg_id = 0
        self._pending = {}
        self.reconnect = AsyncMock()


class _ImmediateWS:
    async def send(self, _payload):
        return None


class _SlowWS:
    def __init__(self, delay: float) -> None:
        self.delay = delay
        self.calls = 0

    async def send(self, _payload):
        self.calls += 1
        await asyncio.sleep(self.delay)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["NotAllowedError", "SecurityError"])
@pytest.mark.parametrize("strict", [False, True])
async def test_browser_permission_exception_names_are_not_soft_failures(kind, strict):
    driver = _Driver(_ImmediateWS())
    driver._cdp = AsyncMock(return_value={
        "result": {"exceptionDetails": {"exception": {"description": f"{kind}: blocked"}}}
    })
    transport = CDPTransport(driver)
    evaluate = transport._js_strict if strict else transport._js
    with pytest.raises(PermissionError):
        await evaluate("document.title")


@pytest.mark.asyncio
async def test_total_timeout_covers_send_and_response_and_cleans_future():
    driver = _Driver(_SlowWS(0.06))
    transport = CDPTransport(driver)

    started = asyncio.get_running_loop().time()
    with pytest.raises(CDPTimeoutError) as caught:
        await transport._cdp("Runtime.evaluate", {"expression": "1"}, timeout=0.1)
    elapsed = asyncio.get_running_loop().time() - started

    assert caught.value.method == "Runtime.evaluate"
    assert caught.value.phase == "response"
    assert elapsed < 0.16
    assert driver._pending == {}
    assert driver.reconnect.await_count == 0


@pytest.mark.asyncio
async def test_send_timeout_is_typed_and_cleans_pending():
    driver = _Driver(_SlowWS(0.2))
    transport = CDPTransport(driver)

    with pytest.raises(CDPTimeoutError) as caught:
        await transport._cdp("Input.dispatchKeyEvent", {}, timeout=0.01)

    assert caught.value.method == "Input.dispatchKeyEvent"
    assert caught.value.phase == "send"
    assert driver._pending == {}
    assert driver.reconnect.await_count == 0


@pytest.mark.asyncio
async def test_pending_future_is_cancelled_on_response_timeout():
    driver = _Driver(_ImmediateWS())
    transport = CDPTransport(driver)

    call = asyncio.create_task(transport._cdp("Runtime.evaluate", {}, timeout=0.01))
    while not driver._pending:
        await asyncio.sleep(0)
    pending_future = next(iter(driver._pending.values()))

    with pytest.raises(CDPTimeoutError):
        await call

    assert pending_future.cancelled()
    assert driver._pending == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["Runtime.evaluate", "Input.dispatchKeyEvent", "Unknown.mutate"])
async def test_unknown_or_mutating_methods_are_never_replayed(method):
    driver = _Driver(_ImmediateWS())

    async def dead_send(_payload):
        raise ConnectionError("connection closed")

    driver._ws.send = dead_send
    transport = CDPTransport(driver)

    with pytest.raises(ConnectionError, match="connection closed"):
        await transport._cdp(method, {}, timeout=0.5)

    assert driver.reconnect.await_count == 0
    assert driver._pending == {}


@pytest.mark.asyncio
async def test_explicit_read_only_method_may_replay_once():
    driver = _Driver(_ImmediateWS())
    calls = 0

    async def send(payload):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ConnectionError("connection closed")
        message_id = __import__("json").loads(payload)["id"]
        future = driver._pending[message_id]
        future.set_result({"id": message_id, "result": {"ok": True}})

    driver._ws.send = send
    transport = CDPTransport(driver)

    result = await transport._cdp("Browser.getVersion", {}, timeout=0.5)

    assert result["result"]["ok"] is True
    assert calls == 2
    driver.reconnect.assert_awaited_once()
    assert driver._pending == {}


@pytest.mark.asyncio
async def test_response_timeout_never_reconnects_even_for_read_only_method():
    driver = _Driver(_ImmediateWS())
    transport = CDPTransport(driver)

    with pytest.raises(CDPTimeoutError) as caught:
        await transport._cdp("Browser.getVersion", {}, timeout=0.01)

    assert caught.value.method == "Browser.getVersion"
    driver.reconnect.assert_not_awaited()


@pytest.mark.asyncio
async def test_cdp_surfaces_permission_error_for_non_js_methods():
    driver = _Driver(_ImmediateWS())
    transport = CDPTransport(driver)

    async def send(payload):
        message_id = __import__("json").loads(payload)["id"]
        driver._pending[message_id].set_result(
            {"id": message_id, "error": {"code": -32000, "message": "Permission denied"}}
        )

    driver._ws.send = send

    with pytest.raises(PermissionError):
        await transport._cdp("Network.enable", {}, timeout=0.5)

    assert driver._pending == {}


@pytest.mark.asyncio
async def test_cdp_keeps_non_permission_error_response_raw():
    driver = _Driver(_ImmediateWS())
    transport = CDPTransport(driver)

    async def send(payload):
        message_id = __import__("json").loads(payload)["id"]
        driver._pending[message_id].set_result(
            {"id": message_id, "error": {"code": -32000, "message": "Method not found"}}
        )

    driver._ws.send = send

    result = await transport._cdp("Network.enable", {}, timeout=0.5)

    assert result["error"]["message"] == "Method not found"


@pytest.mark.asyncio
async def test_js_surfaces_cdp_error_instead_of_returning_empty():
    driver = _Driver(_ImmediateWS())

    async def cdp(*_args, **_kwargs):
        return {"error": {"code": -32000, "message": "Execution context destroyed"}}

    driver._cdp = cdp
    transport = CDPTransport(driver)

    from chatgpt_web2api.cdp_driver import CDPJSError

    with pytest.raises(CDPJSError):
        await transport._js("document.title")


@pytest.mark.asyncio
async def test_js_permission_error_is_not_swallowed():
    driver = _Driver(_ImmediateWS())

    async def cdp(*_args, **_kwargs):
        return {"error": {"code": -32000, "message": "Permission denied"}}

    driver._cdp = cdp
    transport = CDPTransport(driver)

    with pytest.raises(PermissionError):
        await transport._js("document.title")


@pytest.mark.asyncio
async def test_runtime_evaluate_execution_timeout_is_typed():
    driver = _Driver(_ImmediateWS())

    async def cdp(*_args, **_kwargs):
        return {"error": {"code": -32000, "message": "Execution timed out"}}

    driver._cdp = cdp
    transport = CDPTransport(driver)

    with pytest.raises(CDPTimeoutError) as caught:
        await transport._js("await slowThing()", timeout=2)

    assert caught.value.method == "Runtime.evaluate"
    assert caught.value.phase == "cdp"


@pytest.mark.asyncio
async def test_permission_takes_precedence_over_timeout_in_cdp_error():
    driver = _Driver(_ImmediateWS())

    async def cdp(*_args, **_kwargs):
        return {
            "error": {
                "code": -32000,
                "message": "Permission denied while execution timed out",
            }
        }

    driver._cdp = cdp
    transport = CDPTransport(driver)

    with pytest.raises(PermissionError):
        await transport._js("await slowThing()")


@pytest.mark.asyncio
async def test_js_strict_classifies_exception_detail_before_cdp_timeout():
    driver = _Driver(_ImmediateWS())

    async def cdp(*_args, **_kwargs):
        return {
            "result": {
                "exceptionDetails": {
                    "text": "Permission denied after execution timed out",
                }
            }
        }

    driver._cdp = cdp
    transport = CDPTransport(driver)

    with pytest.raises(PermissionError):
        await transport._js_strict("await slowThing()")


@pytest.mark.asyncio
async def test_transport_permission_error_from_socket_propagates():
    driver = _Driver(_ImmediateWS())

    async def cdp(*_args, **_kwargs):
        raise PermissionError("browser denied CDP access")

    driver._cdp = cdp
    transport = CDPTransport(driver)

    with pytest.raises(PermissionError, match="browser denied"):
        await transport._js("document.title")


def test_reconnect_classifier_excludes_typed_application_outcomes():
    assert CDPTransport._should_reconnect(PermissionError("connection closed")) is False
    assert CDPTransport._should_reconnect(
        CDPTimeoutError("Runtime.evaluate", 1, phase="cdp")
    ) is False
