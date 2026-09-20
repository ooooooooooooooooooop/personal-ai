"""Cross-process per-conversation binding registry.

Why this exists: two harness sessions could send into the SAME ChatGPT
conversation — each from its own tab or even its own bridge process — and
every send killed the other's in-flight generation (1-2 char truncated
replies). ``generation_gate`` blocks sends while a reply streams; this
registry prevents the earlier mistake: a session binding to a
conversation another session is already using, without anyone noticing.

Contract (per the operator's requirements):
- The FIRST send that binds a session to an existing conversation must be
  confirmed by the human user. The gate returns a ``confirmation_required``
  payload naming the project and the conversation — plus an occupant
  warning when another live session owns the binding — so the human
  confirms the real target instead of the agent silently picking one.
- Resending the same request with ``confirm=true`` claims the binding.
  Confirmation CAN take over an occupied conversation (sessions drift;
  hard-refusing would wedge a conv behind a dead session), but it still
  cannot interrupt a live generation — the generation gate decides that.
- Reconnect creates a new binding. Session keys (``sse:``, ``http:``, ``stdio-``)
  die with the connection. A client may pass ``confirm=true`` using still-valid
  explicit user approval for the same target; reconnect alone does not revoke
  that approval. ``owner_pid`` records which daemon process served
  the claim; a dead owner's binding is reclaimable, so a daemon restart
  cannot leave permanent "occupied" ghosts.
- Reads (get_conversation / wait_reply / lists) never touch this
  registry — they can't interrupt anything.

Records live in ``conv_bindings.json`` next to the other shared runtime
state: ``conv_id → {session_key, owner_pid, claimed_at, last_seen}``.
``last_seen`` is refreshed on every gated send; an entry idle past
``BIND_TTL`` is treated as free (abandoned session, clean handoff).
"""
from __future__ import annotations

import json
import logging
import os
import time

from . import generation_gate
from .tab_registry import REGISTRY_DIR, _pid_alive

logger = logging.getLogger(__name__)

BIND_PATH = REGISTRY_DIR / "conv_bindings.json"

# How long a binding survives without a heartbeat (a gated send refreshes
# last_seen). Long enough to cover a working session between messages,
# short enough that a crashed/abandoned session releases the conv.
BIND_TTL = 1800.0


def _read_all() -> dict:
    try:
        return json.loads(BIND_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _write_all(state: dict) -> None:
    try:
        BIND_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = BIND_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        os.replace(tmp, BIND_PATH)
    except OSError:
        logger.debug("conv_binding: state write failed", exc_info=True)


def binding_for(conv_id: str, *, now: float | None = None) -> dict | None:
    """The live binding for ``conv_id``, or None if free/expired/dead."""
    if not isinstance(conv_id, str) or not conv_id:
        return None
    entry = _read_all().get(conv_id)
    if not isinstance(entry, dict):
        return None
    now = time.time() if now is None else now
    last_seen = entry.get("last_seen")
    if not isinstance(last_seen, (int, float)) or now - last_seen > BIND_TTL:
        return None
    owner = entry.get("owner_pid")
    if isinstance(owner, int) and owner != os.getpid() and not _pid_alive(owner):
        return None
    return entry


def claim(conv_id: str, session_key: str) -> None:
    """Bind ``conv_id`` to ``session_key`` (fresh claim or takeover)."""
    if not isinstance(conv_id, str) or not conv_id or not session_key:
        return
    state = _read_all()
    prev = state.get(conv_id) or {}
    state[conv_id] = {
        "session_key": session_key,
        "owner_pid": os.getpid(),
        "claimed_at": prev.get("claimed_at", time.time()),
        "last_seen": time.time(),
    }
    _write_all(state)


def heartbeat(conv_id: str, session_key: str) -> None:
    """Refresh ``last_seen`` — only for the current owner."""
    if not isinstance(conv_id, str) or not conv_id or not session_key:
        return
    state = _read_all()
    entry = state.get(conv_id)
    if not isinstance(entry, dict) or entry.get("session_key") != session_key:
        return
    entry["last_seen"] = time.time()
    _write_all(state)


def release(conv_id: str, session_key: str) -> None:
    """Unbind — only by the owning session (or a dead owner's record)."""
    if not isinstance(conv_id, str) or not conv_id:
        return
    state = _read_all()
    entry = state.get(conv_id)
    if not isinstance(entry, dict):
        return
    if entry.get("session_key") == session_key or (
        isinstance(entry.get("owner_pid"), int)
        and not _pid_alive(entry["owner_pid"])
    ):
        state.pop(conv_id, None)
        _write_all(state)


async def gate_check(
    driver,
    conv_id: str | None,
    session_key: str | None,
    *,
    confirmed: bool,
    project_label: str | None = None,
) -> dict | None:
    """Enforce first-bind user confirmation for a send target.

    Returns ``None`` when the send may proceed (binding already belongs to
    this session — heartbeated — or ``confirmed`` claimed it). Otherwise
    returns a ``confirmation_required`` payload describing the target for
    the human to approve.

    Fresh chats (``conv_id=None``) also require confirmation — the user
    approves "open a new conversation (under project X)" before the send
    creates it. Only a missing session identity bypasses the gate: there
    is nothing to bind to without one.
    """
    if not session_key:
        return None

    if not isinstance(conv_id, str) or not conv_id:
        # Fresh chat — or a non-string conv sentinel (defensive: mock
        # drivers in tests) — treated as the new-conversation branch.
        if confirmed:
            return None
        action = (
            "This send will CREATE a new conversation"
            + (f" under project {project_label}" if project_label else "")
            + ". If the user already explicitly authorized this target and action, "
            "retry the same request with confirm=true. Otherwise show this target "
            "to the user and obtain approval before setting confirm=true. "
            "A reconnect does not invalidate existing approval."
        )
        return {
            # content/model/conversation_id satisfy the tool output schema.
            "content": action,
            "model": "",
            "conversation_id": "",
            "status": "confirmation_required",
            "is_new_conversation": True,
            "conversation_title": None,
            "project": project_label,
            "occupied": False,
            "occupied_by": None,
            "generating": False,
            "action": action,
        }

    rec = binding_for(conv_id)
    if rec and rec.get("session_key") == session_key:
        heartbeat(conv_id, session_key)
        return None
    if confirmed:
        claim(conv_id, session_key)
        return None

    # Build the confirmation payload. DOM probes are best-effort: a
    # missing/broken probe must not turn the gate into a send-blocker.
    title = None
    try:
        raw = await driver._js("document.title", timeout=5)
        if isinstance(raw, str) and raw.strip():
            title = raw.strip()
            for suffix in (" - ChatGPT", " | ChatGPT"):
                if title.endswith(suffix):
                    title = title[: -len(suffix)]
    except Exception:
        pass

    generating = generation_gate.busy_remaining(conv_id) > 0
    if not generating:
        try:
            generating = bool(await driver._dom.is_generating())
        except Exception:
            generating = False

    action = (
        "This session has not bound this conversation yet. If existing explicit "
        "user approval covers this target and any occupied_by takeover, retry "
        "the same request with confirm=true. Otherwise show the project, "
        "conversation and occupied_by warning to the user and obtain approval. "
        "A reconnect does not invalidate existing approval."
    )
    payload = {
        # content/model/conversation_id satisfy the tool output schema.
        "content": action,
        "model": "",
        "status": "confirmation_required",
        "is_new_conversation": False,
        "conversation_id": conv_id,
        "conversation_title": title,
        "project": project_label,
        "occupied": rec is not None,
        "occupied_by": rec.get("session_key") if rec else None,
        "generating": generating,
        "action": action,
    }
    if rec is not None:
        last_seen = rec.get("last_seen")
        if isinstance(last_seen, (int, float)):
            payload["occupied_idle_s"] = int(time.time() - last_seen)
    return payload
