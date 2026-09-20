"""Poison self-heal and the send wrapper must not multiply retries."""
import asyncio
import json
from unittest.mock import AsyncMock

import pytest

from chatgpt_web2api.cdp_driver import CDPDriver
from chatgpt_web2api.cdp_transport import CDPTimeoutError
from chatgpt_web2api.send_recovery import run_with_send_recovery


def driver_with_responses():
    driver = CDPDriver()
    driver._session_poisoned = True

    class Socket:
        async def send(self, raw):
            msg = json.loads(raw)
            driver._pending[msg["id"]].set_result({"id": msg["id"], "result": {"result": {"value": 42}}})

    driver._ws = Socket()
    driver.reconnect_for_send_recovery = AsyncMock()
    return driver


async def test_transport_recovery_consumes_send_wrapper_allowance():
    driver = driver_with_responses()
    calls = 0

    async def preflight():
        nonlocal calls
        calls += 1
        assert await driver._js_strict("42") == 42
        raise CDPTimeoutError("Runtime.evaluate", 1)

    with pytest.raises(CDPTimeoutError) as caught:
        await run_with_send_recovery(driver, preflight)
    assert calls == 1
    assert caught.value.recovery_attempts == 1
    assert caught.value.delivery_stage == "not_started"
    driver.reconnect_for_send_recovery.assert_awaited_once()


async def test_second_poison_in_same_send_cannot_reconnect_again():
    driver = driver_with_responses()

    async def preflight():
        assert await driver._js_strict("42") == 42
        driver._session_poisoned = True
        await driver._js_strict("42")

    with pytest.raises(CDPTimeoutError) as caught:
        await run_with_send_recovery(driver, preflight)
    assert caught.value.phase == "recovery_exhausted"
    assert driver._session_poisoned is True
    driver.reconnect_for_send_recovery.assert_awaited_once()


async def test_recovery_sanity_probe_runs_in_same_task_without_deadlock():
    driver = driver_with_responses()

    async def recovery(*, timeout=None):
        # The shipping reconnect uses a sanity Runtime.evaluate. If transport
        # wait_for starts this in a child task, it waits on its own poison lock.
        driver._session_poisoned = False
        assert await driver._js_strict("42", timeout=0.1) == 42

    driver.reconnect_for_send_recovery = AsyncMock(side_effect=recovery)
    async with asyncio.timeout(0.5):
        assert await driver._js_strict("42", timeout=0.3) == 42
    driver.reconnect_for_send_recovery.assert_awaited_once()
