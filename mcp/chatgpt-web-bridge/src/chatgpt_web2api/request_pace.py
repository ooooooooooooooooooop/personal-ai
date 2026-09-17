"""Cross-process, account-level request pacing.

ChatGPT throttles per-account: bursts of sends AND conversation-record
fetches trip its "请求过于频繁 / 已暂时限制你访问对话记录" interstitial
(HTTP 429 on the backend API). The existing ``retry_on_rate_limit`` only
reacts AFTER the popup appears; this module prevents reaching it: every
process (REST daemon, MCP pool slots, one-off scripts) shares one pace file,
so the account sees a bounded request rate no matter which process asks.

State: ``~/.chatgpt-web2api/request_pace.json``

    {"last_send_at": f, "last_read_at": f,
     "cooldown_until": f, "read_cooldown_until": f}

``cooldown_until`` is the full gate (send-path rate limit — ChatGPT's popup
blocks the whole UI, so both sends and reads honor it). ``read_cooldown_until``
is narrower: ChatGPT's conversation-endpoint limiter (429 on
``/backend-api/conversation*``) is endpoint-scoped — sends keep working while
it is active, so it gates reads only.

This is pacing, not a lock — a lost read-modify-write race merely loosens
pacing slightly. Each pace() re-reads the file after sleeping so a peer's
update during our wait is honored.
"""
import asyncio
import json
import logging
import os
import time
from pathlib import Path

from .tab_registry import REGISTRY_DIR

logger = logging.getLogger(__name__)

PACE_PATH = REGISTRY_DIR / "request_pace.json"

DEFAULT_SEND_INTERVAL = 30.0
DEFAULT_READ_INTERVAL = 8.0
DEFAULT_COOLDOWN_SECONDS = 300.0

# Upper bound on any single cooldown (read-path escalation or a Retry-After
# header). 30 min: long enough to stop poking a flagged account, short enough
# that a stale flag can't lock reads out for a whole session.
COOLDOWN_CAP_SECONDS = 1800.0


class ReadThrottledError(RuntimeError):
    """A conversation read was declined while the shared read gate is in
    cooldown — fail fast instead of queueing behind a multi-minute wait.

    Raised by conversation-read entry points that probe
    ``read_blocked_seconds()`` before pacing. Carries ``retry_after``
    (seconds until the gate reopens) so callers can surface an actionable
    "come back in N" instead of hanging. Subclasses ``RuntimeError`` so the
    detector's ``(CDPJSError, RuntimeError)`` fetch_failed wrappers degrade
    to DOM observation without special-casing.
    """

    def __init__(self, retry_after: float) -> None:
        super().__init__(
            f"conversation read throttled by shared cooldown; retry in {retry_after:.0f}s"
        )
        self.retry_after = retry_after


def retry_after_seconds(value) -> float | None:
    """Parse a ``Retry-After`` header value (delta-seconds or HTTP-date).

    Returns None when the header is absent or unparseable — callers then
    fall back to the escalating default cooldown.
    """
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        pass
    try:
        from email.utils import parsedate_to_datetime

        parsed = parsedate_to_datetime(str(value))
        if parsed is None:
            return None
        return max(0.0, parsed.timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return None


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


class RequestPace:
    """Shared minimum-interval gate for account-visible requests.

    kind="send": a message POST (type+click) — the expensive, throttled path.
    kind="read": a /backend-api/* fetch (conversation fetch, lists, project
    ops) — cheaper but also rate-limited ("限制访问对话记录").
    """

    def __init__(
        self,
        send_interval: float | None = None,
        read_interval: float | None = None,
        cooldown_seconds: float | None = None,
    ) -> None:
        self.send_interval = (
            send_interval
            if send_interval is not None
            else _env_float("W2A_PACE_SEND_S", DEFAULT_SEND_INTERVAL)
        )
        self.read_interval = (
            read_interval
            if read_interval is not None
            else _env_float("W2A_PACE_READ_S", DEFAULT_READ_INTERVAL)
        )
        self.cooldown_seconds = (
            cooldown_seconds
            if cooldown_seconds is not None
            else _env_float("W2A_PACE_COOLDOWN_S", DEFAULT_COOLDOWN_SECONDS)
        )
        self._lock = asyncio.Lock()

    def _read_state(self) -> dict:
        try:
            d = json.loads(PACE_PATH.read_text(encoding="utf-8"))
            return d if isinstance(d, dict) else {}
        except (OSError, UnicodeError, json.JSONDecodeError):
            return {}

    def _write_state(self, state: dict) -> None:
        try:
            PACE_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = PACE_PATH.with_suffix(".tmp")
            tmp.write_text(json.dumps(state), encoding="utf-8")
            os.replace(tmp, PACE_PATH)
        except OSError:
            pass

    async def pace(self, kind: str) -> float:
        """Sleep until the shared gate lets this request through.

        Returns seconds waited. Stamps ``last_<kind>_at`` on the way out.
        """
        interval = self.send_interval if kind == "send" else self.read_interval
        waited = 0.0
        in_cooldown = False
        async with self._lock:
            for _ in range(4):
                state = self._read_state()
                now = time.time()
                cooldown_until = state.get("cooldown_until", 0.0)
                if kind == "read":
                    cooldown_until = max(
                        cooldown_until, state.get("read_cooldown_until", 0.0)
                    )
                due = max(
                    cooldown_until,
                    state.get(f"last_{kind}_at", 0.0) + interval,
                )
                wait = due - now
                if wait <= 0:
                    break
                in_cooldown = in_cooldown or cooldown_until > now
                waited += wait
                await asyncio.sleep(wait)
            state = self._read_state()
            state[f"last_{kind}_at"] = time.time()
            self._write_state(state)
        if waited >= 1.0:
            logger.info(
                "pace(%s): waited %.1fs%s", kind, waited,
                " (account cooldown in effect)" if in_cooldown else "",
            )
        return waited

    def read_blocked_seconds(self) -> float:
        """Seconds until the read gate reopens — cooldown only.

        Callers that must not stall behind a multi-minute cooldown
        (completion detector, wait_reply polling, persistence verification)
        probe this before a paced read and fail fast / fall back to DOM when
        it is positive. The normal per-read interval is deliberately NOT
        reported: waiting a few seconds inside a poll loop is the designed
        pacing; blocking it for minutes is not.
        """
        state = self._read_state()
        now = time.time()
        return max(
            0.0,
            state.get("cooldown_until", 0.0) - now,
            state.get("read_cooldown_until", 0.0) - now,
        )

    def record_read_ok(self) -> None:
        """A conversation read got a definitive non-429 response — reset the
        read-path 429 streak so the next cooldown starts from the base
        interval again."""
        state = self._read_state()
        if state.get("read_429_streak"):
            state["read_429_streak"] = 0
            self._write_state(state)

    def record_throttle(
        self,
        seconds: float | None = None,
        *,
        source: str = "",
        kind: str = "send",
    ) -> float:
        """Set a shared cooldown after a throttle/429 signal.

        ``kind="send"`` (rate-limit popup on the send path — the account-wide
        signal) writes ``cooldown_until``, which gates both sends and reads.
        ``kind="read"`` (429 on ``/backend-api/conversation*`` — ChatGPT's
        endpoint-scoped conversation limiter) writes ``read_cooldown_until``,
        which gates reads only: sends still go through, matching the upstream
        behavior where the modal blocks conversation history while other
        endpoints keep answering 200.

        ``seconds`` is an explicit duration — normally a ``Retry-After``
        header value from the 429 response. Without one, ``kind="read"``
        escalates per consecutive-429 streak (``read_429_streak`` in the
        shared state): a flagged account stays flagged for hours upstream,
        so a flat 300s probe just re-pokes the limiter and re-arms it.
        ``record_read_ok`` resets the streak on the first definitive
        non-429 answer.

        Returns the cooldown_until timestamp. ``source`` names the observing
        call site so the log can attribute the cooldown.
        """
        key = "read_cooldown_until" if kind == "read" else "cooldown_until"
        state = self._read_state()
        now = time.time()
        if seconds and seconds > 0:
            wait = min(seconds, COOLDOWN_CAP_SECONDS)
        elif kind == "read":
            streak = int(state.get("read_429_streak", 0))
            wait = min(
                self.cooldown_seconds * (1 << min(streak, 3)),
                COOLDOWN_CAP_SECONDS,
            )
            state["read_429_streak"] = streak + 1
        else:
            wait = self.cooldown_seconds
        until = now + wait
        if until > state.get(key, 0.0):
            state[key] = until
        # Always write: the streak counter must persist even when an earlier
        # peer's cooldown already reaches further out.
        self._write_state(state)
        logger.warning(
            "%s throttle recorded (source=%s): cooldown %.0fs, until %s",
            "read-path" if kind == "read" else "account",
            source or "unspecified", until - now,
            time.strftime("%H:%M:%S", time.localtime(until)),
        )
        return until
