"""Exercise durable receipts through real MCP and local HTTP transports."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from mcp.shared.memory import create_connected_server_and_client_session

from chatgpt_web2api import mcp_server as mcp, send_receipts as receipts
from chatgpt_web2api.api_server import APIServer
from chatgpt_web2api.config import Config


async def test_mcp_receipt_and_duplicate_available_with_chrome_offline(monkeypatch):
    config = Config.load(None)
    args = {"message": "local fixture", "operation_id": "offline-reconnect", "confirm": True}

    async def cancelled_send(*args, **kwargs):
        receipts.mark(state="dispatched", message_id="u1", conversation_id="c1")
        raise asyncio.CancelledError()

    monkeypatch.setattr(mcp, "_do_chat_completion", cancelled_send)
    try:
        await mcp.do_chat_completion(None, args, config)
    except asyncio.CancelledError:
        pass
    monkeypatch.setattr(mcp, "_driver", None)
    monkeypatch.setattr(mcp, "_driver_pool", None)
    monkeypatch.setattr(mcp, "_config", config)
    async with create_connected_server_and_client_session(mcp.create_server()) as session:
        initialized = await session.initialize()
        assert receipts.BUILD_ID in initialized.serverInfo.version
        result = await session.call_tool("get_send_status", {"operation_id": args["operation_id"]})
        assert result.isError is False
        assert result.structuredContent["state"] == "dispatched"
        assert result.structuredContent["observation_cancelled"] is True
        duplicate = await session.call_tool("chat_completion", args)
        assert duplicate.isError is True
        assert duplicate.structuredContent["send_receipt"]["message_id"] == "u1"
        conflict = await session.call_tool("chat_completion", args | {"message": "changed"})
        assert conflict.isError is True
        assert "different payload" in conflict.content[0].text


async def test_rest_idempotency_header_and_persistent_status(monkeypatch):
    server = APIServer(Config.load(None), MagicMock())
    submissions = []

    async def send(request):
        submissions.append(1)
        receipts.mark(state="dispatched", message_id="u2", conversation_id="c2")
        return web.json_response({"choices": []})

    monkeypatch.setattr(server, "_handle_chat_impl", send)
    async with TestClient(TestServer(server.app)) as client:
        body = {"messages": [{"role": "user", "content": "local fixture"}]}
        first = await client.post("/v1/chat/completions", json=body, headers={"Idempotency-Key": "rest-reconnect"})
        assert first.status == 200
        assert first.headers["X-Operation-ID"] == "rest-reconnect"
        assert (await first.json())["send_receipt"]["state"] == "dispatched"
        second = await client.post("/v1/chat/completions", json=body, headers={"Idempotency-Key": "rest-reconnect"})
        assert second.status == 409
        status = await client.get("/v1/send-status?operation_id=rest-reconnect")
        assert (await status.json())["can_retry_send"] is False
        assert submissions == [1]


async def test_rest_stream_exposes_operation_before_output(monkeypatch):
    driver = MagicMock()
    driver._current_conv_id = "c3"
    driver._js_strict = AsyncMock(return_value=json.dumps({"text": ""}))
    server = APIServer(Config.load(None), driver)
    monkeypatch.setattr(server, "_check_circuit_or_recover", AsyncMock())

    async def stream(*args, **kwargs):
        from chatgpt_web2api.cdp_driver import StreamChunk
        receipts.mark(state="dispatched", message_id="u3", conversation_id="c3")
        yield StreamChunk(delta="fixture")
        yield StreamChunk(delta="", finish_reason="stop")

    driver.send_and_stream = stream

    async def send(request):
        return await server._stream_response(request, "auto", "fixture", 10)

    monkeypatch.setattr(server, "_handle_chat_impl", send)
    async with TestClient(TestServer(server.app)) as client:
        response = await client.post("/v1/chat/completions", json={
            "operation_id": "stream-reconnect", "stream": True,
            "messages": [{"role": "user", "content": "fixture"}],
        })
        assert response.status == 200
        assert response.headers["X-Operation-ID"] == "stream-reconnect"
        assert "[DONE]" in await response.text()
        assert receipts.get("stream-reconnect")["message_id"] == "u3"


async def test_identity_callback_persists_outside_request_context():
    from chatgpt_web2api.identity_listener import CaptureResult, CaptureScope
    queue = asyncio.Queue()

    async def transport_reader():
        scope = await queue.get()
        assert receipts.current() is None
        scope._resolve(CaptureResult(uuid="captured-user", reason="matched"))

    # The CDP reader exists before the request ContextVar is set.
    reader = asyncio.create_task(transport_reader())

    async def action():
        receipt = receipts.current()
        scope = CaptureScope(MagicMock(), "hash", None, "target", 1)
        scope._arm()
        scope.on_capture = lambda result: receipt.mark(state="dispatched", message_id=result.uuid)
        receipts.mark(state="delivery_unknown")
        try:
            await queue.put(scope)
            await reader
        finally:
            scope.close()
        raise asyncio.CancelledError()

    try:
        await receipts.run({"message": "fixture"}, "reader-context", action)
    except asyncio.CancelledError:
        pass
    finally:
        if not reader.done():
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
    assert receipts.get("reader-context")["message_id"] == "captured-user"
