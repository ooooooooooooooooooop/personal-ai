import hashlib
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from chatgpt_web2api import mcp_server as mcp
from chatgpt_web2api.config import Config
from chatgpt_web2api.request_pace import ReadThrottledError


def driver_for(contents):
    mapping = {}
    parent = None
    for index, content in enumerate(contents):
        node = str(index)
        mapping[node] = {
            "parent": parent,
            "message": {"author": {"role": "assistant"}, "content": {"parts": [content]}},
        }
        parent = node
    driver = MagicMock()
    driver.get_conversation = AsyncMock(return_value={
        "id": "long-conv", "current_node": parent, "mapping": mapping,
    })
    return driver


def check_export(result, contents):
    assert "messages" not in result
    payload = Path(result["out_file"]).read_bytes()
    assert payload == "".join(f"## assistant\n\n{text}\n\n" for text in contents).encode()
    assert result["file_bytes"] == len(payload)
    assert result["file_sha256"] == hashlib.sha256(payload).hexdigest()
    assert result["messages_written"] == len(contents)
    assert len(json.dumps(result, ensure_ascii=True, indent=2).encode()) < 8000


async def test_default_large_message_is_complete_file_not_truncated_json():
    text = "完整计划\n" * 6000 + "FINAL TASK 31"
    result = await mcp.do_get_conversation(driver_for([text]), {"conversation_id": "long-conv"})
    assert result["exported_automatically"] is True
    check_export(result, [text])


async def test_budget_accounts_for_client_unicode_escaping():
    text = "汉" * 1500
    assert len(text.encode()) < 8000 < len(json.dumps(text, ensure_ascii=True).encode())
    result = await mcp.do_get_conversation(driver_for([text]), {"conversation_id": "long-conv"})
    check_export(result, [text])


async def test_short_pages_keep_existing_inline_result():
    result = await mcp.do_get_conversation(driver_for(["short"]), {"conversation_id": "long-conv"})
    assert result["messages"] == [{"role": "assistant", "content": "short"}]
    assert "out_file" not in result


async def test_programmatic_client_can_request_unlimited_inline():
    text = "unlimited\n" * 3000
    result = await mcp.do_get_conversation(
        driver_for([text]), {"conversation_id": "long-conv", "max_inline_bytes": 0},
    )
    assert result["messages"][0]["content"] == text
    assert "out_file" not in result


async def test_export_keeps_selected_page_and_pagination(tmp_path):
    selected = "only selected page\n" * 2000
    result = await mcp.do_get_conversation(driver_for(["before", selected, "after"]), {
        "conversation_id": "long-conv", "offset": 1, "limit": 1,
        "out_file": str(tmp_path / "explicit.md"),
    })
    assert result["offset"] == 1 and result["total"] == 3 and result["has_more"] is True
    assert result["exported_automatically"] is False
    check_export(result, [selected])


async def test_automatic_exports_do_not_overwrite_each_other():
    first = await mcp.do_get_conversation(driver_for(["a" * 9000]), {"conversation_id": "long-conv"})
    second = await mcp.do_get_conversation(driver_for(["b" * 9000]), {"conversation_id": "long-conv"})
    assert first["out_file"] != second["out_file"]
    check_export(first, ["a" * 9000])
    check_export(second, ["b" * 9000])


@pytest.mark.parametrize("explicit", [False, True])
async def test_dom_fallback_honors_export_without_claiming_complete(monkeypatch, tmp_path, explicit):
    text = "partial rendered message\n" * 1000
    driver = driver_for([])
    driver.get_conversation = AsyncMock(side_effect=ReadThrottledError(45))
    monkeypatch.setattr(mcp.conv_dom_read, "conv_messages", AsyncMock(return_value=[
        {"role": "assistant", "content": text},
    ]))
    args = {"conversation_id": "long-conv"}
    if explicit:
        args["out_file"] = str(tmp_path / "partial.md")
    result = await mcp.do_get_conversation(driver, args)
    assert result["partial"] is True and result["source"] == "dom"
    assert result["has_more"] is True and "partial" in result["read_hint"]
    check_export(result, [text])


async def test_export_failure_does_not_fall_back_to_truncated_inline(monkeypatch, tmp_path):
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("owned fixture")
    monkeypatch.setattr(mcp, "_CONVERSATION_EXPORT_DIR", blocker)
    with pytest.raises(OSError):
        await mcp.do_get_conversation(driver_for(["x" * 9000]), {"conversation_id": "long-conv"})


async def test_real_mcp_default_long_result_exposes_complete_artifact(monkeypatch):
    text = "message line\n" * 4000
    monkeypatch.setattr(mcp, "_driver", driver_for([text]))
    monkeypatch.setattr(mcp, "_driver_pool", None)
    monkeypatch.setattr(mcp, "_config", Config.load(None))
    async with create_connected_server_and_client_session(mcp.create_server()) as session:
        await session.initialize()
        result = await session.call_tool("get_conversation", {"conversation_id": "long-conv"})
        assert result.isError is False
        check_export(result.structuredContent, [text])
