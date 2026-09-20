"""Verify the installed entrypoint through actual MCP stdio, without sending.

Run with the Python interpreter used by your MCP host. Default: startup,
tool discovery and runtime identity in lazy pool mode (no browser needed). --read uses the configured mode and adds one
list_projects call through the public MCP handler; private results are omitted.
This starts a NEW server. It cannot certify another host's existing connection.
"""
from __future__ import annotations

import argparse
import ast
import asyncio
import hashlib
import json
import os
import sys
import time
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

def expected_identity() -> dict:
    """Read the checkout as data, independently of the installed package.

    Never import its src path into the server. Otherwise an old installation
    could pass merely by agreeing with its own old version and fingerprint.
    """
    root = Path(__file__).resolve().parents[1] / "src" / "chatgpt_web2api"
    tree = ast.parse((root / "runtime_info.py").read_text(encoding="utf-8"))
    version = next(
        ast.literal_eval(node.value) for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "CONTRACT_VERSION" for target in node.targets)
    )
    digest = hashlib.sha256()
    for path in sorted(root.glob("*.py")):
        digest.update(path.name.encode("utf-8") + b"\0")
        digest.update(path.read_bytes().replace(b"\r\n", b"\n"))
        digest.update(b"\0")
    return {"contract_version": version, "source_fingerprint": digest.hexdigest()}


async def verify(read: bool, report: dict, expected: dict):
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    if not read:
        # The legacy singleton intentionally connects eagerly. Force only the
        # offline child into the supported lazy pool mode; do not edit host
        # configuration or unexpectedly launch Chrome in a CI smoke check.
        env.update(W2A_MCP_SESSION_POOL_ENABLED="true", W2A_PARALLEL_TABS="true", W2A_TAB_MODE="owned")
    # Never override installation discovery with this checkout's src path.
    server = StdioServerParameters(
        command=sys.executable, args=["-m", "chatgpt_web2api.mcp_server"], env=env,
    )
    report.update(scope="fresh_stdio_process", mode="configured" if read else "offline_pool", checks=[])
    report["expected"] = expected
    report["current_check"] = "stdio_initialize"
    async with asyncio.timeout(90 if read else 20):
        async with stdio_client(server) as streams:
            async with ClientSession(*streams) as session:
                initialized = await session.initialize()
                report["current_check"] = "tool_discovery"
                listing = await session.list_tools()
                names = {tool.name for tool in listing.tools}
                assert {"runtime_info", "chat_completion", "get_conversation", "wait_reply"} <= names
                report["current_check"] = "runtime_identity"
                result = await session.call_tool("runtime_info", {})
                assert not result.isError
                info = result.structuredContent
                report["runtime"] = info
                report["current_check"] = "handshake_identity"
                handshake = (initialized.capabilities.experimental or {}).get("chatgpt-web2api/runtime")
                assert handshake == info, "initialize and runtime_info identities disagree"
                assert initialized.serverInfo.version == info["package_version"]
                report["handshake"] = {
                    "server_version": initialized.serverInfo.version,
                    "runtime": handshake,
                }
                report["current_check"] = "runtime_identity"
                assert info["contract_version"] == expected["contract_version"]
                assert info["restart_required"] is False
                assert info["startup_source_fingerprint"] == expected["source_fingerprint"]
                report["checks"].extend(["stdio_initialize", "tool_discovery", "handshake_identity", "runtime_identity"])
                if read:
                    report["current_check"] = "public_read"
                    started = time.monotonic()
                    result = await session.call_tool("list_projects", {})
                    if result.isError:
                        # Keep actionable classification without account data,
                        # raw response bodies or arbitrary server error text.
                        payload = result.structuredContent or {}
                        report["tool_error"] = {
                            key: payload[key] for key in
                            ("error", "phase", "kind", "http_status", "retry_after", "timeout_seconds")
                            if key in payload
                        }
                    assert not result.isError, "public list_projects failed"
                    report["checks"].append("public_read")
                    report["public_read_elapsed_s"] = round(time.monotonic() - started, 3)
                report["current_check"] = "runtime_unchanged"
                after = await session.call_tool("runtime_info", {})
                assert after.structuredContent == info, "runtime changed during acceptance"
                report["ok"] = True
                report.pop("current_check", None)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--read", action="store_true", help="also perform one public read using the configured browser")
    parser.add_argument("--expected-contract", help="require this contract in addition to the checkout source fingerprint")
    args = parser.parse_args()
    report = {}
    try:
        expected = expected_identity()
        if args.expected_contract:
            expected["contract_version"] = args.expected_contract
        asyncio.run(verify(args.read, report, expected))
    except Exception as exc:
        report.update(ok=False, error=type(exc).__name__, failed_check=report.get("current_check"))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
