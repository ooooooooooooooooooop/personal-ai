"""Target identity and permission failures must survive orchestration layers."""
import io
import json
from unittest.mock import AsyncMock

import pytest

from chatgpt_web2api.cdp_driver import CDPDriver


CONV = "11111111-2222-4333-8444-555555555555"


@pytest.mark.parametrize("url", [
    f"https://example.test/c/{CONV}",
    f"https://chatgpt.com.evil.test/c/{CONV}",
    f"https://chatgpt.com/c/{CONV}-other",
    f"https://chatgpt.com/?next=/c/{CONV}",
])
async def test_adoption_never_matches_foreign_origin_or_partial_id(monkeypatch, url):
    driver = CDPDriver()
    monkeypatch.setattr(driver, "_list_page_targets", lambda: [
        {"id": "unrelated", "url": url, "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/unrelated"}
    ])
    driver.connect = AsyncMock()
    assert driver._adopt_conversation_tab(CONV) is None
    assert await driver.adopt_conversation_tab(CONV) is False
    assert driver._target_id is None
    driver.connect.assert_not_awaited()


async def test_connect_permission_denial_does_not_fallback(monkeypatch):
    driver = CDPDriver(tab_mode="adopt")
    monkeypatch.setattr(driver, "_adopt_existing_chatgpt_tab", lambda: None)
    monkeypatch.setattr(driver, "_adopt_bare_home_tab", lambda: None)
    driver._create_owned_tab = AsyncMock(side_effect=PermissionError("denied"))
    driver._find_page_ws = AsyncMock()
    with pytest.raises(PermissionError):
        await driver.connect()
    driver._find_page_ws.assert_not_awaited()


async def test_reconnect_permission_denial_is_not_retried(monkeypatch):
    driver = CDPDriver()
    driver._create_owned_tab = AsyncMock(side_effect=PermissionError("denied"))
    with pytest.raises(PermissionError):
        await driver.reconnect()
    driver._create_owned_tab.assert_awaited_once()


async def test_browser_domain_permission_error_is_typed(monkeypatch):
    driver = CDPDriver()
    monkeypatch.setattr("chatgpt_web2api.cdp_driver.urllib.request.urlopen", lambda *a, **k:
                        io.BytesIO(json.dumps({"webSocketDebuggerUrl": "ws://localhost/browser"}).encode()))

    class Socket:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def send(self, raw):
            self.mid = json.loads(raw)["id"]

        async def recv(self):
            return json.dumps({"id": self.mid, "error": {"message": "Not allowed by permissions policy"}})

    monkeypatch.setattr("chatgpt_web2api.cdp_driver.websockets.connect", lambda *a, **k: Socket())
    with pytest.raises(PermissionError):
        await driver._browser_cdp("Target.createTarget")
