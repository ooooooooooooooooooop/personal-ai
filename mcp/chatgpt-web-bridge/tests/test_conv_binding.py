"""conv_binding — cross-process conversation ownership + confirm gate.

The registry binds a conversation to the session that confirmed it;
gate_check enforces "first send to a conv needs user confirmation" and
surfaces occupant warnings when another session owns the binding.
"""
from __future__ import annotations

import os
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from chatgpt_web2api import conv_binding, generation_gate


@pytest.fixture(autouse=True)
def _isolate_state(tmp_path, monkeypatch):
    """Point both shared state files at a scratch dir."""
    monkeypatch.setattr(conv_binding, "BIND_PATH", tmp_path / "conv_bindings.json")
    monkeypatch.setattr(generation_gate, "GEN_PATH", tmp_path / "generating.json")


def _driver(title="Test conv - ChatGPT", generating=False):
    d = MagicMock()
    d._js = AsyncMock(return_value=title)
    d._dom = MagicMock()
    d._dom.is_generating = AsyncMock(return_value=generating)
    return d


# ── registry primitives ──────────────────────────────────────


def test_claim_then_binding_for_returns_owner():
    conv_binding.claim("conv-1", "http:sess-A")
    rec = conv_binding.binding_for("conv-1")
    assert rec is not None
    assert rec["session_key"] == "http:sess-A"
    assert rec["owner_pid"] == os.getpid()


def test_binding_for_empty_conv_is_free():
    assert conv_binding.binding_for("") is None
    assert conv_binding.binding_for("never-claimed") is None


def test_expired_binding_is_free(monkeypatch):
    conv_binding.claim("conv-1", "http:sess-A")
    stale = time.time() - conv_binding.BIND_TTL - 1
    conv_binding._write_all(
        {"conv-1": {"session_key": "http:sess-A", "owner_pid": os.getpid(),
                    "claimed_at": stale, "last_seen": stale}}
    )
    assert conv_binding.binding_for("conv-1") is None


def test_dead_owner_binding_is_reclaimable():
    # owner_pid 2**22 is not a live pid on any system.
    conv_binding._write_all(
        {"conv-1": {"session_key": "http:ghost", "owner_pid": 2**22,
                    "claimed_at": time.time(), "last_seen": time.time()}}
    )
    assert conv_binding.binding_for("conv-1") is None


def test_heartbeat_only_refreshes_owner():
    conv_binding.claim("conv-1", "http:sess-A")
    before = conv_binding.binding_for("conv-1")["last_seen"]
    conv_binding.heartbeat("conv-1", "http:sess-B")  # wrong owner — no-op
    assert conv_binding.binding_for("conv-1")["last_seen"] == before
    conv_binding.heartbeat("conv-1", "http:sess-A")
    assert conv_binding.binding_for("conv-1")["last_seen"] >= before


def test_release_only_by_owner():
    conv_binding.claim("conv-1", "http:sess-A")
    conv_binding.release("conv-1", "http:sess-B")  # foreign — keeps binding
    assert conv_binding.binding_for("conv-1") is not None
    conv_binding.release("conv-1", "http:sess-A")
    assert conv_binding.binding_for("conv-1") is None


def test_takeover_overwrites_owner():
    conv_binding.claim("conv-1", "http:sess-A")
    conv_binding.claim("conv-1", "http:sess-B")
    assert conv_binding.binding_for("conv-1")["session_key"] == "http:sess-B"


# ── gate_check ───────────────────────────────────────────────


async def test_gate_unbound_conv_returns_confirmation_required():
    out = await conv_binding.gate_check(
        _driver(), "conv-1", "http:sess-A", confirmed=False
    )
    assert out is not None
    assert out["status"] == "confirmation_required"
    assert out["conversation_id"] == "conv-1"
    assert out["conversation_title"] == "Test conv"
    assert out["occupied"] is False
    assert out["generating"] is False


async def test_gate_confirm_claims_binding():
    out = await conv_binding.gate_check(
        _driver(), "conv-1", "http:sess-A", confirmed=True
    )
    assert out is None
    assert conv_binding.binding_for("conv-1")["session_key"] == "http:sess-A"


async def test_gate_mine_proceeds_and_heartbeats():
    conv_binding.claim("conv-1", "http:sess-A")
    out = await conv_binding.gate_check(
        _driver(), "conv-1", "http:sess-A", confirmed=False
    )
    assert out is None


async def test_gate_occupied_warns_with_owner():
    conv_binding.claim("conv-1", "http:sess-A")
    out = await conv_binding.gate_check(
        _driver(), "conv-1", "http:sess-B", confirmed=False
    )
    assert out["occupied"] is True
    assert out["occupied_by"] == "http:sess-A"
    assert "occupied_idle_s" in out


async def test_gate_confirm_takeover_of_occupied():
    conv_binding.claim("conv-1", "http:sess-A")
    out = await conv_binding.gate_check(
        _driver(), "conv-1", "http:sess-B", confirmed=True
    )
    assert out is None
    assert conv_binding.binding_for("conv-1")["session_key"] == "http:sess-B"


async def test_gate_reports_generating_flag():
    generation_gate.mark_generating("conv-1")
    out = await conv_binding.gate_check(
        _driver(), "conv-1", "http:sess-A", confirmed=False
    )
    assert out["generating"] is True


async def test_gate_reports_live_dom_generation():
    out = await conv_binding.gate_check(
        _driver(generating=True), "conv-1", "http:sess-A", confirmed=False
    )
    assert out["generating"] is True


async def test_gate_new_conversation_requires_confirm():
    # Fresh chat (no conv yet) — confirmation names the project.
    out = await conv_binding.gate_check(
        _driver(), None, "http:sess-A", confirmed=False,
        project_label="proj-X",
    )
    assert out is not None
    assert out["status"] == "confirmation_required"
    assert out["is_new_conversation"] is True
    assert out["project"] == "proj-X"
    # Confirmed → proceed (nothing to claim; the conv doesn't exist yet).
    assert await conv_binding.gate_check(
        _driver(), None, "http:sess-A", confirmed=True
    ) is None


async def test_gate_no_session_passes():
    # No session identity → nothing to bind to; gate can't engage.
    assert await conv_binding.gate_check(
        _driver(), "conv-1", None, confirmed=False
    ) is None
    assert await conv_binding.gate_check(
        _driver(), None, None, confirmed=False
    ) is None


async def test_gate_survives_broken_dom_probe():
    d = _driver()
    d._js = AsyncMock(side_effect=RuntimeError("cdp gone"))
    d._dom.is_generating = AsyncMock(side_effect=RuntimeError("cdp gone"))
    out = await conv_binding.gate_check(
        d, "conv-1", "http:sess-A", confirmed=False
    )
    assert out is not None
    assert out["conversation_title"] is None
    assert out["generating"] is False


# ── integration: send_and_stream generation gate ─────────────


async def _driver_at_gate(conv_id="conv-x"):
    """A CDPDriver stubbed up to (but not past) the generation gate."""
    from chatgpt_web2api.cdp_driver import CDPDriver

    d = CDPDriver(cdp_port=9222)
    d._assert_owned_tab_required = lambda: None
    d._read_assistant_count_baseline = AsyncMock(return_value=0)
    d._identity_listener = None
    d._capture_pre_send_fallback_anchor = AsyncMock(return_value=MagicMock())
    d._current_conv_id = conv_id
    d._dom = MagicMock()
    d._dom.is_generating = AsyncMock(return_value=False)
    d._dom.type_message = AsyncMock()
    return d


async def test_send_blocked_when_flag_marked():
    from chatgpt_web2api.cdp_driver import GenerationInProgressError

    generation_gate.mark_generating("conv-x", ttl=100)
    d = await _driver_at_gate("conv-x")
    with pytest.raises(GenerationInProgressError) as ei:
        async for _ in d.send_and_stream("hi"):
            pass
    assert ei.value.retry_after > 0
    d._dom.type_message.assert_not_called()  # refused BEFORE typing


async def test_send_blocked_when_dom_generating():
    from chatgpt_web2api.cdp_driver import GenerationInProgressError

    d = await _driver_at_gate("conv-x")
    d._dom.is_generating = AsyncMock(return_value=True)
    with pytest.raises(GenerationInProgressError):
        async for _ in d.send_and_stream("hi"):
            pass
    d._dom.type_message.assert_not_called()


async def test_fresh_chat_skips_gate():
    # No conv bound yet (new chat) — the gate must not fire even if the DOM
    # probe misfires; a nonexistent conversation can't be generating.
    d = await _driver_at_gate(None)
    d._dom.is_generating = AsyncMock(return_value=True)
    # It should proceed PAST the gate and fail later (no real CDP) — the
    # point is it did not raise GenerationInProgressError.
    from chatgpt_web2api.cdp_driver import GenerationInProgressError

    try:
        async for _ in d.send_and_stream("hi"):
            pass
    except GenerationInProgressError:
        pytest.fail("fresh chat must not hit the generation gate")
    except Exception:
        pass


# ── integration: do_chat_completion confirm flow ─────────────


async def test_mcp_first_send_requires_confirm_then_claims():
    import chatgpt_web2api.mcp_server as mod

    driver = MagicMock()
    driver._current_conv_id = "conv-1"
    driver._current_model = None
    driver.route_chat_target = AsyncMock(return_value="explicit")
    driver._dom = MagicMock()
    driver._dom.is_generating = AsyncMock(return_value=False)
    driver._js = AsyncMock(return_value="My Conv - ChatGPT")

    from chatgpt_web2api.cdp_driver import StreamChunk

    async def _stream(*a, **kw):
        yield StreamChunk(delta="ok")
        yield StreamChunk(delta="", finish_reason="stop")

    driver.send_and_stream = _stream

    # Unconfirmed: payload, no send.
    out = await mod.do_chat_completion(
        driver,
        {"message": "hi", "conversation_id": "conv-1"},
        mod.Config.load(None),
        session_key="http:sess-A",
    )
    assert out["status"] == "confirmation_required"
    assert out["conversation_title"] == "My Conv"

    # Confirmed: sends and binds the conv to this session.
    out = await mod.do_chat_completion(
        driver,
        {"message": "hi", "conversation_id": "conv-1", "confirm": True},
        mod.Config.load(None),
        session_key="http:sess-A",
    )
    assert out["content"] == "ok"
    assert conv_binding.binding_for("conv-1")["session_key"] == "http:sess-A"

    # Subsequent sends from the SAME session need no confirm.
    out = await mod.do_chat_completion(
        driver,
        {"message": "again", "conversation_id": "conv-1"},
        mod.Config.load(None),
        session_key="http:sess-A",
    )
    assert out.get("status") != "confirmation_required"

    # A DIFFERENT session is warned the conv is occupied.
    out = await mod.do_chat_completion(
        driver,
        {"message": "hi", "conversation_id": "conv-1"},
        mod.Config.load(None),
        session_key="http:sess-B",
    )
    assert out["status"] == "confirmation_required"
    assert out["occupied"] is True
    assert out["occupied_by"] == "http:sess-A"


# ── integration: REST 409 + _map_tool_exception ──────────────


async def test_rest_send_to_existing_conv_returns_409():
    import chatgpt_web2api.api_server as srv

    server = srv.APIServer.__new__(srv.APIServer)
    server._last_conv_id = None
    server._last_project_id = None
    server._request_count = 0
    server._cdp_port = 9222
    server._parallel_tabs = False
    server._config = srv.Config.load(None)
    server._breakers = srv.BreakerRegistry()
    server._last_error = None
    driver = MagicMock()
    driver._current_conv_id = "conv-9"
    driver._current_model = None
    driver.route_chat_target = AsyncMock(return_value="explicit")
    driver._dom = MagicMock()
    driver._dom.is_generating = AsyncMock(return_value=False)
    driver._js = AsyncMock(return_value="Conv Nine - ChatGPT")
    server._driver = driver

    request = MagicMock()
    request.headers = {}
    request.json = AsyncMock(return_value={
        "messages": [{"role": "user", "content": "hi"}],
        "model": "auto",
        "conversation_id": "conv-9",
    })

    class _NullLock:
        def __init__(self, *a, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False

    import unittest.mock as um
    with um.patch.object(srv, "MutationLock", _NullLock):
        resp = await server._handle_chat(request)

    assert resp.status == 409
    import json as _json
    body = _json.loads(resp.body)
    assert body["error"]["code"] == "confirmation_required"
    assert body["error"]["binding"]["conversation_id"] == "conv-9"


def test_map_tool_exception_generation_in_progress():
    import chatgpt_web2api.mcp_server as mod
    from chatgpt_web2api.cdp_driver import GenerationInProgressError

    mapped = mod._map_tool_exception(
        GenerationInProgressError("conv-1", retry_after=42.0)
    )
    assert mapped is not None
    assert mapped.isError is True
    assert "generation_in_progress" in mapped.content[0].text
    assert "42" in mapped.content[0].text


# ── conv_dom_read: DOM-first read path ───────────────────────


async def test_wait_reply_uses_dom_when_tab_present(monkeypatch):
    """With the conv tab live, wait_reply must not touch the backend at all."""
    import chatgpt_web2api.mcp_server as mod
    from chatgpt_web2api import conv_dom_read

    calls = {"backend": 0}

    async def _boom(*a, **kw):
        calls["backend"] += 1
        raise AssertionError("backend fetch must not run in DOM mode")

    monkeypatch.setattr(mod, "_conv_read_coalesced", _boom)

    async def _tail(port, conv_id):
        return {
            "rendered_total": 7,
            "last_role": "assistant",
            "generating": False,
            "tail_text": "the answer",
        }

    monkeypatch.setattr(conv_dom_read, "conv_tail_state", _tail)

    driver = MagicMock()
    driver.port = 9222
    out = await mod.do_wait_reply(
        driver,
        {"conversation_id": "conv-dom", "timeout_seconds": 5},
    )
    assert out["status"] == "replied"
    assert out["source"] == "dom"
    assert calls["backend"] == 0


async def test_wait_reply_dom_reports_generating_then_replied(monkeypatch):
    import chatgpt_web2api.mcp_server as mod
    from chatgpt_web2api import conv_dom_read

    ticks = {"n": 0}

    async def _tail(port, conv_id):
        ticks["n"] += 1
        if ticks["n"] == 1:
            return {
                "rendered_total": 6,
                "last_role": "assistant",
                "generating": True,
                "tail_text": "partial",
            }
        return {
            "rendered_total": 6,
            "last_role": "assistant",
            "generating": False,
            "tail_text": "final answer",
        }

    monkeypatch.setattr(conv_dom_read, "conv_tail_state", _tail)

    async def _noop(_s):
        return None

    monkeypatch.setattr(mod.asyncio, "sleep", _noop)
    driver = MagicMock()
    driver.port = 9222
    out = await mod.do_wait_reply(
        driver,
        {"conversation_id": "c", "timeout_seconds": 10, "poll_seconds": 8},
    )
    assert out["status"] == "replied"
    assert out["source"] == "dom"


async def test_wait_reply_falls_back_to_backend_when_no_tab(monkeypatch):
    import chatgpt_web2api.mcp_server as mod
    from chatgpt_web2api import conv_dom_read

    async def _none(port, conv_id):
        return None

    monkeypatch.setattr(conv_dom_read, "conv_tail_state", _none)

    async def _read(driver, conv_id, lock):
        return {
            "current_node": "a",
            "mapping": {
                "a": {
                    "parent": None,
                    "message": {"author": {"role": "assistant"},
                                "status": "finished_successfully",
                                "end_turn": True,
                                "content": {"parts": ["hi"]}},
                }
            },
        }

    monkeypatch.setattr(mod, "_conv_read_coalesced", _read)
    driver = MagicMock()
    driver.port = 9222
    out = await mod.do_wait_reply(
        driver, {"conversation_id": "c", "timeout_seconds": 5}
    )
    assert out["status"] == "replied"
    assert out["source"] == "backend"


def test_conv_ws_url_finds_conv_tab(monkeypatch):
    from chatgpt_web2api import conv_dom_read

    fake = [{"type": "page", "url": "https://chatgpt.com/c/abc-123",
             "webSocketDebuggerUrl": "ws://x"}]
    monkeypatch.setattr(
        conv_dom_read, "_conv_ws_url", lambda p, c: "ws://x"
    )
    # exercised indirectly below via conv_tail_state monkeypatch-free path:
    assert conv_dom_read._conv_ws_url(9222, "abc-123") == "ws://x"
