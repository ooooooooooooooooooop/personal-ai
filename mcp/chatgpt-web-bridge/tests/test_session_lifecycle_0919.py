"""Offline lifecycle contracts for the CDP transport (2026-09-19).

These tests exercise the socket/reader boundary with real local
``websockets`` connections and small fake drivers.  They intentionally do
not connect to Chrome or ChatGPT.  The tests focus on behavior which cannot
be proven by inspecting the generated JavaScript string: stale readers must
not touch the replacement session, recovery must share one bounded attempt,
and an observation watchdog must never replay the expression.
"""

from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import AsyncMock

import pytest

from chatgpt_web2api.cdp_transport import (
    CDPTimeoutError,
    CDPTransport,
    _EVAL_WATCHDOG_MARKER,
)
from chatgpt_web2api.cdp_driver import CDPDriver


class _LocalDriver:
    def __init__(self, ws=None):
        self._ws = ws
        self._msg_id = 0
        self._pending = {}
        self._pending_meta = {}
        self._session_poisoned = False
        self._poison_lock = asyncio.Lock()
        self.reconnect_for_send_recovery = AsyncMock()


@pytest.mark.asyncio
async def test_stale_reader_dies_without_failing_replacement_pending_and_routes_concurrently():
    """A real local websocket reproduces the reconnect race.

    The first server connection is held open while a second connection is
    attached.  Once the driver points at the second socket, closing the first
    one must not poison or fail the second session.  The replacement reader
    then routes two responses sent in reverse order to their own futures.
    """

    websockets = pytest.importorskip("websockets")
    old_ready = asyncio.Event()
    new_ready = asyncio.Event()
    close_old = asyncio.Event()
    send_new_responses = asyncio.Event()
    connection_count = 0

    async def handler(conn):
        nonlocal connection_count
        connection_count += 1
        index = connection_count
        if index == 1:
            old_ready.set()
            await close_old.wait()
            await conn.close()
            return

        new_ready.set()
        frames = []
        try:
            while len(frames) < 2:
                frames.append(json.loads(await conn.recv()))
            await send_new_responses.wait()
            for frame in reversed(frames):
                await conn.send(
                    json.dumps(
                        {
                            "id": frame["id"],
                            "result": {"method": frame["method"]},
                        }
                    )
                )
        finally:
            await conn.close()

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        uri = f"ws://127.0.0.1:{port}"
        old_ws = await websockets.connect(uri)
        driver = _LocalDriver(old_ws)
        transport = CDPTransport(driver)
        old_reader = asyncio.create_task(transport._reader_loop())
        await asyncio.wait_for(old_ready.wait(), 1)

        new_ws = await websockets.connect(uri)
        await asyncio.wait_for(new_ready.wait(), 1)
        driver._ws = new_ws
        new_reader = asyncio.create_task(transport._reader_loop())

        first = asyncio.create_task(
            transport._cdp("Browser.getVersion", timeout=1)
        )
        second = asyncio.create_task(
            transport._cdp("Target.getTargets", timeout=1)
        )
        # Both frames are buffered by the server, but neither response is
        # released until after the stale reader has died.
        await asyncio.sleep(0)
        close_old.set()
        await asyncio.wait_for(old_reader, 1)
        assert driver._session_poisoned is False
        assert not first.done() or not second.done()

        send_new_responses.set()
        first_result, second_result = await asyncio.gather(first, second)
        assert first_result["result"]["method"] == "Browser.getVersion"
        assert second_result["result"]["method"] == "Target.getTargets"
        assert driver._pending == {}

        new_reader.cancel()
        try:
            await new_reader
        except asyncio.CancelledError:
            pass
        await new_ws.close()


@pytest.mark.asyncio
async def test_cdp_driver_stop_start_fault_injection_rebinds_local_socket():
    """Exercise the real CDPDriver lifecycle helpers against local websockets."""

    websockets = pytest.importorskip("websockets")
    old_ready = asyncio.Event()
    new_ready = asyncio.Event()
    close_old = asyncio.Event()
    connection_count = 0

    async def handler(conn):
        nonlocal connection_count
        connection_count += 1
        if connection_count == 1:
            old_ready.set()
            await close_old.wait()
            await conn.close()
            return
        new_ready.set()
        try:
            frame = json.loads(await conn.recv())
            await conn.send(
                json.dumps(
                    {"id": frame["id"], "result": {"rebound": True}}
                )
            )
        finally:
            await conn.close()

    async with websockets.serve(handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        uri = f"ws://127.0.0.1:{port}"
        driver = CDPDriver.__new__(CDPDriver)
        driver._ws = None
        driver._reader_task = None
        driver._pending = {}
        driver._pending_meta = {}
        driver._session_poisoned = False
        driver._msg_id = 0
        driver._transport = CDPTransport(driver)

        old_ws = await websockets.connect(uri)
        driver._start_cdp_reader(old_ws)
        await asyncio.wait_for(old_ready.wait(), 1)
        pending = asyncio.get_running_loop().create_future()
        driver._pending[99] = pending

        await driver._stop_cdp_session(timeout=1)
        close_old.set()
        assert driver._ws is None
        assert driver._reader_task is None
        assert pending.cancelled()

        new_ws = await websockets.connect(uri)
        await asyncio.wait_for(new_ready.wait(), 1)
        driver._start_cdp_reader(new_ws)
        result = await driver._cdp("Browser.getVersion", timeout=1)
        assert result["result"] == {"rebound": True}

        await driver._stop_cdp_session(timeout=0)


@pytest.mark.asyncio
async def test_poison_recovery_is_bounded_by_the_original_command_budget():
    """The fixed 15-second driver recovery allowance cannot extend a short CDP call."""

    class _WS:
        sent = []

        async def send(self, payload):
            self.sent.append(payload)

    driver = _LocalDriver(_WS())
    transport = CDPTransport(driver)
    driver._session_poisoned = True
    cancelled = asyncio.Event()

    async def slow_recovery():
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    driver.reconnect_for_send_recovery = slow_recovery
    started = time.monotonic()
    with pytest.raises(CDPTimeoutError) as caught:
        await transport._cdp("Browser.getVersion", timeout=0.04)
    elapsed = time.monotonic() - started

    assert caught.value.phase == "reconnect"
    assert elapsed < 0.2
    assert cancelled.is_set()
    assert driver._session_poisoned is True
    assert driver._ws.sent == []


@pytest.mark.asyncio
async def test_concurrent_commands_wait_for_one_poison_recovery_before_sending():
    """A second caller cannot write while the recovery owner has a fresh socket half-built."""

    class _WS:
        def __init__(self):
            self.sent = []

        async def send(self, payload):
            self.sent.append(payload)
            frame = json.loads(payload)
            future = driver._pending.get(frame["id"])
            if future is not None and not future.done():
                future.set_result(
                    {"id": frame["id"], "result": {"method": frame["method"]}}
                )

    old_ws = _WS()
    new_ws = _WS()
    driver = _LocalDriver(old_ws)
    transport = CDPTransport(driver)
    driver._session_poisoned = True
    recovery_started = asyncio.Event()
    release_recovery = asyncio.Event()
    recovery_calls = 0

    async def recovery():
        nonlocal recovery_calls
        recovery_calls += 1
        recovery_started.set()
        await release_recovery.wait()
        driver._ws = new_ws

    driver.reconnect_for_send_recovery = recovery
    first = asyncio.create_task(
        transport._cdp("Browser.getVersion", timeout=1)
    )
    await asyncio.wait_for(recovery_started.wait(), 1)
    second = asyncio.create_task(
        transport._cdp("Target.getTargets", timeout=1)
    )
    await asyncio.sleep(0.03)
    assert old_ws.sent == []
    assert not second.done()

    release_recovery.set()
    first_result, second_result = await asyncio.gather(first, second)
    assert recovery_calls == 1
    assert first_result["result"]["method"] == "Browser.getVersion"
    assert second_result["result"]["method"] == "Target.getTargets"
    assert len(new_ws.sent) == 2


@pytest.mark.asyncio
async def test_watchdog_marks_unknown_fate_and_never_replays_evaluate():
    """Promise.race only ends observation; an ambiguous evaluate is never resent."""

    driver = _LocalDriver()
    calls = []

    async def cdp(method, params=None, timeout=15, _retry=True):
        calls.append((method, params))
        return {
            "result": {
                "exceptionDetails": {
                    "text": f"Uncaught Error: {_EVAL_WATCHDOG_MARKER}"
                }
            }
        }

    driver._cdp = cdp
    transport = CDPTransport(driver)
    with pytest.raises(CDPTimeoutError) as caught:
        await transport._js("performIrreversibleAction()", timeout=0.5)

    assert caught.value.phase == "cdp"
    assert driver._session_poisoned is True
    assert len(calls) == 1
    assert calls[0][0] == "Runtime.evaluate"
