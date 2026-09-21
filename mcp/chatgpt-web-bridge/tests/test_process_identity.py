import os
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

from chatgpt_web2api import ensure, process_identity as identity


def test_windows_liveness_queries_do_not_signal_the_process():
    """A regression must fail in its own console, never interrupt this test runner."""
    import os
    import subprocess
    import sys

    if os.name != "nt":
        pytest.skip("Windows process-query contract")
    info = subprocess.STARTUPINFO()
    info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    info.wShowWindow = 0
    code = """
import os
from chatgpt_web2api import conv_binding, generation_gate, tab_registry
for module in (tab_registry, conv_binding, generation_gate):
    assert module._pid_alive(os.getpid())
    assert not module._pid_alive(2**22)
print('all_liveness_queries_returned_without_signalling')
"""
    result = subprocess.run(
        [sys.executable, "-u", "-c", code], capture_output=True, text=True,
        timeout=10, creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=info,
    )
    assert result.returncode == 0, result.stderr
    assert "all_liveness_queries_returned_without_signalling" in result.stdout


def snapshot(label="REST"):
    module = "chatgpt_web2api" if label == "REST" else "chatgpt_web2api.mcp_server"
    return {"pid": 12345, "parent_pid": 12344, "created": 77,
            "executable": os.path.normcase(str(Path(sys.executable).resolve())),
            "argv": [sys.executable, "-m", module] + (["start"] if label == "REST" else ["--transport", "sse"])}


def test_service_identity_includes_exact_module_and_runtime():
    assert identity.matches_service(snapshot(), "REST", 8080)
    assert identity.matches_service(snapshot("SSE"), "SSE", 8090)
    assert not identity.matches_service(snapshot() | {"argv": [sys.executable, "-m", "http.server"]}, "REST", 8080)
    assert not identity.matches_service(snapshot() | {"executable": "unrelated.exe"}, "REST", 8080)
    assert not identity.matches_service(snapshot(), "REST", 8090)


async def test_unrelated_listener_is_never_terminated(monkeypatch):
    monkeypatch.setattr(ensure, "_find_listener_pid", lambda port: 12345)
    monkeypatch.setattr(identity, "inspect_process", lambda pid: snapshot() | {"argv": [sys.executable, "-m", "http.server"]})
    terminate = Mock()
    monkeypatch.setattr(identity, "terminate_verified", terminate)
    assert await ensure._stop_listener(8080, "REST") is False
    terminate.assert_not_called()


async def test_pid_listener_change_aborts_recovery(monkeypatch):
    values = iter([12345, 54321])
    monkeypatch.setattr(ensure, "_find_listener_pid", lambda port: next(values))
    monkeypatch.setattr(identity, "inspect_process", lambda pid: snapshot())
    terminate = Mock()
    monkeypatch.setattr(identity, "terminate_verified", terminate)
    assert await ensure._stop_listener(8080, "REST") is False
    terminate.assert_not_called()


def test_creation_identity_change_aborts_termination(monkeypatch):
    original = snapshot()
    monkeypatch.setattr(identity, "inspect_process", lambda pid: original | {"created": 88})
    assert identity.terminate_verified(original) is False


async def test_verified_listener_only_and_port_release(monkeypatch):
    monkeypatch.setattr(ensure, "_find_listener_pid", lambda port: 12345)
    monkeypatch.setattr(identity, "inspect_process", lambda pid: snapshot())
    terminate = Mock(return_value=True)
    monkeypatch.setattr(identity, "terminate_verified", terminate)
    monkeypatch.setattr(ensure, "_port_accepts", lambda port: False)
    assert await ensure._stop_listener(8080, "REST") is True
    terminate.assert_called_once_with(snapshot())
