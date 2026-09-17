"""RequestPace kind-split: read-path 429 vs send-path rate limit.

ChatGPT's conversation-endpoint limiter (``/backend-api/conversation*`` →
"限制访问对话记录") is endpoint-scoped — upstream keeps answering sends
while conversation fetches 429 — so a read-path throttle gates reads only.
A send-path rate limit (the UI popup) is the account-wide signal and gates
both kinds.
"""

import asyncio
import json
import time

import pytest

from chatgpt_web2api import request_pace as rp


@pytest.fixture
def pace_file(tmp_path, monkeypatch):
    p = tmp_path / "request_pace.json"
    monkeypatch.setattr(rp, "PACE_PATH", p)
    return p


@pytest.fixture
def no_sleep(monkeypatch):
    """Make pace()'s cooldown waits instant; ``waited`` still accumulates."""

    async def _nosleep(_seconds):
        return None

    monkeypatch.setattr(asyncio, "sleep", _nosleep)


@pytest.mark.asyncio
async def test_read_throttle_gates_reads_but_not_sends(pace_file, no_sleep):
    pace = rp.RequestPace(send_interval=0, read_interval=0, cooldown_seconds=60)
    pace.record_throttle(kind="read", source="test")

    state = json.loads(pace_file.read_text())
    assert state["read_cooldown_until"] > time.time() + 30
    assert state.get("cooldown_until", 0) <= time.time()

    assert await pace.pace("send") == 0.0  # sends are not gated by a read 429
    assert await pace.pace("read") > 30.0  # reads ride out the cooldown


@pytest.mark.asyncio
async def test_send_throttle_gates_both_kinds(pace_file, no_sleep):
    pace = rp.RequestPace(send_interval=0, read_interval=0, cooldown_seconds=60)
    pace.record_throttle(kind="send", source="test")

    state = json.loads(pace_file.read_text())
    assert state["cooldown_until"] > time.time() + 30

    assert await pace.pace("send") > 30.0
    assert await pace.pace("read") > 30.0


def test_record_throttle_default_kind_is_account_wide(pace_file):
    rp.RequestPace().record_throttle(source="t")
    state = json.loads(pace_file.read_text())
    assert "cooldown_until" in state
    assert "read_cooldown_until" not in state


def test_read_throttle_never_shortens_existing(pace_file):
    pace = rp.RequestPace(cooldown_seconds=60)
    first = pace.record_throttle(kind="read", source="a")
    pace.record_throttle(5, kind="read", source="b")  # shorter — must lose
    state = json.loads(pace_file.read_text())
    assert state["read_cooldown_until"] == pytest.approx(first, abs=0.5)


def test_read_and_send_cooldowns_are_independent(pace_file):
    """A read 429 must not erase (or be erased by) a send-path cooldown."""
    pace = rp.RequestPace(cooldown_seconds=60)
    pace.record_throttle(kind="send", source="s")
    pace.record_throttle(120, kind="read", source="r")
    state = json.loads(pace_file.read_text())
    assert state["cooldown_until"] > time.time() + 30
    assert state["read_cooldown_until"] > time.time() + 90


# ── read_blocked_seconds: non-blocking cooldown probe ──────────────────

def test_read_blocked_seconds_reflects_cooldowns(pace_file):
    pace = rp.RequestPace(send_interval=0, read_interval=0, cooldown_seconds=60)
    assert pace.read_blocked_seconds() == 0.0

    pace.record_throttle(kind="read", source="t")
    blocked = pace.read_blocked_seconds()
    assert 30 < blocked <= 60

    # A send-path (account) cooldown blocks reads too.
    pace.record_throttle(seconds=120, kind="send", source="t")
    assert pace.read_blocked_seconds() > 60


def test_read_blocked_seconds_ignores_plain_interval(pace_file):
    """The per-read interval is normal pacing, not a block — the probe must
    only report cooldown state."""
    pace = rp.RequestPace(send_interval=0, read_interval=60)
    state = {"last_read_at": time.time()}
    pace_file.write_text(json.dumps(state))
    assert pace.read_blocked_seconds() == 0.0


# ── read-429 streak escalation ──────────────────────────────────────────

def test_read_throttle_escalates_on_consecutive_429s(pace_file):
    """Each consecutive read-path 429 doubles the cooldown (cap 1800s) — a
    flagged account stays flagged upstream for hours, and flat 300s probes
    just re-poke the limiter."""
    pace = rp.RequestPace(send_interval=0, read_interval=0, cooldown_seconds=100)

    until1 = pace.record_throttle(kind="read", source="t")
    assert until1 - time.time() == pytest.approx(100, abs=5)

    until2 = pace.record_throttle(kind="read", source="t")
    assert until2 - time.time() == pytest.approx(200, abs=5)

    until3 = pace.record_throttle(kind="read", source="t")
    assert until3 - time.time() == pytest.approx(400, abs=5)

    state = json.loads(pace_file.read_text())
    assert state["read_429_streak"] == 3


def test_read_throttle_escalation_capped(pace_file):
    pace = rp.RequestPace(send_interval=0, read_interval=0, cooldown_seconds=300)
    pace_file.write_text(json.dumps({"read_429_streak": 10}))
    until = pace.record_throttle(kind="read", source="t")
    assert until - time.time() <= rp.COOLDOWN_CAP_SECONDS


def test_explicit_seconds_win_over_streak(pace_file):
    """A Retry-After from upstream overrides the streak escalation."""
    pace = rp.RequestPace(send_interval=0, read_interval=0, cooldown_seconds=100)
    pace_file.write_text(json.dumps({"read_429_streak": 5}))
    until = pace.record_throttle(seconds=45, kind="read", source="t")
    assert until - time.time() == pytest.approx(45, abs=5)


def test_record_read_ok_resets_streak(pace_file):
    pace = rp.RequestPace(send_interval=0, read_interval=0, cooldown_seconds=100)
    pace.record_throttle(kind="read", source="t")
    pace.record_throttle(kind="read", source="t")
    assert json.loads(pace_file.read_text())["read_429_streak"] == 2

    pace.record_read_ok()
    assert json.loads(pace_file.read_text())["read_429_streak"] == 0

    until = pace.record_throttle(kind="read", source="t")
    assert until - time.time() == pytest.approx(100, abs=5)


def test_record_read_ok_noop_without_streak(pace_file):
    pace = rp.RequestPace()
    pace.record_read_ok()
    assert not pace_file.exists() or not json.loads(
        pace_file.read_text()
    ).get("read_429_streak")


# ── retry_after_seconds header parsing ──────────────────────────────────

def test_retry_after_seconds_parses_delta():
    assert rp.retry_after_seconds("120") == 120.0
    assert rp.retry_after_seconds("0") == 0.0
    assert rp.retry_after_seconds(None) is None
    assert rp.retry_after_seconds("garbage") is None


def test_retry_after_seconds_parses_http_date():
    from email.utils import formatdate

    future = formatdate(time.time() + 300, usegmt=True)
    parsed = rp.retry_after_seconds(future)
    assert 250 < parsed <= 300
