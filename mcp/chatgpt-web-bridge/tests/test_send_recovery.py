"""Safety regressions for the bounded pre-submit send recovery.

These tests deliberately use fake drivers and projected conversation data.  A
recovery retry must rebuild the operation from the top after a typed
``Runtime.evaluate`` transport timeout; it must never replay the CDP command
that may already have had an effect in the browser.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

import chatgpt_web2api.cdp_driver as cdp_driver_module
import chatgpt_web2api.chatgpt_dom as chatgpt_dom_module
from chatgpt_web2api.cdp_driver import CDPDriver, DeliveryStage
from chatgpt_web2api.chatgpt_dom import ChatGPTDom
from chatgpt_web2api.cdp_transport import CDPTimeoutError
from chatgpt_web2api.identity_listener import CaptureResult
from chatgpt_web2api.send_recovery import (
    RecoveryBudget,
    is_recoverable_transport_error,
    recover_before_submission,
    run_with_send_recovery,
)
from chatgpt_web2api.turn_anchor import TurnAnchor


class _FakeDriver:
    """Only the delivery/reconnect seam used by ``send_recovery``."""

    def __init__(self, stage: str = DeliveryStage.NOT_STARTED.value):
        self._delivery_stage = stage
        self._delivery_conversation_id = "conv-1"
        self._delivery_user_message_id = None
        self._delivery_reply_persisted = None
        self.reconnect_for_send_recovery = AsyncMock()
        self.progress = []

    @property
    def delivery_metadata(self):
        return {
            "delivery_stage": self._delivery_stage,
            "conversation_id": self._delivery_conversation_id,
            "user_message_id": self._delivery_user_message_id,
            "reply_persisted": self._delivery_reply_persisted,
        }

    def _reset_delivery_metadata(self):
        self._delivery_stage = DeliveryStage.NOT_STARTED.value
        self._delivery_user_message_id = None
        self._delivery_reply_persisted = None

    def _annotate_delivery_error(self, exc):
        exc.delivery_stage = self._delivery_stage
        exc.conversation_id = self._delivery_conversation_id
        exc.user_message_id = self._delivery_user_message_id

    async def _notify_send_progress(self, callback, phase):
        self.progress.append(phase)
        if callback is not None:
            result = callback(phase)
            if asyncio.iscoroutine(result):
                await result


def _runtime_timeout() -> CDPTimeoutError:
    return CDPTimeoutError("Runtime.evaluate", 0.01, phase="response")


@pytest.mark.asyncio
async def test_nested_recovery_scopes_share_one_reconnect_budget():
    """MCP/REST and driver wrappers cannot each spend a retry."""

    driver = _FakeDriver()
    calls = 0

    async def operation():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise _runtime_timeout()
        return "recovered"

    async def nested_operation():
        return await run_with_send_recovery(driver, operation)

    assert await run_with_send_recovery(driver, nested_operation) == "recovered"
    assert calls == 2
    driver.reconnect_for_send_recovery.assert_awaited_once()


@pytest.mark.asyncio
async def test_not_started_timeout_rebuilds_once_then_stops():
    """The first pre-submit timeout may recover; a second one cannot loop."""

    driver = _FakeDriver()
    calls = 0

    async def operation():
        nonlocal calls
        calls += 1
        raise _runtime_timeout()

    with pytest.raises(CDPTimeoutError):
        await run_with_send_recovery(driver, operation)

    assert calls == 2
    driver.reconnect_for_send_recovery.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stage",
    [
        DeliveryStage.SUBMISSION_ATTEMPTED.value,
        DeliveryStage.ACKNOWLEDGED.value,
        DeliveryStage.UNKNOWN.value,
    ],
)
async def test_possible_submission_never_reconnects_or_replays(stage):
    """Once the click boundary is crossed, recovery is fail-closed."""

    driver = _FakeDriver(stage)
    budget = RecoveryBudget(driver)
    error = _runtime_timeout()

    assert await recover_before_submission(driver, error, budget) is False
    driver.reconnect_for_send_recovery.assert_not_awaited()
    assert budget.attempts == 0


@pytest.mark.asyncio
async def test_cancellation_is_never_recovered():
    driver = _FakeDriver()

    async def cancelled():
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await run_with_send_recovery(driver, cancelled)

    driver.reconnect_for_send_recovery.assert_not_awaited()


@pytest.mark.asyncio
async def test_permission_denial_is_never_recovered():
    driver = _FakeDriver()

    async def denied():
        raise PermissionError("browser permission denied")

    with pytest.raises(PermissionError):
        await run_with_send_recovery(driver, denied)

    driver.reconnect_for_send_recovery.assert_not_awaited()


def test_only_runtime_evaluate_timeout_is_recoverable():
    assert is_recoverable_transport_error(_runtime_timeout()) is True
    assert (
        is_recoverable_transport_error(
            CDPTimeoutError("Input.dispatchKeyEvent", 0.01, phase="response")
        )
        is False
    )
    assert is_recoverable_transport_error(PermissionError("connection closed")) is False
    assert is_recoverable_transport_error(RuntimeError("connection closed")) is False
    assert is_recoverable_transport_error(ConnectionError("connection closed")) is True


@pytest.mark.asyncio
async def test_late_post_capture_is_consumed_within_receipt_budget():
    driver = _driver_for_receipt({"nodes": {"new-user": {"id": "new-user", "role": "user"}}})
    future = asyncio.get_running_loop().create_future()
    asyncio.get_running_loop().call_soon(future.set_result, CaptureResult(uuid="new-user"))
    result = await driver._check_failed_send_receipt(
        SimpleNamespace(future=future), TurnAnchor(sent_text="continue", mode="fresh_chat")
    )
    assert result["status"] == "user_message_persisted"
    assert driver._delivery_user_message_id == "new-user"
    driver._backend_client._fetch_recent_conversation_projection.assert_awaited_once()


@pytest.mark.asyncio
async def test_target_drift_does_not_replay_after_failed_reconnect():
    """A same-target recovery failure must stop; it cannot fall back to a new tab."""

    driver = _FakeDriver()
    driver.reconnect_for_send_recovery.side_effect = RuntimeError("target drift")
    calls = 0

    async def operation():
        nonlocal calls
        calls += 1
        raise _runtime_timeout()

    with pytest.raises(RuntimeError, match="target drift") as caught:
        await run_with_send_recovery(driver, operation)

    assert calls == 1
    driver.reconnect_for_send_recovery.assert_awaited_once()
    assert isinstance(caught.value.__cause__, CDPTimeoutError)


def _driver_for_receipt(projection: dict) -> CDPDriver:
    driver = CDPDriver.__new__(CDPDriver)
    driver._delivery_stage = DeliveryStage.SUBMISSION_ATTEMPTED.value
    driver._delivery_conversation_id = "conv-1"
    driver._delivery_user_message_id = None
    driver._delivery_reply_persisted = None
    driver._current_conv_id = "conv-1"
    driver._backend_client = SimpleNamespace(
        _fetch_recent_conversation_projection=AsyncMock(return_value=projection)
    )
    return driver


def _capture_scope_with_uuid(uuid: str):
    future = asyncio.get_event_loop().create_future()
    future.set_result(CaptureResult(uuid=uuid, reason="matched"))
    return SimpleNamespace(future=future)


@pytest.mark.asyncio
async def test_duplicate_prompt_does_not_upgrade_receipt_without_exact_uuid():
    """Same text in an older user node is not proof that this send persisted."""

    projection = {
        "nodes": {
            "old-user": {
                "id": "old-user",
                "role": "user",
                "text": "continue",
                "children": ["old-assistant"],
                "create_time": 10,
            },
            "old-assistant": {
                "id": "old-assistant",
                "role": "assistant",
                "text": "old answer",
                "content_type": "text",
                "end_turn": True,
                "create_time": 11,
            },
        }
    }
    driver = _driver_for_receipt(projection)
    anchor = TurnAnchor(sent_text="continue", mode="existing_conversation")
    receipt = await driver._check_failed_send_receipt(
        _capture_scope_with_uuid("new-user"), anchor
    )

    assert receipt["status"] == "post_observed"
    assert receipt["retry_safe"] is False
    assert receipt["reason"] == "captured_node_not_visible_yet"
    assert driver._delivery_reply_persisted is None
    driver._backend_client._fetch_recent_conversation_projection.assert_awaited_once()


@pytest.mark.asyncio
async def test_exact_uuid_receipt_can_confirm_persistence():
    projection = {
        "nodes": {
            "new-user": {
                "id": "new-user",
                "role": "user",
                "text": "continue",
                "children": ["new-assistant"],
                "create_time": 20,
            },
            "new-assistant": {
                "id": "new-assistant",
                "role": "assistant",
                "text": "new answer",
                "content_type": "text",
                "end_turn": True,
                "create_time": 21,
            },
        }
    }
    driver = _driver_for_receipt(projection)
    anchor = TurnAnchor(sent_text="continue", mode="existing_conversation")
    receipt = await driver._check_failed_send_receipt(
        _capture_scope_with_uuid("new-user"), anchor
    )

    assert receipt["status"] == "reply_persisted"
    assert driver._delivery_reply_persisted is True


class _ClickDriver:
    def __init__(self, results):
        self._results = list(results)
        self._delivery_stage = DeliveryStage.NOT_STARTED.value
        self._breakers = None

    async def _js(self, _script, **_kwargs):
        result = self._results.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result

    def _set_delivery_stage(self, stage, **_kwargs):
        self._delivery_stage = stage.value if isinstance(stage, DeliveryStage) else stage

    async def _capture_selector_diagnostic(self, _selector):
        return None


@pytest.mark.asyncio
async def test_click_readiness_timeout_remains_pre_submit(monkeypatch):
    """A timeout in the read-only button probe is safe to recover once."""

    monkeypatch.setattr(chatgpt_dom_module, "SEND_BUTTON_POLL_MAX_WAIT_S", 1)
    driver = _ClickDriver([_runtime_timeout()])

    with pytest.raises(CDPTimeoutError):
        await ChatGPTDom(driver).click_send()

    assert driver._delivery_stage == DeliveryStage.NOT_STARTED.value


@pytest.mark.asyncio
async def test_click_dispatch_timeout_is_post_submit_and_never_replayed(monkeypatch):
    """The boundary is set immediately before the mutating JS evaluation."""

    monkeypatch.setattr(chatgpt_dom_module, "SEND_BUTTON_POLL_MAX_WAIT_S", 1)
    driver = _ClickDriver(["yes", _runtime_timeout()])

    with pytest.raises(CDPTimeoutError):
        await ChatGPTDom(driver).click_send()

    assert driver._delivery_stage == DeliveryStage.SUBMISSION_ATTEMPTED.value


@pytest.mark.asyncio
async def test_receipt_waits_for_late_capture_uuid_before_backend_lookup():
    """A UUID arriving just after dispatch is still usable as receipt evidence."""

    projection = {
        "nodes": {
            "new-user": {
                "id": "new-user",
                "role": "user",
                "text": "continue",
                "children": ["new-assistant"],
                "create_time": 20,
            },
            "new-assistant": {
                "id": "new-assistant",
                "role": "assistant",
                "text": "new answer",
                "content_type": "text",
                "end_turn": True,
                "create_time": 21,
            },
        }
    }
    driver = _driver_for_receipt(projection)
    anchor = TurnAnchor(sent_text="continue", mode="existing_conversation")
    future = asyncio.get_running_loop().create_future()
    scope = SimpleNamespace(future=future)

    async def publish_uuid():
        await asyncio.sleep(0)
        future.set_result(CaptureResult(uuid="new-user", reason="matched"))

    publisher = asyncio.create_task(publish_uuid())
    try:
        receipt = await driver._check_failed_send_receipt(scope, anchor)
    finally:
        await publisher

    assert receipt["status"] == "reply_persisted"
    assert driver._delivery_user_message_id == "new-user"


class _HTTPResponse:
    def __init__(self, body):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self._body


@pytest.mark.asyncio
async def test_send_reconnect_reattaches_only_original_target(monkeypatch):
    """Recovery uses one exact page target and performs no target/navigation action."""

    target_id = "target-1"
    port = 9222
    target = {
        "id": target_id,
        "type": "page",
        "url": "https://chatgpt.com/c/conv-1",
        "webSocketDebuggerUrl": (
            f"ws://127.0.0.1:{port}/devtools/page/{target_id}"
        ),
    }
    old_ws = SimpleNamespace(close=AsyncMock())
    new_ws = SimpleNamespace(close=AsyncMock())
    driver = CDPDriver.__new__(CDPDriver)
    driver.port = port
    driver._target_id = target_id
    driver._current_conv_id = "conv-1"
    driver._reader_task = None
    driver._pending = {}
    driver._ws = old_ws
    driver._identity_listener = None
    driver._js_strict = AsyncMock(return_value=target["url"])

    async def finished_reader():
        return None

    driver._reader_loop = finished_reader
    discover_response = _HTTPResponse(json.dumps([target]).encode())
    connect = AsyncMock(return_value=new_ws)
    requested_budgets = []
    original_timeout = cdp_driver_module.asyncio.timeout

    def recording_timeout(seconds):
        requested_budgets.append(seconds)
        return original_timeout(0.25)

    monkeypatch.setattr(cdp_driver_module.asyncio, "timeout", recording_timeout)
    with patch.object(cdp_driver_module.urllib.request, "urlopen", return_value=discover_response), \
            patch.object(cdp_driver_module.websockets, "connect", connect):
        await driver.reconnect_for_send_recovery()

    assert requested_budgets == [15]
    connect.assert_awaited_once_with(
        target["webSocketDebuggerUrl"],
        max_size=100 * 1024 * 1024,
        ping_interval=20,
        ping_timeout=10,
        open_timeout=5,
        close_timeout=1,
    )
    old_ws.close.assert_awaited_once()
    assert driver._target_id == target_id
    driver._js_strict.assert_awaited_once_with("location.href", timeout=3)


@pytest.mark.asyncio
async def test_send_reconnect_refuses_target_drift_without_connecting(monkeypatch):
    target_id = "target-1"
    target = {
        "id": "target-2",
        "type": "page",
        "url": "https://chatgpt.com/c/conv-1",
        "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/target-2",
    }
    driver = CDPDriver.__new__(CDPDriver)
    driver.port = 9222
    driver._target_id = target_id
    driver._current_conv_id = "conv-1"
    driver._reader_task = None
    driver._pending = {}
    driver._ws = None
    driver._identity_listener = None
    driver._js_strict = AsyncMock()
    connect = AsyncMock()
    response = _HTTPResponse(json.dumps([target]).encode())
    with patch.object(cdp_driver_module.urllib.request, "urlopen", return_value=response), \
            patch.object(cdp_driver_module.websockets, "connect", connect):
        with pytest.raises(Exception, match="Original target unavailable"):
            await driver.reconnect_for_send_recovery()
    connect.assert_not_awaited()
