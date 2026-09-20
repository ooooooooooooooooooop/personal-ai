"""Durable send receipts. Cancellation stops observation, never undoes a POST.

The write before click is the safety boundary: after it, an uncertain result
cannot authorize a second submission. SQLite transactions arbitrate callers
across REST/MCP processes. No prompt, token or cookie is stored here.
"""

from __future__ import annotations

import contextvars
from contextlib import closing
import hashlib
import json
import os
import re
import sqlite3
import time
import uuid
from pathlib import Path

from .tab_registry import _pid_alive

DB_PATH = Path.home() / ".chatgpt-web2api" / "send_receipts.sqlite3"
BUILD_ID = hashlib.sha256(b"".join(
    p.name.encode() + p.read_bytes() for p in sorted(Path(__file__).parent.glob("*.py"))
)).hexdigest()[:16]
_current = contextvars.ContextVar("send_receipt", default=None)
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
_SUBMITTED = {"delivery_unknown", "dispatched", "delivered", "reply_received", "completed"}


class SendConflictError(ValueError):
    """An operation ID was reused for a different logical send."""


class SendAlreadyRecorded(RuntimeError):
    def __init__(self, record: dict):
        self.receipt = public_record(record)
        super().__init__(
            f"Send {record['operation_id']} is {record['state']}; "
            "no message was resubmitted. Query get_send_status or the original conversation."
        )


def _connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=5, isolation_level=None)
    db.execute("PRAGMA busy_timeout=5000")
    db.execute("""CREATE TABLE IF NOT EXISTS sends (
        operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
        state TEXT NOT NULL, updated_at REAL NOT NULL, data TEXT NOT NULL
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS sends_fingerprint ON sends(fingerprint)")
    return db


def _write(db, record):
    record["updated_at"] = time.time()
    db.execute(
        "INSERT OR REPLACE INTO sends VALUES (?, ?, ?, ?, ?)",
        (record["operation_id"], record["fingerprint"], record["state"],
         record["updated_at"], json.dumps(record, ensure_ascii=False)),
    )


def get(operation_id: str) -> dict | None:
    if not DB_PATH.exists():
        return None
    with closing(_connect()) as db:
        row = db.execute("SELECT data FROM sends WHERE operation_id=?", (operation_id,)).fetchone()
        return json.loads(row[0]) if row else None


def recent(limit=10) -> list[dict]:
    if not DB_PATH.exists():
        return []
    with closing(_connect()) as db:
        rows = db.execute("SELECT data FROM sends ORDER BY updated_at DESC LIMIT ?", (limit,))
        return [public_record(json.loads(row[0])) for row in rows]


def public_record(record: dict) -> dict:
    return {
        key: record.get(key)
        for key in ("operation_id", "state", "project_id", "conversation_id", "message_id",
                    "created_at", "updated_at", "error_kind", "observation_cancelled")
    } | {
        "can_retry_send": record["state"] == "not_sent",
        "next_action": (
            "retry_same_operation_id" if record["state"] == "not_sent"
            else "read_original_conversation_or_get_send_status; do_not_resend"
        ),
    }


def reject_recorded(request: dict, operation_id: str | None) -> None:
    """Read-only fast path before browser acquisition; _claim still arbitrates races."""
    if operation_id is not None and (not isinstance(operation_id, str) or not _ID.fullmatch(operation_id)):
        raise ValueError("invalid operation_id")
    if not DB_PATH.exists():
        return
    fingerprint = hashlib.sha256(
        json.dumps(request, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    with closing(_connect()) as db:
        if operation_id:
            row = db.execute("SELECT data FROM sends WHERE operation_id=?", (operation_id,)).fetchone()
        else:
            row = db.execute(
                "SELECT data FROM sends WHERE fingerprint=? AND state NOT IN "
                "('not_sent','completed') ORDER BY updated_at DESC LIMIT 1", (fingerprint,),
            ).fetchone()
    if not row:
        return
    record = json.loads(row[0])
    if record["fingerprint"] != fingerprint:
        raise SendConflictError("operation_id already belongs to a different payload or target")
    if record["state"] == "not_sent" or (
        record["state"] == "preparing" and not _pid_alive(record.get("owner_pid", 0))
    ):
        return
    raise SendAlreadyRecorded(record)


def _claim(request: dict, operation_id: str | None) -> tuple[dict, bool]:
    if operation_id is not None and (not isinstance(operation_id, str) or not _ID.fullmatch(operation_id)):
        raise ValueError("operation_id must be 1-128 letters, digits, '.', '_', ':' or '-'")
    fingerprint = hashlib.sha256(
        json.dumps(request, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()
    db = _connect()
    try:
        db.execute("BEGIN IMMEDIATE")
        if operation_id:
            row = db.execute("SELECT data FROM sends WHERE operation_id=?", (operation_id,)).fetchone()
        else:
            # Legacy callers without an ID may not re-submit an unresolved
            # identical request. Completed intentional repetitions remain valid.
            row = db.execute(
                "SELECT data FROM sends WHERE fingerprint=? AND state NOT IN "
                "('not_sent','completed') ORDER BY updated_at DESC LIMIT 1", (fingerprint,),
            ).fetchone()
        record = json.loads(row[0]) if row else None
        if record:
            if record["fingerprint"] != fingerprint:
                raise SendConflictError("operation_id already belongs to a different payload or target")
            reclaim = record["state"] == "not_sent" or (
                record["state"] == "preparing" and not _pid_alive(record.get("owner_pid", 0))
            )
            if not reclaim:
                db.commit()
                return record, False
        else:
            record = {
                "operation_id": operation_id or str(uuid.uuid4()),
                "fingerprint": fingerprint, "created_at": time.time(),
                "project_id": request.get("project_id"),
                "conversation_id": request.get("conversation_id"), "message_id": None,
            }
        record.update(state="preparing", owner_pid=os.getpid(), owner_token=str(uuid.uuid4()), active=True,
                      error_kind=None, observation_cancelled=False)
        _write(db, record)
        db.commit()
        return record, True
    finally:
        db.close()


def update(operation_id: str, *, owner_token=None, **changes) -> dict:
    db = _connect()
    try:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT data FROM sends WHERE operation_id=?", (operation_id,)).fetchone()
        if row is None:
            raise RuntimeError("send receipt disappeared; refusing an unrecorded submission")
        record = json.loads(row[0])
        if owner_token is not None and record.get("owner_token") != owner_token:
            raise RuntimeError("send receipt owner changed; refusing duplicate submission")
        for key in ("conversation_id", "message_id"):
            if not changes.get(key):
                changes.pop(key, None)
            elif record.get(key) and record[key] != changes[key]:
                raise SendConflictError(f"recorded {key} changed; refusing to rebind the send")
        # Late identity events or cancelled observers must not erase stronger evidence.
        if record["state"] in {"delivered", "completed"} and changes.get("state") in {
            "delivery_unknown", "dispatched", "reply_received",
        }:
            changes.pop("state")
        record.update(changes)
        _write(db, record)
        db.commit()
        return record
    finally:
        db.close()


class Receipt:
    def __init__(self, record):
        self.operation_id = record["operation_id"]
        self.owner_token = record["owner_token"]

    def mark(self, **changes):
        return update(self.operation_id, owner_token=self.owner_token, **changes)


def current() -> Receipt | None:
    return _current.get()


def mark(**changes):
    receipt = current()
    if receipt is not None:
        return receipt.mark(**changes)
    return None


def submission_started() -> bool:
    receipt = current()
    return bool(receipt and get(receipt.operation_id)["state"] in _SUBMITTED)


async def run(request: dict, operation_id: str | None, action):
    """Run one API send under a durable claim; action owns no retry policy."""
    if current() is not None:
        return await action()
    record, claimed = _claim(request, operation_id)
    if not claimed:
        raise SendAlreadyRecorded(record)
    receipt = Receipt(record)
    token = _current.set(receipt)
    try:
        result = await action()
        latest = get(receipt.operation_id)
        if latest["state"] == "preparing":
            latest = receipt.mark(state="not_sent")  # confirmation or pre-submit refusal
        if isinstance(result, dict):
            result = dict(result)
            result["operation_id"] = receipt.operation_id
            result["send_receipt"] = public_record(latest)
        return result
    except BaseException as exc:
        try:
            latest = get(receipt.operation_id)
            changes = {"error_kind": type(exc).__name__}
            if latest["state"] == "preparing":
                changes["state"] = "not_sent"
            if type(exc).__name__ == "CancelledError":
                changes["observation_cancelled"] = True
            latest = receipt.mark(**changes)
            exc.send_receipt = public_record(latest)
        except Exception:
            # The pre-click durable state already forbids replay. Never label
            # uncertain delivery as not_sent because the storage is unavailable.
            pass
        raise
    finally:
        try:
            receipt.mark(active=False)
        except Exception:
            pass  # already durable submission uncertainty remains conservative
        _current.reset(token)


def active_for_pid(pid: int) -> bool:
    if not DB_PATH.exists():
        return False
    with closing(_connect()) as db:
        return any(json.loads(row[0]).get("active") and json.loads(row[0]).get("owner_pid") == pid
                   for row in db.execute("SELECT data FROM sends"))


def reconcile(operation_id: str, conversation: dict) -> dict:
    """Only a matching stored user-message ID proves upstream persistence.

    Empty/partial/error responses cannot prove non-delivery. Completion must
    be an assistant descendant of that message, not merely the latest reply.
    """
    record = get(operation_id)
    if not record or not record.get("message_id"):
        return record
    if conversation.get("_fetch_status", 200) != 200:
        return record
    cid = conversation.get("id") or conversation.get("conversation_id")
    if cid and record.get("conversation_id") and cid != record["conversation_id"]:
        return record
    mapping = conversation.get("mapping") or {}
    matched = next((key for key, node in mapping.items()
                    if (node.get("message") or {}).get("id") == record["message_id"]
                    and (node.get("message") or {}).get("author", {}).get("role") == "user"), None)
    if matched is None:
        return record
    completed = False
    for node in mapping.values():
        msg = node.get("message") or {}
        if msg.get("author", {}).get("role") != "assistant" or not msg.get("end_turn"):
            continue
        if msg.get("status") not in {"finished_successfully", "complete", "completed"}:
            continue
        parent, seen = node.get("parent"), set()
        while parent in mapping and parent not in seen:
            if parent == matched:
                completed = True
                break
            seen.add(parent)
            ancestor = mapping[parent]
            if (ancestor.get("message") or {}).get("author", {}).get("role") == "user":
                break  # a subsequent user turn's reply is not ours
            parent = ancestor.get("parent")
        if completed:
            break
    return update(operation_id, state="completed" if completed or record["state"] == "completed" else "delivered")
