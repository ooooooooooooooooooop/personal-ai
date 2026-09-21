"""Focused offline regressions for conversation read/wait reliability.

These tests exercise the actual MCP business functions with mocked drivers;
they never attach to Chrome or send a web message.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest


def _payload(messages, *, status=None):
    mapping = {}
    parent = None
    for index, (role, text) in enumerate(messages):
        node_id = f"n{index}"
        msg = {
            "author": {"role": role},
            "content": {"parts": [text]},
        }
        if status is not None and index == len(messages) - 1:
            msg["status"] = status
        mapping[node_id] = {"parent": parent, "message": msg}
        parent = node_id
    return {"id": "c", "current_node": parent, "mapping": mapping}


@pytest.mark.asyncio
async def test_wait_user_tail_with_live_dom_is_timeout_not_dead(monkeypatch):
    from chatgpt_web2api import conv_dom_read
    from chatgpt_web2api.mcp_server import do_wait_reply

    async def live_tail(*_args):
        return {
            "rendered_total": 2,
            "last_role": "user",
            "generating": True,
            "tail_text": "question",
        }

    monkeypatch.setattr(conv_dom_read, "conv_tail_state", live_tail)
    driver = MagicMock()
    driver.port = 9222
    result = await do_wait_reply(
        driver,
        {
            "conversation_id": "c",
            "timeout_seconds": 1,
            "poll_seconds": 8,
            "dead_after_seconds": 0,
        },
    )

    assert result["status"] == "timeout"
    assert result["status"] != "dead"
    assert result["tail_status"] == "in_progress"
    assert result["observation"] == "generation_in_progress"


@pytest.mark.asyncio
async def test_wait_bounds_slow_backend_read_to_absolute_deadline(monkeypatch):
    from chatgpt_web2api import conv_dom_read
    from chatgpt_web2api.mcp_server import do_wait_reply

    monkeypatch.setattr(conv_dom_read, "conv_tail_state", AsyncMock(return_value=None))

    async def slow_fetch(_conversation_id):
        await asyncio.sleep(10)
        return _payload([("user", "q")])

    driver = MagicMock()
    driver.port = 9222
    driver.get_conversation = slow_fetch
    loop = asyncio.get_running_loop()
    started = loop.time()
    result = await do_wait_reply(
        driver,
            {"conversation_id": "c", "timeout_seconds": 1, "poll_seconds": 8},
    )
    elapsed = loop.time() - started

    assert result["status"] == "timeout"
    assert result["observation"] == "backend_read_timeout"
    assert elapsed < 2


@pytest.mark.asyncio
async def test_dom_slow_target_discovery_is_cancellable(monkeypatch):
    """Synchronous /json/list discovery must not block an async deadline."""
    from chatgpt_web2api import conv_dom_read

    def slow_discovery(*_args):
        time.sleep(0.5)
        return "ws://never-used"

    monkeypatch.setattr(conv_dom_read, "_conv_ws_url", slow_discovery)
    started = asyncio.get_running_loop().time()
    result = await conv_dom_read._eval_on_conv_tab(9222, "c", "0", timeout=0.05)
    elapsed = asyncio.get_running_loop().time() - started

    assert result is None
    assert elapsed < 0.25


@pytest.mark.asyncio
async def test_dom_fallback_does_not_fabricate_page_metadata_or_skip_out_file(
    monkeypatch, tmp_path: Path
):
    from chatgpt_web2api import conv_dom_read
    from chatgpt_web2api.mcp_server import do_get_conversation
    from chatgpt_web2api.request_pace import ReadThrottledError

    driver = MagicMock()
    driver.port = 9222
    driver.get_conversation = AsyncMock(side_effect=ReadThrottledError(30))
    monkeypatch.setattr(
        conv_dom_read,
        "conv_messages",
        AsyncMock(return_value=[{"role": "assistant", "content": "tail"}]),
    )
    out_file = tmp_path / "tail.txt"

    result = await do_get_conversation(
        driver,
        {
            "conversation_id": "c",
            "offset": 100,
            "limit": 2,
            "out_file": str(out_file),
        },
    )

    assert result["reason"] == "partial"
    assert result["source"] == "dom"
    assert result["partial"] is True
    assert result["paging_supported"] is False
    assert result["requested_offset"] == 100
    assert result["offset"] is None
    assert result["total"] is None
    assert result["has_more"] is None
    assert result["messages_written"] == 1
    assert out_file.read_text(encoding="utf-8") == "## assistant\n\ntail\n\n"
    assert "messages" not in result


@pytest.mark.asyncio
async def test_tail_read_uses_one_backend_fetch_and_returns_absolute_page():
    from chatgpt_web2api.mcp_server import do_get_conversation

    driver = MagicMock()
    driver.get_conversation = AsyncMock(
        return_value=_payload(
            [("user", "q1"), ("assistant", "a1"), ("user", "q2"), ("assistant", "a2")]
        )
    )
    result = await do_get_conversation(
        driver,
        {"conversation_id": "c", "tail": 2},
    )

    assert [item["content"] for item in result["messages"]] == ["q2", "a2"]
    assert result["offset"] == 2
    assert result["total"] == 4
    assert result["has_more"] is False
    driver.get_conversation.assert_awaited_once_with("c")


@pytest.mark.asyncio
async def test_fresh_read_bypasses_cache(monkeypatch):
    from chatgpt_web2api import mcp_server as server

    monkeypatch.setattr(server, "_conv_read_ttl", lambda _driver: 60.0)
    driver = MagicMock()
    first = {"id": "c", "mapping": {}}
    second = {"id": "c", "mapping": {"fresh": True}}
    driver.get_conversation = AsyncMock(side_effect=[first, second])

    cached = await server._conv_read_coalesced(driver, "c", contextlib.nullcontext())
    fresh = await server._conv_read_coalesced(
        driver, "c", contextlib.nullcontext(), fresh=True
    )

    assert cached is first
    assert fresh is second
    assert driver.get_conversation.await_count == 2


@pytest.mark.asyncio
async def test_last_cancelled_read_waiter_cancels_shared_fetch():
    from chatgpt_web2api import mcp_server as server

    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def never_fetch(_conversation_id):
        started.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    driver = MagicMock()
    driver.get_conversation = never_fetch
    task = asyncio.create_task(
        server._conv_read_coalesced(driver, "c", contextlib.nullcontext())
    )
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    await asyncio.wait_for(cancelled.wait(), timeout=0.5)
    assert "c" not in server._CONV_READ_INFLIGHT


@pytest.mark.asyncio
async def test_cancelled_flight_is_not_joined_by_immediate_retry():
    from chatgpt_web2api import mcp_server as server

    started = asyncio.Event()
    second_started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def fetch(_conversation_id):
        nonlocal calls
        calls += 1
        started.set()
        if calls == 2:
            second_started.set()
        await release.wait()
        return {"id": "c", "mapping": {"call": calls}}

    driver = MagicMock()
    driver.get_conversation = fetch
    first = asyncio.create_task(
        server._conv_read_coalesced(driver, "c", contextlib.nullcontext())
    )
    await started.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    # The cancelled task is removed synchronously from the flight map; a new
    # caller creates a fresh flight instead of joining the cancelling task.
    retry = asyncio.create_task(
        server._conv_read_coalesced(driver, "c", contextlib.nullcontext())
    )
    await asyncio.wait_for(second_started.wait(), timeout=0.5)
    assert calls == 2
    release.set()
    result = await retry
    assert result["id"] == "c"


@pytest.mark.asyncio
async def test_since_total_dom_uses_same_tab_anchor_not_absolute_backend_total(
    monkeypatch,
):
    from chatgpt_web2api import conv_dom_read
    from chatgpt_web2api.mcp_server import do_wait_reply
    from chatgpt_web2api.request_pace import ReadThrottledError

    states = iter(
        [
            {
                "rendered_total": 4,
                "last_role": "assistant",
                "generating": False,
                "tail_text": "old reply",
            },
            {
                "rendered_total": 4,
                "last_role": "assistant",
                "generating": False,
                "tail_text": "new reply",
            },
        ]
    )

    async def read_tail(*_args):
        return next(states)

    monkeypatch.setattr(conv_dom_read, "conv_tail_state", read_tail)
    monkeypatch.setattr("chatgpt_web2api.mcp_server.asyncio.sleep", AsyncMock())
    driver = MagicMock()
    driver.port = 9222
    driver.get_conversation = AsyncMock(side_effect=ReadThrottledError(30))
    result = await do_wait_reply(
        driver,
        {
            "conversation_id": "c",
            "since_total": 100,
            "timeout_seconds": 1,
            "poll_seconds": 8,
        },
    )

    assert result["status"] == "replied"
    assert result["source"] == "dom"
    assert result["total_kind"] == "rendered_lower_bound"
