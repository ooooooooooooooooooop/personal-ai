"""Real Windows job-close regression, using only disposable probe processes."""

import ctypes
import json
import os
import subprocess
import sys
import uuid
from ctypes import wintypes
from pathlib import Path

import pytest


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimits),
        ("IoInfo", ctypes.c_uint64 * 6),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def _api():
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    definitions = {
        "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
        "OpenJobObjectW": ([wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR], wintypes.HANDLE),
        "SetInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        "AssignProcessToJobObject": ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
        "GetCurrentProcess": ([], wintypes.HANDLE),
        "IsProcessInJob": ([wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)], wintypes.BOOL),
        "OpenProcess": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
        "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
        "TerminateProcess": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
    }
    for name, (args, result) in definitions.items():
        function = getattr(api, name)
        function.argtypes, function.restype = args, result
    return api


_PROBE = """
import ctypes, json, os, runpy, sys, time
from pathlib import Path
api = runpy.run_path(sys.argv[1])["_api"]()
flag = ctypes.wintypes.BOOL()
job = api.OpenJobObjectW(4, False, sys.argv[4])
assert job and api.IsProcessInJob(api.GetCurrentProcess(), job, ctypes.byref(flag))
api.CloseHandle(job)
Path(sys.argv[2]).write_text(json.dumps({"pid": os.getpid(), "in_owning_job": bool(flag.value)}))
deadline = time.monotonic() + 15
while not Path(sys.argv[3]).exists() and time.monotonic() < deadline:
    time.sleep(0.025)
"""

_DRIVER = """
import ctypes, json, runpy, subprocess, sys, time
from pathlib import Path
from chatgpt_web2api.ensure import _launch_detached
module = runpy.run_path(sys.argv[1])
api = module["_api"]()
job = api.OpenJobObjectW(1, False, sys.argv[2])
assert job and api.AssignProcessToJobObject(job, api.GetCurrentProcess()), ctypes.get_last_error()
api.CloseHandle(job)
command = [sys.executable, "-c", module["_PROBE"], sys.argv[1], sys.argv[3], sys.argv[4], sys.argv[2]]
if sys.argv[5] == "legacy":
    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL,
                             creationflags=subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS)
else:
    child = _launch_detached(command)
deadline = time.monotonic() + 8
while not Path(sys.argv[3]).exists() and time.monotonic() < deadline:
    time.sleep(0.025)
print(Path(sys.argv[3]).read_text(), flush=True)
"""


@pytest.mark.skipif(os.name != "nt", reason="Windows process job lifetime")
@pytest.mark.parametrize("mode,survives,allow_breakaway", [
    ("legacy", False, True), ("fixed", True, True), ("fixed", True, False),
])
def test_daemon_lifetime_after_owning_job_closes(tmp_path, mode, survives, allow_breakaway):
    api = _api()
    name = "Local\\w2a-test-" + uuid.uuid4().hex
    job = api.CreateJobObjectW(None, name)
    assert job
    info = _ExtendedLimits()
    info.BasicLimitInformation.LimitFlags = 0x2000 | (0x800 if allow_breakaway else 0)
    assert api.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
    stop, ready = tmp_path / "stop", tmp_path / "ready.json"
    process = None
    try:
        driver = subprocess.run(
            [sys.executable, "-c", _DRIVER, str(Path(__file__).resolve()), name,
             str(ready), str(stop), mode],
            capture_output=True, text=True, timeout=30,
            # Hosted CI may prohibit leaving its outer job. The disposable
            # driver can join our nested job while remaining inside that job.
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        assert driver.returncode == 0, driver.stderr
        child = json.loads(driver.stdout)
        process = api.OpenProcess(0x100000 | 0x1000 | 1, False, child["pid"])
        assert process
        assert api.WaitForSingleObject(process, 0) == 258
        assert api.CloseHandle(job)
        job = None
        assert api.WaitForSingleObject(process, 500) == (258 if survives else 0)
        assert child["in_owning_job"] is not survives
    finally:
        stop.touch()
        if job:
            api.CloseHandle(job)
        if process:
            if api.WaitForSingleObject(process, 5000) == 258:
                api.TerminateProcess(process, 1)
                api.WaitForSingleObject(process, 1000)
            api.CloseHandle(process)


@pytest.mark.skipif(os.name != "nt", reason="Windows process job lifetime")
def test_denied_broker_is_reported_without_task_owned_fallback(monkeypatch):
    from chatgpt_web2api import ensure

    attempts = []
    def denied(*args, **kwargs):
        attempts.append(kwargs)
        return subprocess.CompletedProcess(args, 0, '{"ReturnValue":2,"ProcessId":null}', "")
    monkeypatch.setattr(ensure.subprocess, "run", denied)
    def forbidden(*args, **kwargs):
        pytest.fail("task-owned fallback must not launch")
    monkeypatch.setattr(ensure.subprocess, "Popen", forbidden)
    with pytest.raises(RuntimeError, match="persistent bridge daemon"):
        ensure._launch_detached(["owned-test-command"])
    assert len(attempts) == 1
    payload = json.loads(attempts[0]["input"])
    assert payload["command"] == "owned-test-command"
    assert payload["cwd"]
