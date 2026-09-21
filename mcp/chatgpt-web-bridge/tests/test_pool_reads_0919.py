"""Focused 2026-09-19 regressions for pool and isolated-read ownership.

All tests use fake factories/sockets. They never attach to Chrome or send a
message to a web account.
"""

from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from chatgpt_web2api import conv_dom_read
from chatgpt_web2api.backend_client import (
    BackendClient,
    BackendReadHTTPError,
    BackendReadTimeoutError,
)
from chatgpt_web2api.cdp_transport import CDPTimeoutError
from chatgpt_web2api.mcp_driver_pool import DriverSlot, McpSessionDriverPool


def _config(*, pool_size=1, acquire_timeout=1.0):
    cfg = MagicMock()
    cfg.chatgpt.mcp_session_pool_size = pool_size
    cfg.chatgpt.mcp_session_pool_ttl_seconds = 100
    cfg.chatgpt.mcp_session_pool_acquire_timeout = acquire_timeout
    cfg.chatgpt.mcp_session_pool_sweep_interval_seconds = 100
    cfg.chatgpt.mcp_session_pool_create_concurrency = 1
    cfg.chatgpt.mcp_account_throttle_cooldown_seconds = 300
    return cfg


@pytest.mark.asyncio
async def test_cancelled_materialization_releases_pending_capacity():
    started = asyncio.Event()
    async def factory(*_args):
        started.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            raise

    pool = McpSessionDriverPool(_config(), driver_factory=factory)
    task = asyncio.create_task(pool._acquire_slot("cancelled"))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert pool._capacity_slots == {}
    assert pool._slots == {}
    assert pool._active_keys == set()
    await pool.close_all()


@pytest.mark.asyncio
async def test_materialize_connect_failure_closes_driver(monkeypatch):
    driver = MagicMock()
    driver.close = AsyncMock()
    pool = McpSessionDriverPool(_config())
    slot = DriverSlot(
        session_key="s",
        driver=None,
        breakers=MagicMock(),
        meta_lock=asyncio.Lock(),
        call_lock=asyncio.Lock(),
        ready_event=asyncio.Event(),
        close_lock=asyncio.Lock(),
    )
    pool._create_driver = AsyncMock(return_value=driver)
    await pool._materialize_slot(slot)
    assert slot.driver is driver
    await pool._close_slot_driver(slot)
    driver.close.assert_awaited_once()


def _patch_ws(monkeypatch, response):
    monkeypatch.setattr(
        conv_dom_read,
        "_conv_ws_url",
        lambda *_args: "ws://127.0.0.1/devtools/page/fake",
    )

    class FakeWS:
        async def send(self, _raw):
            return None

        async def recv(self):
            return json.dumps(response)

    class FakeConnect:
        async def __aenter__(self):
            return FakeWS()

        async def __aexit__(self, *_args):
            return False

    import websockets

    monkeypatch.setattr(websockets, "connect", lambda *a, **k: FakeConnect())


@pytest.mark.asyncio
async def test_dom_protocol_error_is_not_empty(monkeypatch):
    _patch_ws(monkeypatch, {"id": 1, "error": {"message": "Execution context destroyed"}})
    with pytest.raises(conv_dom_read.ConvDOMProtocolError):
        await conv_dom_read.conv_backend_eval(9222, "c", "1", {}, timeout=1)


@pytest.mark.asyncio
async def test_dom_permission_error_is_not_fallback(monkeypatch):
    _patch_ws(monkeypatch, {"id": 1, "error": {"message": "Not allowed by permissions policy"}})
    with pytest.raises(conv_dom_read.ConvDOMPermissionError):
        await conv_dom_read.conv_backend_eval(9222, "c", "1", {}, timeout=1)


@pytest.mark.asyncio
async def test_dom_budget_includes_target_discovery(monkeypatch):
    def slow_discovery(*_args):
        time.sleep(0.15)
        return "ws://never-used"

    monkeypatch.setattr(conv_dom_read, "_conv_ws_url", slow_discovery)
    started = time.monotonic()
    result = await conv_dom_read._eval_on_conv_tab(9222, "c", "1", timeout=0.04)
    elapsed = time.monotonic() - started
    assert result is None
    assert elapsed < 0.2


@pytest.mark.asyncio
async def test_projection_fallback_is_bounded_and_denial_never_falls_back(monkeypatch):
    client_driver = MagicMock()
    client_driver._access_token = "tok"
    client_driver._breakers = None
    client_driver.port = 9222
    client_driver.ensure_token = AsyncMock(return_value="tok")
    client_driver._pace = MagicMock()
    client_driver._pace.pace = AsyncMock()
    client_driver._pace.read_blocked_seconds = MagicMock(return_value=0)
    original = CDPTimeoutError("Runtime.evaluate", 15, phase="response")
    client_driver._js_with_data_strict = AsyncMock(side_effect=original)
    client = BackendClient(client_driver)
    fallback = AsyncMock(return_value='{"nodes": {}, "current_node": null}')
    monkeypatch.setattr("chatgpt_web2api.conv_dom_read.conv_backend_eval", fallback)
    await client._fetch_recent_conversation_projection("c")
    assert fallback.await_args.kwargs["timeout"] <= 3.0

    client_driver._js_with_data_strict = AsyncMock(
        side_effect=PermissionError("browser permission denied")
    )
    fallback.reset_mock()
    with pytest.raises(PermissionError):
        await client._fetch_recent_conversation_projection("c")
    fallback.assert_not_awaited()


async def test_abandon_old_slot_does_not_remove_replacement_from_sweeper_index():
    closing = asyncio.Event()
    release_close = asyncio.Event()

    async def slow_close():
        closing.set()
        await release_close.wait()

    old_driver = MagicMock()
    old_driver.close = slow_close
    replacement = MagicMock()
    replacement.close = AsyncMock()
    pool = McpSessionDriverPool(_config(pool_size=2), driver_factory=AsyncMock(return_value=replacement))
    old = DriverSlot(session_key="same", driver=old_driver, breakers=MagicMock(),
                     meta_lock=asyncio.Lock(), call_lock=asyncio.Lock(),
                     ready_event=asyncio.Event(), close_lock=asyncio.Lock())
    pool._slots["same"] = old
    pool._active_keys.add("same")
    pool._capacity_slots[id(old)] = old
    abandon = asyncio.create_task(pool._abandon_pending_slot(old))
    await asyncio.wait_for(closing.wait(), 1)
    async with pool.acquire("same") as lease:
        assert lease.driver is replacement
        release_close.set()
        await abandon
        assert "same" in pool._active_keys
        assert pool._slots["same"].driver is replacement
        assert id(old) not in pool._capacity_slots
    await pool.close_all()
    replacement.close.assert_awaited_once()


@pytest.mark.parametrize("name", ["_fetch_text_for_turn", "_fetch_end_turn_for_turn"])
async def test_anchored_read_wrappers_preserve_permission_and_classify_timeout(name):
    client = BackendClient(MagicMock())
    method = getattr(client, name)
    kwargs = {"had_non_text_content": False} if "end_turn" in name else {}
    client._fetch_recent_conversation_projection = AsyncMock(
        side_effect=CDPTimeoutError("Runtime.evaluate", 15)
    )
    result = await method("conv", None, **kwargs)
    assert result.status == "fetch_failed"
    client._fetch_recent_conversation_projection.side_effect = conv_dom_read.ConvDOMPermissionError("denied")
    with pytest.raises(PermissionError):
        await method("conv", None, **kwargs)


@pytest.mark.asyncio
async def test_read_js_enforces_get_abort_boundary_and_preserves_success_raw_shape():
    driver = MagicMock()
    driver._js_with_data_strict = AsyncMock(return_value='[]')
    client = BackendClient(driver)

    result = await client._read_js("(async () => JSON.stringify([]))()", {})
    wrapper = driver._js_with_data_strict.await_args.args[0]

    assert result == "[]"
    assert "AbortController" in wrapper
    assert "read boundary only permits GET" in wrapper
    assert "response.ok" in wrapper
    assert "clearTimeout" in wrapper


@pytest.mark.asyncio
async def test_read_js_distinguishes_page_timeout_and_http_429():
    driver = MagicMock()
    driver._pace = MagicMock()
    driver._pace.record_throttle = MagicMock()
    client = BackendClient(driver)

    driver._js_with_data_strict = AsyncMock(
        return_value=json.dumps({
            "__cgw_read_error__": {
                "kind": "timeout",
                "message": "backend read aborted by deadline",
            }
        })
    )
    with pytest.raises(BackendReadTimeoutError):
        await client._read_js("(async () => [])()", {})

    driver._js_with_data_strict = AsyncMock(
        return_value=json.dumps({
            "__cgw_read_error__": {
                "kind": "http",
                "status": 429,
                "retry_after": "17",
            }
        })
    )
    with pytest.raises(BackendReadHTTPError) as excinfo:
        await client._read_js("(async () => [])()", {})
    assert excinfo.value.status == 429
    assert excinfo.value.retry_after == "17"
    driver._pace.record_throttle.assert_called_once()
