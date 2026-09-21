import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from chatgpt_web2api import send_receipts as receipts
from chatgpt_web2api.cdp_driver import RateLimitError
from chatgpt_web2api.mcp_server import do_get_send_status
from chatgpt_web2api.resilience import retry_on_rate_limit

REQUEST = {"tool": "chat_completion", "message": "private prompt", "project_id": "project-a"}


async def test_cancel_after_click_is_durable_and_cannot_resend():
    calls = []

    async def send():
        calls.append(1)
        receipts.mark(state="delivery_unknown")
        receipts.mark(state="dispatched", message_id="user-1", conversation_id="conv-1")
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await receipts.run(REQUEST, "operation-1", send)
    result = await do_get_send_status(None, {"operation_id": "operation-1"})
    assert result["state"] == "dispatched"
    assert result["observation_cancelled"] is True
    assert result["can_retry_send"] is False
    with pytest.raises(receipts.SendAlreadyRecorded):
        await receipts.run(REQUEST, "operation-1", send)
    # A reconnected legacy caller also cannot replay an unresolved identical send.
    with pytest.raises(receipts.SendAlreadyRecorded):
        await receipts.run(REQUEST, None, send)
    assert calls == [1]
    assert b"private prompt" not in receipts.DB_PATH.read_bytes()


async def test_payload_conflict_rejected_before_action():
    action = AsyncMock(return_value={"status": "confirmation_required"})
    await receipts.run(REQUEST, "operation-1", action)
    with pytest.raises(receipts.SendConflictError):
        await receipts.run(REQUEST | {"project_id": "project-b"}, "operation-1", action)
    assert action.await_count == 1


async def test_pre_submit_failure_can_retry_same_id():
    action = AsyncMock(side_effect=[RuntimeError("page failed"), {"content": "ok"}])
    with pytest.raises(RuntimeError):
        await receipts.run(REQUEST, "operation-1", action)
    assert receipts.get("operation-1")["state"] == "not_sent"
    await receipts.run(REQUEST, "operation-1", action)
    assert action.await_count == 2


async def test_concurrent_same_id_has_one_owner():
    entered, release = asyncio.Event(), asyncio.Event()

    async def action():
        entered.set()
        await release.wait()
        receipts.mark(state="delivery_unknown")
        return {}

    first = asyncio.create_task(receipts.run(REQUEST, "operation-1", action))
    await entered.wait()
    try:
        with pytest.raises(receipts.SendAlreadyRecorded):
            await receipts.run(REQUEST, "operation-1", action)
    finally:
        release.set()
        await first


async def test_post_submit_rate_limit_never_calls_factory_again():
    driver = MagicMock()
    driver.dismiss_rate_limit = AsyncMock()
    calls = []

    async def action():
        async def factory():
            calls.append(1)
            receipts.mark(state="delivery_unknown")
            raise RateLimitError(retry_after=1)
        return await retry_on_rate_limit(driver, factory)

    with pytest.raises(RateLimitError):
        await receipts.run(REQUEST, "operation-1", action)
    assert calls == [1]


async def test_reconciliation_requires_matching_user_and_own_descendant():
    async def action():
        receipts.mark(state="dispatched", message_id="u1", conversation_id="c1")
        return {}
    await receipts.run(REQUEST, "operation-1", action)
    assert receipts.reconcile("operation-1", {"_fetch_status": 403})["state"] == "dispatched"
    mapping = {
        "u1": {"message": {"id": "u1", "author": {"role": "user"}}},
        "u2": {"parent": "u1", "message": {"id": "u2", "author": {"role": "user"}}},
        "a2": {"parent": "u2", "message": {"id": "a2", "author": {"role": "assistant"}, "end_turn": True, "status": "finished_successfully"}},
    }
    assert receipts.reconcile("operation-1", {"id": "c1", "mapping": mapping})["state"] == "delivered"
    mapping["a2"]["parent"] = "u1"
    assert receipts.reconcile("operation-1", {"id": "c1", "mapping": mapping})["state"] == "completed"
    with pytest.raises(receipts.SendAlreadyRecorded):
        await receipts.run(REQUEST, "operation-1", action)


async def test_sqlite_claim_survives_new_connection():
    async def action():
        receipts.mark(state="delivery_unknown")
        return {}
    await receipts.run(REQUEST, "operation-1", action)
    # Read independently of the ContextVar/Receipt object and its connection.
    import sqlite3
    with sqlite3.connect(receipts.DB_PATH) as db:
        row = db.execute("SELECT data FROM sends WHERE operation_id='operation-1'").fetchone()
    assert json.loads(row[0])["state"] == "delivery_unknown"


@pytest.mark.parametrize("phase", ["preparing", "delivery_unknown"])
async def test_crashed_process_retains_submission_boundary(phase):
    import os
    import subprocess
    import sys

    code = """
import asyncio, os, sys
from pathlib import Path
from chatgpt_web2api import send_receipts as receipts
receipts.DB_PATH = Path(sys.argv[1])
async def action():
    if sys.argv[2] == 'delivery_unknown':
        receipts.mark(state='delivery_unknown')
    os._exit(23)
asyncio.run(receipts.run({'message':'crash fixture'}, 'crash-operation', action))
"""
    crashed = subprocess.run(
        [sys.executable, "-c", code, str(receipts.DB_PATH), phase],
        capture_output=True, timeout=10,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    assert crashed.returncode == 23, crashed.stderr
    assert receipts.get("crash-operation")["state"] == phase
    action = AsyncMock(return_value={})
    if phase == "delivery_unknown":
        with pytest.raises(receipts.SendAlreadyRecorded):
            await receipts.run({"message": "crash fixture"}, "crash-operation", action)
        action.assert_not_awaited()
    else:
        await receipts.run({"message": "crash fixture"}, "crash-operation", action)
        action.assert_awaited_once()
