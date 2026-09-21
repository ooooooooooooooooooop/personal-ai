"""Protocol-level regressions: deadlines, runtime identity and model selection."""
import asyncio
import time
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock

import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from chatgpt_web2api import mcp_server as mod
from chatgpt_web2api import runtime_info
from chatgpt_web2api.cdp_driver import CDPDriver, StreamChunk
from chatgpt_web2api.request_monitor import RequestMonitor


@pytest.fixture
def isolated_server(monkeypatch):
    monkeypatch.setattr(mod, "_driver_pool", None)
    monkeypatch.setattr(mod, "_driver", None)
    monkeypatch.setattr(mod, "_config", None)
    monkeypatch.setattr(mod, "_breakers", None)
    monkeypatch.setattr(mod, "_lock_cdp_port", None)
    return mod.create_server()


async def test_runtime_info_works_without_browser(isolated_server):
    async with create_connected_server_and_client_session(isolated_server) as session:
        initialized = await session.initialize()
        result = await session.call_tool("runtime_info", {})
    assert not result.isError
    assert result.structuredContent["contract_version"] == runtime_info.CONTRACT_VERSION
    assert "tail_read" in result.structuredContent["capabilities"]
    assert initialized.serverInfo.version == result.structuredContent["package_version"]
    assert initialized.capabilities.experimental["chatgpt-web2api/runtime"] == result.structuredContent


def test_initialize_identity_preserves_extensions_and_reports_disk_drift(isolated_server, monkeypatch):
    extensions = {"example/feature": {"enabled": True}}
    startup = runtime_info.get_runtime_info()["startup_source_fingerprint"]
    monkeypatch.setattr(runtime_info, "source_fingerprint", lambda: "changed-on-disk")
    options = isolated_server.create_initialization_options(experimental_capabilities=extensions)
    advertised = options.capabilities.experimental
    assert advertised["example/feature"] == {"enabled": True}
    assert extensions == {"example/feature": {"enabled": True}}
    assert advertised["chatgpt-web2api/runtime"]["startup_source_fingerprint"] == startup
    assert advertised["chatgpt-web2api/runtime"]["disk_source_fingerprint"] == "changed-on-disk"
    assert advertised["chatgpt-web2api/runtime"]["restart_required"] is True


def test_runtime_identity_reports_disk_drift_without_replacing_startup(monkeypatch):
    startup = runtime_info.get_runtime_info()["startup_source_fingerprint"]
    monkeypatch.setattr(runtime_info, "source_fingerprint", lambda: "changed-on-disk")
    result = runtime_info.get_runtime_info()
    assert result["startup_source_fingerprint"] == startup
    assert result["disk_source_fingerprint"] == "changed-on-disk"
    assert result["restart_required"] is True


def test_fingerprint_is_path_and_line_ending_independent(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (a / "module.py").write_bytes(b"value = 1\r\n")
    (b / "module.py").write_bytes(b"value = 1\n")
    assert runtime_info.source_fingerprint(a) == runtime_info.source_fingerprint(b)
    (b / "module.py").write_bytes(b"value = 2\n")
    assert runtime_info.source_fingerprint(a) != runtime_info.source_fingerprint(b)


def _driver():
    driver = MagicMock(spec=CDPDriver)
    driver._current_conv_id = None
    driver._current_model = None
    driver.route_chat_target = AsyncMock(return_value="new")
    driver.select_model = AsyncMock(return_value=False)
    driver.get_conversation = AsyncMock(return_value={})
    return driver


async def test_explicit_model_failure_never_submits(isolated_server, monkeypatch):
    driver = _driver()
    monkeypatch.setattr(mod, "_driver", driver)
    async with create_connected_server_and_client_session(isolated_server) as session:
        await session.initialize()
        result = await session.call_tool("chat_completion", {
            "message": "test", "model": "missing-model", "confirm": True,
        })
    assert result.isError
    assert result.structuredContent["error"] == "model_selection_failed"
    assert result.structuredContent["delivery_stage"] == "not_started"
    driver.send_and_stream.assert_not_called()


async def test_model_selection_follows_routing_and_reports_verification(monkeypatch):
    driver = _driver()
    steps = []

    async def route(**kwargs):
        steps.append("route")
        return "new"

    async def select(model):
        steps.append("select")
        driver._current_model = model
        return True

    async def stream(*args, **kwargs):
        steps.append("send")
        yield StreamChunk(delta="answer", finish_reason="stop")

    driver.route_chat_target = route
    driver.select_model = select
    driver.send_and_stream = stream
    result = await mod.do_chat_completion(driver, {
        "message": "test", "model": "available-model", "confirm": True,
    }, None)
    assert steps == ["route", "select", "send"]
    assert result["requested_model"] == "available-model"
    assert result["model_selection_verified"] is True


async def test_request_deadline_cancels_navigation(isolated_server, monkeypatch):
    driver = _driver()
    cancelled = asyncio.Event()

    async def blocked_route(**kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    driver.route_chat_target = blocked_route
    monkeypatch.setattr(mod, "_driver", driver)
    started = time.monotonic()
    async with create_connected_server_and_client_session(isolated_server) as session:
        await session.initialize()
        result = await session.call_tool("chat_completion", {
            "message": "test", "confirm": True, "timeout_seconds": 1,
        })
    assert result.isError
    assert result.structuredContent["error"] == "request_timeout"
    assert result.structuredContent["retry_safe"] is False
    assert cancelled.is_set()
    assert time.monotonic() - started < 3
    driver.send_and_stream.assert_not_called()


async def test_progress_heartbeats_stop_with_request():
    messages = []

    async def callback(message):
        messages.append(message)

    monitor = RequestMonitor(callback, budget=10, interval=0.01)
    async with monitor:
        await monitor.update("Waiting for send acknowledgement")
        await asyncio.sleep(0.035)
    count = len(messages)
    await asyncio.sleep(0.02)
    assert count >= 3
    assert len(messages) == count
    assert "Waiting for send acknowledgement" in messages[-1]
    assert "elapsed=" in messages[-1] and "budget=10s" in messages[-1]


async def test_request_budget_includes_pool_queue_and_reports_progress(isolated_server, monkeypatch):
    cancelled = asyncio.Event()
    pool = MagicMock()
    pool.account_breaker.is_tripped.return_value = False

    @asynccontextmanager
    async def acquire(key):
        try:
            await asyncio.Event().wait()
            yield
        finally:
            cancelled.set()

    pool.acquire = acquire
    monkeypatch.setattr(mod, "_driver_pool", pool)
    monkeypatch.setattr(mod, "_transport", "stdio")
    progress = []

    async def on_progress(value, total, message):
        progress.append((value, message))

    started = time.monotonic()
    async with create_connected_server_and_client_session(isolated_server) as session:
        await session.initialize()
        result = await session.call_tool("chat_completion", {
            "message": "test", "confirm": True, "timeout_seconds": 1,
        }, progress_callback=on_progress)
    assert result.isError
    assert result.structuredContent["error"] == "request_timeout"
    assert result.structuredContent["phase"] == "Waiting for browser/driver availability"
    assert cancelled.is_set()
    assert time.monotonic() - started < 3
    assert progress and "elapsed=" in progress[0][1]


async def test_stalled_progress_transport_does_not_extend_deadline():
    async def blocked_callback(message):
        await asyncio.Event().wait()

    started = time.monotonic()
    with pytest.raises(TimeoutError):
        async with asyncio.timeout(0.03):
            async with RequestMonitor(blocked_callback, budget=0.03):
                await asyncio.Event().wait()
    assert time.monotonic() - started < 0.5


@pytest.mark.parametrize("kind,status", [("timeout", None), ("network", None), ("http", 503)])
async def test_backend_read_failure_is_structured_not_empty_success(isolated_server, monkeypatch, kind, status):
    from chatgpt_web2api.backend_client import BackendReadError

    driver = _driver()
    driver.get_projects = AsyncMock(side_effect=BackendReadError(
        "read failed", kind=kind, status=status, body="PRIVATE_RESPONSE_BODY"
    ))
    monkeypatch.setattr(mod, "_driver", driver)
    async with create_connected_server_and_client_session(isolated_server) as session:
        await session.initialize()
        result = await session.call_tool("list_projects", {})
    assert result.isError
    assert result.structuredContent["kind"] == kind
    assert result.structuredContent["phase"] == "backend_http_read"
    assert "PRIVATE_RESPONSE_BODY" not in str(result)
