"""Cross-process per-conversation "generation in progress" gate.

Why this exists: MutationLock serializes DOM mutation on a *target*, but two
processes can drive the SAME conversation from DIFFERENT tabs (different
lock keys → no mutual exclusion). A send that lands while the same
conversation is still streaming kills the in-flight generation — observed as
1-2 char truncated replies when two harness sessions shared one conv_id.

The gate is a shared JSON state file (``generating.json``) next to the other
shared runtime state: the sender marks ``conv_id → busy_until`` when its send
is acknowledged and clears it when completion detection ends. A second send
to the same conversation — from ANY process or tab — checks the flag first
and fails fast with ``generation_in_progress`` instead of murdering the
in-flight reply.

Semantics:
- ``busy_until`` is a TTL timestamp (bounded by the detector's hard cap plus
  margin) so a crashed sender can't wedge a conversation forever.
- Entries are keyed by conversation id; fresh-chat sends (no conv_id yet)
  can't collide — a conversation that doesn't exist can't be generating.
- The flag is advisory-layer: it covers cross-tab/cross-process sends. The
  DOM probe (``is_generating``) covers generations started outside the
  bridge entirely (manual sends in the browser).
"""
from __future__ import annotations

import json
import logging
import os
import time

from .tab_registry import REGISTRY_DIR

logger = logging.getLogger(__name__)

GEN_PATH = REGISTRY_DIR / "generating.json"

# Default TTL margin above the completion detector's hard stall cap (~900s).
# A flag older than this is treated as dead and ignored.
DEFAULT_BUSY_TTL = 960.0


def _read_all() -> dict:
    try:
        return json.loads(GEN_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_all(state: dict) -> None:
    try:
        GEN_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = GEN_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        os.replace(tmp, GEN_PATH)
    except OSError:
        logger.debug("generation_gate: state write failed", exc_info=True)


def busy_remaining(conv_id: str, *, now: float | None = None) -> float:
    """Seconds until the conv's generation flag expires. 0 = not busy."""
    if not conv_id:
        return 0.0
    entry = (_read_all().get(conv_id) or {})
    until = entry.get("busy_until")
    if not isinstance(until, (int, float)):
        return 0.0
    remaining = until - (time.time() if now is None else now)
    return remaining if remaining > 0 else 0.0


def mark_generating(
    conv_id: str,
    *,
    ttl: float = DEFAULT_BUSY_TTL,
    owner_pid: int | None = None,
) -> None:
    """Flag ``conv_id`` as generating for up to ``ttl`` seconds."""
    if not conv_id:
        return
    state = _read_all()
    state[conv_id] = {
        "busy_until": time.time() + ttl,
        "owner_pid": owner_pid if owner_pid is not None else os.getpid(),
        "marked_at": time.time(),
    }
    _write_all(state)


def clear_generating(conv_id: str, *, owner_pid: int | None = None) -> None:
    """Clear the flag — only by the marking owner (or a dead owner's flag)."""
    if not conv_id:
        return
    state = _read_all()
    entry = state.get(conv_id)
    if not entry:
        return
    owner = entry.get("owner_pid")
    me = owner_pid if owner_pid is not None else os.getpid()
    # Only the owner clears; a dead owner's flag is collectable by anyone.
    if isinstance(owner, int) and owner != me and _pid_alive(owner):
        return
    state.pop(conv_id, None)
    _write_all(state)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError, PermissionError):
        return False
