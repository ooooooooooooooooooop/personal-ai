"""Exercise real send orchestration and target reattachment with offline I/O."""
import asyncio
import io
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from chatgpt_web2api.cdp_driver import CDPDriver, SendReadinessError, StreamChunk
from chatgpt_web2api.cdp_transport import CDPTimeoutError
from chatgpt_web2api.turn_anchor import TurnAnchor, TurnTextResult
from chatgpt_web2api.identity_listener import CaptureResult, IdentityListener


CONV = "11111111-2222-4333-8444-555555555555"
URL = f"https://chatgpt.com/c/{CONV}"


def send_driver():
    driver = CDPDriver(cdp_port=9222)
    driver._identity_listener = None
    driver._current_conv_id = None
    driver._wait_for_send_composer = AsyncMock()
    driver._read_assistant_count_baseline = AsyncMock(return_value=0)
    driver._capture_pre_send_fallback_anchor = AsyncMock(
        return_value=TurnAnchor(sent_text="continue", mode="fresh_chat")
    )
    driver._pace.pace = AsyncMock()
    driver.type_message = AsyncMock()
    driver.reconnect_for_send_recovery = AsyncMock()
    driver._verify_send_acknowledged = AsyncMock(return_value=True)
    driver._js_strict = AsyncMock(return_value=URL)
    driver._fetch_text_for_turn = AsyncMock(return_value=TurnTextResult("matched", "ok"))
    driver._clear_composer = AsyncMock()

    async def complete(**kwargs):
        yield StreamChunk("ok")

    driver._completion = SimpleNamespace(
        stream_until_complete=complete, last_dom_text="ok", had_non_text_content=False,
    )
    return driver


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_phase", ["baseline", "input", "button_probe"])
async def test_pre_submit_timeout_rebuilds_but_clicks_only_once(failure_phase):
    driver = send_driver()
    fault = CDPTimeoutError("Runtime.evaluate")
    if failure_phase == "baseline":
        driver._read_assistant_count_baseline.side_effect = [fault, 0]
    if failure_phase == "input":
        driver.type_message.side_effect = [fault, None]
    expressions = []

    async def evaluate(expr, **kwargs):
        expressions.append(expr)
        if failure_phase == "button_probe" and len(expressions) == 1:
            raise fault
        return "sent" if "dispatchEvent" in expr else "yes"

    driver._js = evaluate
    chunks = [chunk async for chunk in driver.send_and_stream("continue")]
    assert chunks[-1].finish_reason == "stop"
    driver.reconnect_for_send_recovery.assert_awaited_once()
    assert sum("dispatchEvent" in expr for expr in expressions) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_phase", ["click", "ack"])
async def test_post_submit_timeout_checks_receipt_without_second_click(failure_phase):
    driver = send_driver()
    expressions = []

    async def evaluate(expr, **kwargs):
        expressions.append(expr)
        if "dispatchEvent" in expr and failure_phase == "click":
            raise CDPTimeoutError("Runtime.evaluate")
        return "sent" if "dispatchEvent" in expr else "yes"

    driver._js = evaluate
    if failure_phase == "ack":
        driver._verify_send_acknowledged.side_effect = CDPTimeoutError("Runtime.evaluate")
    with pytest.raises(CDPTimeoutError) as caught:
        _ = [chunk async for chunk in driver.send_and_stream("continue")]
    assert caught.value.delivery_stage == "unknown"
    assert caught.value.receipt_check["reason"] == "exact_turn_identity_unavailable"
    assert sum("dispatchEvent" in expr for expr in expressions) == 1
    driver.reconnect_for_send_recovery.assert_not_awaited()
    driver._clear_composer.assert_not_awaited()


@pytest.mark.asyncio
async def test_input_failure_does_not_outer_clear_user_draft():
    """The DOM owns cleanup when type_message itself fails.

    The orchestration layer must not add a second, blind clear while the
    input mutation is still unverified; doing so could erase a user draft
    that the bridge never owned.
    """
    driver = send_driver()
    dom_clear = AsyncMock(return_value=True)
    driver._dom._clear_composer = dom_clear

    async def fail_inside_dom(_text):
        await dom_clear("composer-selector")
        raise SendReadinessError("composer verification failed")

    driver._dom.type_message = fail_inside_dom
    driver.type_message = CDPDriver.type_message.__get__(driver, CDPDriver)

    with pytest.raises(SendReadinessError, match="verification failed"):
        _ = [chunk async for chunk in driver.send_and_stream("continue")]

    dom_clear.assert_awaited_once_with("composer-selector")
    driver._clear_composer.assert_not_awaited()


@pytest.mark.asyncio
async def test_verified_input_ordinary_pre_submit_failure_clears_once():
    """Once type_message verified exact input, a later ordinary pre-submit
    failure owns a safe cleanup attempt; the error is still propagated."""
    driver = send_driver()
    driver.type_message = AsyncMock(return_value=None)
    driver.click_send = AsyncMock(side_effect=RuntimeError("button script rejected"))

    with pytest.raises(RuntimeError, match="button script rejected"):
        _ = [chunk async for chunk in driver.send_and_stream("continue")]

    driver._clear_composer.assert_awaited_once_with()


def reconnect_driver(monkeypatch, *, target="original", url=URL):
    driver = CDPDriver(cdp_port=9222)
    driver._target_id = "original"
    driver._current_conv_id = CONV
    driver._js_strict = AsyncMock(return_value=url)
    driver._identity_listener = SimpleNamespace(detach=lambda: None, attach=AsyncMock())
    driver._reader_loop = AsyncMock()
    driver._create_owned_tab = AsyncMock()
    driver._adopt_existing_chatgpt_tab = AsyncMock()
    driver.navigate_conversation = AsyncMock()
    targets = [{"id": target, "type": "page", "url": url,
                "webSocketDebuggerUrl": f"ws://127.0.0.1:9222/devtools/page/{target}"}]
    monkeypatch.setattr("chatgpt_web2api.cdp_driver.urllib.request.urlopen",
                        lambda *args, **kwargs: io.BytesIO(json.dumps(targets).encode()))
    connect = AsyncMock(return_value=SimpleNamespace(close=AsyncMock()))
    monkeypatch.setattr("chatgpt_web2api.cdp_driver.websockets.connect", connect)
    return driver, connect


@pytest.mark.asyncio
async def test_reconnect_reattaches_original_without_refresh_or_creation(monkeypatch):
    driver, connect = reconnect_driver(monkeypatch)
    await driver.reconnect_for_send_recovery()
    connect.assert_awaited_once()
    assert connect.await_args.args[0].endswith("/original")
    assert driver._current_conv_id == CONV
    driver._create_owned_tab.assert_not_awaited()
    driver._adopt_existing_chatgpt_tab.assert_not_awaited()
    driver.navigate_conversation.assert_not_awaited()
    await driver._reader_task


@pytest.mark.asyncio
@pytest.mark.parametrize("target,url", [("other", URL), ("original", "https://chatgpt.com.evil.test/")])
async def test_reconnect_refuses_target_or_origin_drift(monkeypatch, target, url):
    driver, connect = reconnect_driver(monkeypatch, target=target, url=url)
    with pytest.raises(Exception, match="target|identity|origin"):
        await driver.reconnect_for_send_recovery()
    connect.assert_not_awaited()
    driver._create_owned_tab.assert_not_awaited()


@pytest.mark.asyncio
async def test_reconnect_deadline_cancels_a_hung_handshake(monkeypatch):
    driver, connect = reconnect_driver(monkeypatch)
    entered = asyncio.Event()

    async def hang(*args, **kwargs):
        entered.set()
        await asyncio.Event().wait()

    connect.side_effect = hang
    real_timeout = asyncio.timeout
    budgets = []

    def short_timeout(budget):
        budgets.append(budget)
        return real_timeout(0.05)

    monkeypatch.setattr("chatgpt_web2api.cdp_driver.asyncio.timeout", short_timeout)
    with pytest.raises(TimeoutError):
        await driver.reconnect_for_send_recovery()
    assert budgets[0] == 15
    # Failure cleanup cancels the reader/pending state synchronously and
    # schedules socket close without adding a second lifecycle budget.
    assert budgets == [15]
    assert entered.is_set()
    connect.assert_awaited_once()
    driver._create_owned_tab.assert_not_awaited()


@pytest.mark.asyncio
async def test_capture_wait_timeout_preserves_late_receipt():
    listener = IdentityListener(SimpleNamespace())
    scope = listener.arm_capture_scope(
        expected_text_hash="hash", conversation_id=CONV, target_id="original",
    )
    assert await listener.wait_for_captured_uuid(timeout=0.001) is None
    assert not scope.future.done()
    scope._resolve(CaptureResult(uuid="late-user"))
    assert scope.future.result().uuid == "late-user"
    scope.close()


@pytest.mark.asyncio
async def test_receipt_read_has_single_eight_second_deadline(monkeypatch):
    driver = send_driver()
    driver._delivery_conversation_id = CONV
    driver._delivery_user_message_id = "new-user"
    driver._delivery_stage = "submission_attempted"

    async def hang(*args):
        await asyncio.Event().wait()

    driver._backend_client._fetch_recent_conversation_projection = hang
    real_timeout = asyncio.timeout
    budgets = []

    def short_timeout(budget):
        budgets.append(budget)
        return real_timeout(0.01)

    monkeypatch.setattr("chatgpt_web2api.cdp_driver.asyncio.timeout", short_timeout)
    result = await driver._check_failed_send_receipt(None, TurnAnchor("continue", "fresh_chat"))
    assert budgets == [8]
    assert result == {"status": "post_observed", "retry_safe": False, "reason": "TimeoutError"}
    driver.reconnect_for_send_recovery.assert_not_awaited()
