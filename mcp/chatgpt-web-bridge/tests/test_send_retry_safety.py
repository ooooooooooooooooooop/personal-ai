"""Offline regressions for delivery-aware send retries and model selection."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from chatgpt_web2api.api_server import APIServer
from chatgpt_web2api.cdp_driver import (
    CDPDriver,
    DeliveryStage,
    ModelSelectionError,
    RateLimitError,
)
from chatgpt_web2api.resilience import retry_on_rate_limit


class _NullLock:
    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False


def _driver_for_retry() -> MagicMock:
    driver = MagicMock()
    driver.dismiss_rate_limit = AsyncMock(return_value=True)
    driver._pace.record_throttle = MagicMock()
    return driver


@pytest.mark.asyncio
async def test_missing_delivery_evidence_defaults_to_no_retry():
    driver = _driver_for_retry()
    factory = AsyncMock(side_effect=RateLimitError(retry_after=1))
    with pytest.raises(RateLimitError):
        await retry_on_rate_limit(driver, factory)
    factory.assert_awaited_once()
    driver.dismiss_rate_limit.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stage",
    [
        DeliveryStage.SUBMISSION_ATTEMPTED.value,
        DeliveryStage.ACKNOWLEDGED.value,
        DeliveryStage.UNKNOWN.value,
    ],
)
async def test_rate_limit_after_submission_is_never_retried(stage):
    """A rate limit after click must not run the whole send factory again."""

    driver = _driver_for_retry()
    attempts = 0

    async def factory():
        nonlocal attempts
        attempts += 1
        raise RateLimitError(retry_after=1, delivery_stage=stage)

    with pytest.raises(RateLimitError) as caught:
        await retry_on_rate_limit(driver, factory, max_attempts=3, backoff=0)

    assert attempts == 1
    assert caught.value.delivery_stage == stage
    driver.dismiss_rate_limit.assert_not_awaited()


@pytest.mark.asyncio
async def test_pre_send_rate_limit_can_retry():
    """A known pre-send throttle remains transparently retryable."""

    driver = _driver_for_retry()
    attempts = 0

    async def factory():
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RateLimitError(retry_after=0, delivery_stage=DeliveryStage.NOT_STARTED)
        return "ok"

    assert await retry_on_rate_limit(driver, factory, max_attempts=2, backoff=0) == "ok"
    assert attempts == 2
    driver.dismiss_rate_limit.assert_awaited_once()


def test_delivery_metadata_resets_and_annotates_errors():
    """A new send cannot inherit the prior turn's acknowledged state."""

    driver = CDPDriver.__new__(CDPDriver)
    driver._current_conv_id = "conv-old"
    driver._delivery_stage = DeliveryStage.ACKNOWLEDGED.value
    driver._delivery_conversation_id = "conv-old"
    driver._delivery_user_message_id = "user-old"
    driver._delivery_reply_persisted = True

    driver._reset_delivery_metadata()
    assert driver.delivery_metadata == {
        "delivery_stage": DeliveryStage.NOT_STARTED.value,
        "conversation_id": "conv-old",
        "user_message_id": None,
        "reply_persisted": None,
    }

    driver._set_delivery_stage(
        DeliveryStage.UNKNOWN,
        user_message_id="user-new",
    )
    error = RateLimitError(retry_after=2)
    driver._annotate_delivery_error(error)
    assert error.delivery_stage == DeliveryStage.UNKNOWN.value
    assert error.conversation_id == "conv-old"
    assert error.user_message_id == "user-new"
    assert error.retryable is False


@pytest.mark.asyncio
async def test_retry_override_cannot_resend_after_submitted_delivery():
    """A permissive policy callback cannot bypass the delivery safety gate."""

    driver = _driver_for_retry()
    attempts = 0

    async def factory():
        nonlocal attempts
        attempts += 1
        raise RateLimitError(
            retry_after=0,
            delivery_stage=DeliveryStage.SUBMISSION_ATTEMPTED,
        )

    with pytest.raises(RateLimitError):
        await retry_on_rate_limit(
            driver,
            factory,
            max_attempts=3,
            backoff=0,
            can_retry=lambda _error: True,
        )

    assert attempts == 1
    driver.dismiss_rate_limit.assert_not_awaited()


@pytest.mark.asyncio
async def test_progress_callback_reports_pre_send_phases_and_accepts_sync_callbacks():
    """The callback API accepts both async and synchronous progress handlers."""

    driver = CDPDriver.__new__(CDPDriver)
    phases = []

    def callback(phase):
        phases.append(phase)

    await driver._notify_send_progress(callback, "pace")
    async def async_callback(phase):
        phases.append(phase)

    await driver._notify_send_progress(async_callback, "input")
    assert phases == ["pace", "input"]


@pytest.mark.asyncio
async def test_select_model_failure_keeps_previous_active_model():
    driver = CDPDriver.__new__(CDPDriver)
    driver._current_model = "gpt-5-5"
    driver._js = AsyncMock(return_value="no picker")

    assert await driver.select_model("gpt-5-mini") is False
    assert driver._current_model == "gpt-5-5"


@pytest.mark.asyncio
async def test_select_model_matching_contract_rejects_slug_prefix_candidates():
    """Picker matching must use a complete normalized label, never a prefix."""

    driver = CDPDriver.__new__(CDPDriver)
    driver._current_model = "gpt-5-5"
    driver._js = AsyncMock(return_value="clicked")
    driver._js_with_data = AsyncMock(return_value="not-found")
    driver._js_strict = AsyncMock(return_value="")

    assert await driver.select_model("gpt-5") is False
    assert driver._current_model == "gpt-5-5"
    expression = driver._js_with_data.await_args.args[0]
    assert "norm(labels[j]) === target" in expression
    assert "indexOf(__D.slug)" not in expression


def test_model_selection_error_is_machine_readable():
    error = ModelSelectionError("gpt-unknown")
    server = APIServer.__new__(APIServer)
    response = server._error_response(error)
    body = json.loads(response.body)
    assert response.status == 400
    assert body["error"]["code"] == "model_not_available"
    assert body["error"]["requested_model"] == "gpt-unknown"


@pytest.mark.asyncio
async def test_rest_routes_before_model_selection_and_fails_closed(monkeypatch):
    """Navigation cannot reset a requested model into a silent fallback."""

    import chatgpt_web2api.api_server as api_module

    config = api_module.Config.load(None)
    driver = MagicMock()
    driver._current_conv_id = None
    driver._current_model = "gpt-5-5"
    driver._access_token = "test"
    driver.is_connected = True
    driver.adopt_conversation_tab = AsyncMock()
    order = []

    async def route(**kwargs):
        order.append("route")
        return "new"

    async def select(_slug):
        order.append("select")
        return False

    driver.route_chat_target = route
    driver.select_model = select
    server = APIServer(config, driver)
    monkeypatch.setattr(api_module, "MutationLock", _NullLock)
    monkeypatch.setattr(api_module.conv_binding, "gate_check", AsyncMock(return_value=None))

    request = MagicMock()
    request.headers = {}
    request.json = AsyncMock(
        return_value={
            "messages": [{"role": "user", "content": "hello"}],
            "model": "gpt-5-mini",
            "stream": False,
        }
    )

    response = await server._handle_chat(request)
    body = json.loads(response.body)
    assert response.status == 400
    assert body["error"]["code"] == "model_not_available"
    assert order == ["route", "select"]
    assert not hasattr(driver, "send_and_stream") or not driver.send_and_stream.called
