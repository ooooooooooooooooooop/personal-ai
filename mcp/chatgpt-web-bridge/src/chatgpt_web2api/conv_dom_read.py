"""DOM-first conversation reads via a throwaway CDP session.

Why this exists: ``GET /backend-api/conversation/{id}`` is a
navigation-grade endpoint — the real web app calls it once per open, not
on a poll loop. wait_reply hammering it (140+/hr across sessions) is what
kept tripping account-level 429 cooldowns (matching public reports:
openai/codex#37518, #38763). The conversation's own tab already renders
everything wait_reply needs — role, tail text, streaming state — and
reading it costs zero API requests.

Design: rather than routing the call through the conversation's owning
driver (which would pin the pool slot for the whole wait), we open a
short-lived websocket straight to the conv's page target — CDP allows
multiple sessions per target, and Runtime.evaluate is read-only here.
The owning driver/process never knows we looked.

Caveat: long conversations virtualize — ``rendered_total`` counts
RENDERED message nodes, a lower bound on the backend total, and
``read_messages`` returns only the rendered tail. Callers that need
absolute totals still fall back to the backend fetch.
"""
from __future__ import annotations

import asyncio
import json
import logging
import urllib.request

logger = logging.getLogger(__name__)

_TAIL_EXPR = (
    "(function(){"
    "  var msgs = document.querySelectorAll('[data-message-author-role]');"
    "  if (!msgs.length) return null;"
    "  var last = msgs[msgs.length-1];"
    "  var md = last.querySelector('.markdown');"
    "  var stopBtn = document.querySelector('[data-testid=\"stop-button\"], button[aria-label*=\"Stop\" i], button[aria-label*=\"停止\"]');"
    "  var gen = document.querySelector('[class*=\"result-thinking\"], [class*=\"generating\"]');"
    "  return JSON.stringify({"
    "    rendered_total: msgs.length,"
    "    last_role: last.getAttribute('data-message-author-role'),"
    "    generating: !!(stopBtn || gen),"
    "    tail_text: (md ? md.textContent : last.textContent || '').slice(-2000)"
    "  });"
    "})()"
)

_MSGS_EXPR = (
    "(function(){"
    "  var msgs = document.querySelectorAll('[data-message-author-role]');"
    "  var out = [];"
    "  var start = Math.max(0, msgs.length - __LIM__);"
    "  for (var i = start; i < msgs.length; i++) {"
    "    var m = msgs[i];"
    "    var md = m.querySelector('.markdown');"
    "    out.push({"
    "      role: m.getAttribute('data-message-author-role'),"
    "      content: (md ? md.textContent : m.textContent || '').trim()"
    "    });"
    "  }"
    "  return JSON.stringify(out);"
    "})()"
)


def _conv_ws_url(cdp_port: int, conv_id: str) -> str | None:
    """webSocketDebuggerUrl of the page target showing ``conv_id``."""
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{cdp_port}/json/list"
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            targets = json.loads(resp.read())
    except Exception:
        return None
    needle = f"/c/{conv_id}"
    for t in targets:
        if t.get("type") == "page" and needle in t.get("url", ""):
            return t.get("webSocketDebuggerUrl")
    return None


async def _eval_on_conv_tab(
    cdp_port: int, conv_id: str, expr: str, timeout: float = 10
) -> str | None:
    """Evaluate ``expr`` on the conv's page target via a fresh WS session."""
    import websockets

    ws_url = _conv_ws_url(cdp_port, conv_id)
    if not ws_url:
        return None
    try:
        async with websockets.connect(
            ws_url, open_timeout=5, max_size=10 * 1024 * 1024
        ) as ws:
            await ws.send(json.dumps({
                "id": 1,
                "method": "Runtime.evaluate",
                "params": {"expression": expr, "returnByValue": True},
            }))
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
                if msg.get("id") == 1:
                    return (
                        msg.get("result", {})
                        .get("result", {})
                        .get("value")
                    )
    except Exception:
        logger.debug("conv_dom_read: eval failed for %s", conv_id, exc_info=True)
        return None
    return None


async def conv_tail_state(cdp_port: int, conv_id: str) -> dict | None:
    """Rendered tail state of ``conv_id``'s tab, or None if unavailable.

    Keys: rendered_total, last_role, generating, tail_text.
    """
    raw = await _eval_on_conv_tab(cdp_port, conv_id, _TAIL_EXPR)
    if not raw:
        return None
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return None
    return data if isinstance(data, dict) else None


async def conv_messages(
    cdp_port: int, conv_id: str, limit: int = 50
) -> list | None:
    """Rendered messages (role + content), oldest-first, or None."""
    expr = _MSGS_EXPR.replace("__LIM__", str(int(limit)))
    raw = await _eval_on_conv_tab(cdp_port, conv_id, expr)
    if not raw:
        return None
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return None
    return data if isinstance(data, list) else None
