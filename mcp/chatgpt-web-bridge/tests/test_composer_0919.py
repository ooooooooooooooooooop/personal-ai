"""Behavioral regressions for the 2026-09-19 composer boundary.

These tests use a small in-process browser/CDP model.  The fake evaluates the
same operation classes emitted by :class:`ChatGPTDom` and keeps a mutable
composer, selection, paste count, and submit boundary.  This deliberately
tests state transitions (replacement, cleanup, and submit dispatch) rather
than only asserting that an expression contains a selector.
"""

from __future__ import annotations

import asyncio
import json
import re

import pytest

from chatgpt_web2api.cdp_driver import DeliveryStage, SendReadinessError
from chatgpt_web2api.cdp_transport import CDPTimeoutError
from chatgpt_web2api.chatgpt_dom import (
    ChatGPTDom,
)


class FakeComposerBrowser:
    """A stateful, local browser fixture for composer operations."""

    def __init__(self, *, initial_text: str = "") -> None:
        self._breakers = None
        self.composer_text = initial_text
        self.focused = False
        self.selected = False
        self.paste_count = 0
        self.delete_count = 0
        self.submit_dispatch_count = 0
        self.diagnostics: list[str] = []
        self.paste_accepts = True
        self.clear_accepts = True
        self.corrupt_insert = False
        self.timeout_after_paste = False
        self.permission_denied = False
        self.permission_js_guard_seen = False
        self.focus_result = "composer"
        self.cleanup_error: BaseException | None = None
        self.ready_sequence: list[str] = ["yes"]
        self.click_result = "sent"
        self.delivery_stage = DeliveryStage.NOT_STARTED.value
        self.dom = ChatGPTDom(self)

    async def _js(self, expr: str, timeout: float = 15):
        if "dispatchEvent" in expr:
            self.submit_dispatch_count += 1
            # The fake models the JS script's return value.  A real browser
            # would dispatch only when the script reaches the event loop;
            # timeout/unknown outcomes are exercised by the driver tests.
            return self.click_result
        if "return btn" in expr:
            if self.ready_sequence:
                return self.ready_sequence.pop(0)
            return "no"
        self.focused = True
        return self.focus_result

    @staticmethod
    def _payload_from_paste(expr: str) -> str:
        match = re.search(r"setData\('text/plain',\s*(.*?)\);", expr)
        assert match, "paste evaluate did not carry a text/plain payload"
        return json.loads(match.group(1))

    async def _js_strict(self, expr: str, timeout: float = 15):
        if self.permission_denied:
            if "ClipboardEvent" in expr:
                self.permission_js_guard_seen = all(
                    name in expr
                    for name in ("SecurityError", "NotAllowedError", "PermissionDeniedError")
                )
            raise PermissionError("browser permission denied")
        if "ClipboardEvent" in expr:
            self.paste_count += 1
            if self.paste_accepts:
                payload = self._payload_from_paste(expr)
                # The JS range.selectNodeContents(el) is the important part:
                # a retry replaces a possible partial draft instead of
                # appending to it.
                self.selected = True
                self.composer_text = payload + (" [corrupt]" if self.corrupt_insert else "")
                if self.timeout_after_paste:
                    self.timeout_after_paste = False
                    raise CDPTimeoutError("Runtime.evaluate", 1, phase="response")
                return True
            return False
        if "execCommand('delete')" in expr:
            self.delete_count += 1
            if self.cleanup_error is not None:
                raise self.cleanup_error
            if not self.clear_accepts:
                return False
            self.composer_text = ""
            self.selected = False
            return True
        # The canonical verifier JS reads the fake browser's current editor
        # value.  No string-matching assertion is used to establish success.
        return self.composer_text

    async def _cdp(self, method: str, params=None, timeout: float = 15):
        if method == "Input.dispatchKeyEvent" and params and params.get("key") == "a":
            self.selected = True
        return {}

    async def _detect_select_all_modifier(self) -> int:
        return 2

    async def _verify_composer_text(self, selector: str, expected: str) -> bool:
        return await self.dom._verify_composer_text(selector, expected)

    async def _capture_selector_diagnostic(self, name: str) -> None:
        self.diagnostics.append(name)

    def _set_delivery_stage(self, stage, **_kwargs) -> None:
        self.delivery_stage = stage.value if isinstance(stage, DeliveryStage) else stage


@pytest.fixture
def no_dom_sleep(monkeypatch):
    monkeypatch.setattr("chatgpt_web2api.chatgpt_dom.asyncio.sleep", _instant_sleep)


async def _instant_sleep(_seconds: float) -> None:
    return None


@pytest.mark.asyncio
async def test_long_unicode_multiline_replaces_old_draft_once(no_dom_sleep):
    payload = ("第 1 行 é🙂\n" + "缩进  两个空格\n") * 150 + "末行\n"
    browser = FakeComposerBrowser(initial_text="old draft that must be replaced")

    await browser.dom.type_message(payload)

    assert browser.composer_text == payload
    assert browser.paste_count == 1
    assert browser.delete_count == 0
    assert browser.selected is True


@pytest.mark.asyncio
async def test_timeout_after_paste_side_effect_is_replaced_on_retry(no_dom_sleep):
    payload = "line\n" * 300 + "终"
    browser = FakeComposerBrowser(initial_text="partial previous draft")
    browser.timeout_after_paste = True

    # A Runtime.evaluate response timeout is ambiguous: the first paste has
    # already changed the local browser state, but the caller cannot safely
    # infer success from the missing response.  A bounded reconnect retry may
    # re-run type_message; the range selection must make that idempotent.
    with pytest.raises(CDPTimeoutError):
        await browser.dom.type_message(payload)
    assert browser.composer_text == payload

    await browser.dom.type_message(payload)
    assert browser.composer_text == payload
    assert browser.paste_count == 2
    assert "终终" not in browser.composer_text


@pytest.mark.asyncio
async def test_rejected_paste_does_not_accept_stale_identical_draft(no_dom_sleep):
    payload = "already present\nexactly"
    browser = FakeComposerBrowser(initial_text=payload)
    browser.paste_accepts = False

    with pytest.raises(SendReadinessError, match="insertion dispatch did not complete"):
        await browser.dom.type_message(payload)

    # No verification can turn a rejected mutation into a success, and no
    # retry/cleanup is allowed to erase a draft the bridge did not establish.
    assert browser.composer_text == payload
    assert browser.paste_count == 1
    assert browser.delete_count == 0


@pytest.mark.asyncio
async def test_cleanup_failure_blocks_second_insert(no_dom_sleep):
    payload = "expected text"
    browser = FakeComposerBrowser()
    browser.corrupt_insert = True
    browser.clear_accepts = False

    with pytest.raises(SendReadinessError, match="cleanup could not be verified"):
        await browser.dom.type_message(payload)

    assert browser.paste_count == 1
    assert browser.delete_count == 1
    assert browser.composer_text.endswith("[corrupt]")


@pytest.mark.asyncio
async def test_permission_denial_stops_before_verify_or_retry(no_dom_sleep):
    browser = FakeComposerBrowser(initial_text="user draft")
    browser.permission_denied = True

    with pytest.raises(PermissionError):
        await browser.dom.type_message("new prompt")

    assert browser.paste_count == 0
    assert browser.delete_count == 0
    assert browser.composer_text == "user draft"
    assert browser.permission_js_guard_seen is True


@pytest.mark.asyncio
async def test_unknown_focus_result_fails_closed_without_legacy_insert(no_dom_sleep):
    browser = FakeComposerBrowser(initial_text="user draft")
    browser.focus_result = None

    with pytest.raises(SendReadinessError, match="unknown result"):
        await browser.dom.type_message("new prompt")

    assert browser.paste_count == 0
    assert browser.composer_text == "user draft"


@pytest.mark.asyncio
async def test_readiness_timeout_never_dispatches_submit(monkeypatch):
    browser = FakeComposerBrowser()
    browser.ready_sequence = ["no"]
    monkeypatch.setattr(
        "chatgpt_web2api.chatgpt_dom.SEND_BUTTON_POLL_MAX_WAIT_S", 0.01
    )
    monkeypatch.setattr(
        "chatgpt_web2api.chatgpt_dom.SEND_BUTTON_POLL_INTERVAL_S", 0.001
    )
    monkeypatch.setattr("chatgpt_web2api.chatgpt_dom.asyncio.sleep", _instant_sleep)

    with pytest.raises(SendReadinessError, match="readiness budget"):
        await browser.dom.click_send()

    assert browser.submit_dispatch_count == 0
    assert browser.delivery_stage == DeliveryStage.NOT_STARTED.value


@pytest.mark.asyncio
async def test_known_pre_submit_race_does_not_poison_delivery_stage(no_dom_sleep):
    browser = FakeComposerBrowser()
    browser.ready_sequence = ["yes"]
    browser.click_result = "no send button"

    with pytest.raises(SendReadinessError, match="no send button"):
        await browser.dom.click_send()

    assert browser.delivery_stage == DeliveryStage.NOT_STARTED.value
    assert browser.submit_dispatch_count == 1


@pytest.mark.asyncio
async def test_cleanup_cancellation_is_not_downgraded_to_false():
    browser = FakeComposerBrowser(initial_text="bridge draft")
    browser.cleanup_error = asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await browser.dom._clear_composer("div[role=\"textbox\"]")


@pytest.mark.asyncio
async def test_cleanup_exception_is_best_effort_false():
    browser = FakeComposerBrowser(initial_text="bridge draft")
    browser.cleanup_error = RuntimeError("renderer went away")

    assert await browser.dom._clear_composer("div[role=\"textbox\"]") is False
