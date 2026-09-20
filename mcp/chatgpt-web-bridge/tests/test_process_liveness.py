"""A liveness query must never signal a process on Windows."""
import os
import subprocess
import sys

import pytest

from chatgpt_web2api import conv_binding, generation_gate, tab_registry


@pytest.mark.skipif(os.name != "nt", reason="Windows signal semantics")
def test_all_registries_probe_live_process_without_os_kill(monkeypatch):
    def forbidden_kill(*args):
        pytest.fail("Windows liveness must not call os.kill, even with signal zero")

    monkeypatch.setattr(os, "kill", forbidden_kill)
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        for module in (conv_binding, generation_gate, tab_registry):
            assert module._pid_alive(child.pid) is True
            assert module._pid_alive(os.getpid()) is True
        assert child.poll() is None
    finally:
        child.terminate()
        child.wait(timeout=5)
    assert tab_registry._pid_alive(child.pid) is False
