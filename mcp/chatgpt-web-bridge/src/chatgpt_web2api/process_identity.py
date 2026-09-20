"""Verify service identity before recovery; Windows termination uses a held handle.

This prevents accidental process/PID mixups, not a privilege boundary against
an agent with unrestricted OS access. Uninspectable processes are never killed.
"""

from __future__ import annotations

import ctypes
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path


def _windows_handle(pid, access):
    from ctypes import wintypes

    api = ctypes.WinDLL("kernel32", use_last_error=True)
    api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    api.OpenProcess.restype = wintypes.HANDLE
    api.CloseHandle.argtypes = [wintypes.HANDLE]
    api.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    api.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    api.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    api.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    handle = api.OpenProcess(access, False, pid)
    if not handle:
        raise OSError("cannot inspect process")
    try:
        size = wintypes.DWORD(32768)
        image = ctypes.create_unicode_buffer(size.value)
        created, exited, kernel, user = [wintypes.FILETIME() for _ in range(4)]
        exit_code = wintypes.DWORD()
        if not api.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(size)):
            raise OSError("cannot read executable identity")
        if not api.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)):
            raise OSError("cannot read creation identity")
        if not api.GetExitCodeProcess(handle, ctypes.byref(exit_code)) or exit_code.value != 259:
            raise OSError("process already exited")
        identity = {
            "pid": pid, "executable": os.path.normcase(image.value),
            "created": (created.dwHighDateTime << 32) | created.dwLowDateTime,
        }
        return api, handle, identity
    except BaseException:
        api.CloseHandle(handle)
        raise


def inspect_process(pid: int) -> dict | None:
    try:
        if sys.platform == "win32":
            api, handle, identity = _windows_handle(pid, 0x1000)
            try:
                shell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
                script = (
                    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); "
                    f"Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}' | "
                    "Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress"
                )
                result = subprocess.run(
                    [str(shell), "-NoProfile", "-NonInteractive", "-Command", script],
                    capture_output=True, text=True, encoding="utf-8", timeout=8,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
                data = json.loads(result.stdout)
                if data["ProcessId"] != pid or os.path.normcase(data["ExecutablePath"]) != identity["executable"]:
                    return None
                identity.update(
                    parent_pid=data["ParentProcessId"],
                    argv=[part.strip('"') for part in shlex.split(data["CommandLine"], posix=False)],
                )
                return identity
            finally:
                api.CloseHandle(handle)
        # Linux: /proc provides executable + creation tick + argv without ps
        # formatting ambiguity. Other platforms fail closed pending support.
        proc = Path("/proc") / str(pid)
        stat = (proc / "stat").read_text().rsplit(")", 1)[1].split()
        return {
            "pid": pid, "parent_pid": int(stat[1]), "created": int(stat[19]),
            "executable": str((proc / "exe").resolve(strict=True)),
            "argv": (proc / "cmdline").read_bytes().decode().rstrip("\0").split("\0"),
        }
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        return None


def matches_service(identity: dict | None, label: str, port: int) -> bool:
    if not identity or not identity.get("created"):
        return False
    runtimes = {os.path.normcase(str(Path(p).resolve())) for p in (
        sys.executable, getattr(sys, "_base_executable", sys.executable),
    )}
    if os.path.normcase(identity["executable"]) not in runtimes:
        return False
    argv = identity.get("argv", [])
    if len(argv) < 2:
        return False
    args = argv[1:]
    module = "chatgpt_web2api" if label == "REST" else "chatgpt_web2api.mcp_server"
    entry = "chatgpt-web2api" if label == "REST" else "chatgpt-web2api-mcp"
    expected = Path(sys.executable).parent / (entry + (".exe" if os.name == "nt" else ""))
    if args[:2] == ["-m", module]:
        options = args[2:]
    elif os.path.normcase(str(Path(args[0]).resolve())) == os.path.normcase(str(expected.resolve())):
        options = args[1:]
    else:
        return False
    if label == "REST" and options[:1] == ["start"]:
        options = options[1:]
    if label != "REST" and not any(
        options[i:i + 2] == ["--transport", "sse"] for i in range(len(options))
    ):
        return False
    try:
        for flag in ("--port", "-p"):
            if flag in options:
                return int(options[options.index(flag) + 1]) == port
        return port == (8080 if label == "REST" else 8090)
    except (ValueError, IndexError):
        return False


def terminate_verified(expected: dict) -> bool:
    pid = expected["pid"]
    current = inspect_process(pid)
    if current != expected:
        return False
    if sys.platform == "win32":
        try:
            api, handle, identity = _windows_handle(pid, 0x1000 | 0x0001)
            try:
                if any(identity[key] != expected[key] for key in ("pid", "created", "executable")):
                    return False
                return bool(api.TerminateProcess(handle, 1))
            finally:
                api.CloseHandle(handle)
        except OSError:
            return False
    # A pidfd pins the intended Linux process even if the PID is recycled.
    import signal

    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        return False
    try:
        fd = os.pidfd_open(pid)
        try:
            if inspect_process(pid) != expected:
                return False
            signal.pidfd_send_signal(fd, signal.SIGTERM)
            return True
        finally:
            os.close(fd)
    except OSError:
        return False
