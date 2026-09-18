"""generation_gate — cross-process "this conv is mid-generation" flag.

A send into a conversation that is still streaming kills the in-flight
reply; the shared flag + DOM probe make that fail fast instead.
"""
from __future__ import annotations

import os
import time

import pytest

from chatgpt_web2api import generation_gate


@pytest.fixture(autouse=True)
def _isolate_state(tmp_path, monkeypatch):
    monkeypatch.setattr(
        generation_gate, "GEN_PATH", tmp_path / "generating.json"
    )


def test_unmarked_conv_is_not_busy():
    assert generation_gate.busy_remaining("conv-1") == 0.0
    assert generation_gate.busy_remaining("") == 0.0


def test_mark_then_busy_until_ttl():
    generation_gate.mark_generating("conv-1", ttl=100.0)
    remaining = generation_gate.busy_remaining("conv-1")
    assert 95.0 < remaining <= 100.0


def test_clear_releases_flag():
    generation_gate.mark_generating("conv-1")
    generation_gate.clear_generating("conv-1")
    assert generation_gate.busy_remaining("conv-1") == 0.0


def test_expired_flag_is_not_busy():
    generation_gate._write_all(
        {"conv-1": {"busy_until": time.time() - 1, "owner_pid": os.getpid()}}
    )
    assert generation_gate.busy_remaining("conv-1") == 0.0


def test_foreign_live_owner_cannot_clear():
    # A flag owned by another LIVE pid survives a clear attempt from us.
    # Spawn a real (not-us) live pid — fixed pids like 1 aren't portable.
    import subprocess
    import sys

    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        generation_gate._write_all(
            {"conv-1": {
                "busy_until": time.time() + 100,
                "owner_pid": proc.pid,
            }}
        )
        generation_gate.clear_generating("conv-1")  # we are not that pid
        assert generation_gate.busy_remaining("conv-1") > 0
    finally:
        proc.kill()


def test_dead_owner_flag_is_collectable():
    generation_gate._write_all(
        {"conv-1": {
            "busy_until": time.time() + 100,
            "owner_pid": 2**22,  # not a live pid
        }}
    )
    generation_gate.clear_generating("conv-1")
    assert generation_gate.busy_remaining("conv-1") == 0.0


def test_malformed_state_file_is_safe(tmp_path):
    generation_gate.GEN_PATH.write_text("{not json", encoding="utf-8")
    assert generation_gate.busy_remaining("conv-1") == 0.0
    generation_gate.mark_generating("conv-1")
    assert generation_gate.busy_remaining("conv-1") > 0
