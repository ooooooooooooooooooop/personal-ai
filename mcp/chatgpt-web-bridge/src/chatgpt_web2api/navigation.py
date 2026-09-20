"""Bounded new-chat navigation with redacted evidence and one safe recovery."""

from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from urllib.parse import urlsplit


class NavigationError(RuntimeError):
    def __init__(self, reason, stage, evidence):
        self.reason = reason
        self.stage = stage
        self.evidence = evidence
        super().__init__(f"New-chat navigation failed: {reason}; {stage}. No message was submitted; do not restart healthy services.")


def target_matches(url: str, project_id: str | None) -> bool:
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != "chatgpt.com":
        return False
    if not project_id:
        return parts.path.rstrip("/") == ""
    path = parts.path.strip("/").split("/")
    return len(path) == 3 and path[0] == "g" and path[2] == "project" and (
        path[1] == project_id or path[1].startswith(project_id + "-")
    )


class NavigationEvidence:
    """Listen only during navigation. Never retain headers, queries or bodies."""
    def __init__(self, driver):
        self.driver = driver
        self.events = deque(maxlen=24)
        self.previous = {}
        self.handlers = {}

    def capture(self, message):
        params = message.get("params") or {}
        response = params.get("response") or {}
        parts = urlsplit(response.get("url", ""))
        if parts.hostname != "chatgpt.com":
            return
        path = parts.path
        # Only document and bootstrap requests that can block the composer;
        # unrelated sidebar/background failures do not classify the page.
        critical = params.get("type") == "Document" or path in {
            "/api/auth/session", "/backend-api/me", "/backend-api/settings/user",
            "/backend-api/settings/is_adult",
        } or path.startswith("/backend-api/accounts/check")
        if not critical:
            return
        headers = {k.lower(): str(v) for k, v in (response.get("headers") or {}).items()}
        self.events.append({
            "path": path[:200], "status": response.get("status"),
            "challenge": headers.get("cf-mitigated") == "challenge",
        })

    def __enter__(self):
        table = self.driver._cdp_event_handlers
        name = "Network.responseReceived"
        previous = table.get(name)
        self.previous[name] = previous

        def handler(message):
            self.capture(message)
            if previous is not None:
                previous(message)

        self.handlers[name] = handler
        table[name] = handler
        return self

    def __exit__(self, *_):
        for name, handler in self.handlers.items():
            if self.driver._cdp_event_handlers.get(name) is handler:
                previous = self.previous[name]
                if previous is None:
                    self.driver._cdp_event_handlers.pop(name, None)
                else:
                    self.driver._cdp_event_handlers[name] = previous

    def reason(self):
        if any(event["challenge"] for event in self.events):
            return "challenge_required"
        if any(event["status"] == 401 for event in self.events):
            return "authentication_required"
        if any(event["status"] == 403 for event in self.events):
            return "access_denied"
        if any(event["status"] == 429 for event in self.events):
            return "rate_limited"
        return None


async def navigate_new_chat(driver, project_id=None):
    from .cdp_driver import COMPOSER_FALLBACK_SELECTOR, COMPOSER_SELECTOR, NavigationReadinessProbe

    if driver._conv_target:
        await driver.ensure_scratch_tab()
    if driver._conv_target:
        raise NavigationError("target_busy", "conversation-bound tab", [])
    script = """(() => {
      const el = document.querySelector(%s) || document.querySelector(%s);
      const text = (document.body?.innerText || '').trim();
      return JSON.stringify({url:location.href, ready_state:document.readyState,
        app_shell:!!document.querySelector('nav,[class*=sidebar]') || !!el,
        composer:!!el && !el.disabled && el.getBoundingClientRect().height > 0,
        draft_length:el ? (el.innerText || el.value || '').length : 0,
        retry_page:/^(重试|Retry|Try again)$/i.test(text),
        generating:!!document.querySelector('button[data-testid="stop-button"],button[aria-label="Stop streaming"]')});
    })()""" % (json.dumps(COMPOSER_SELECTOR), json.dumps(COMPOSER_FALLBACK_SELECTOR))

    async def probe():
        data = json.loads(await driver._js_strict(script))
        if not isinstance(data, dict):
            raise ValueError("invalid navigation probe")
        return data

    try:
        initial = await probe()
    except Exception as exc:
        raise NavigationError("probe_failed", type(exc).__name__, []) from exc
    if initial.get("draft_length") or initial.get("generating") or await driver._dom.is_generating():
        raise NavigationError("target_busy", "draft or active generation; page preserved", [])
    url = f"https://chatgpt.com/g/{project_id}/project" if project_id else "https://chatgpt.com/?model=auto"
    with NavigationEvidence(driver) as evidence:
        await driver._cdp("Network.enable", {"maxPostDataSize": 4 * 1024 * 1024})
        last_state = None
        for attempt in range(2):
            last_state = None
            try:
                response = await driver._cdp("Page.navigate", {"url": url})
                driver._current_conv_id = None
                if response.get("errorText"):
                    raise NavigationError("navigation_rejected", "Page.navigate error", list(evidence.events))
            except NavigationError:
                raise
            except Exception as exc:
                raise NavigationError("navigation_transport_failed", type(exc).__name__, list(evidence.events)) from exc
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                try:
                    data = await probe()
                except Exception:
                    await asyncio.sleep(.5)
                    continue
                last_state = data
                state = NavigationReadinessProbe(
                    data.get("url", ""), data.get("ready_state", ""),
                    bool(data.get("app_shell")), bool(data.get("composer")),
                )
                correct = target_matches(state.url, project_id)
                if state.is_ready(correct):
                    return
                reason = evidence.reason()
                if reason:
                    raise NavigationError(reason, state.diagnostic_summary(correct), list(evidence.events))
                if data.get("retry_page") and state.document_ready:
                    break
                await asyncio.sleep(.5)
            # Recovery is allowed only for the observed retry page before any
            # submission, on the expected URL, without a draft or generation.
            safe_retry = attempt == 0 and last_state and last_state.get("retry_page") and (
                target_matches(last_state.get("url", ""), project_id)
                and not last_state.get("draft_length") and not last_state.get("generating")
                and not await driver._dom.is_generating()
            )
            if not safe_retry:
                break
            await asyncio.sleep(1)
        state = last_state or {}
        stage = NavigationReadinessProbe(
            state.get("url", ""), state.get("ready_state", ""),
            bool(state.get("app_shell")), bool(state.get("composer")),
        ).diagnostic_summary(target_matches(state.get("url", ""), project_id))
        raise NavigationError("page_load_failed", stage, list(evidence.events))
