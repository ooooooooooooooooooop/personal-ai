import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from chatgpt_web2api import navigation

HOME = "https://chatgpt.com/?model=auto"
PROJECT = "g-p-example"
TARGET = f"https://chatgpt.com/g/{PROJECT}/project"


def state(url=TARGET, **kwargs):
    return json.dumps(dict(url=url, ready_state="complete", app_shell=True,
                          composer=True, draft_length=0, generating=False, retry_page=False) | kwargs)


@pytest.fixture
def driver(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(navigation.time, "monotonic", lambda: clock[0])

    async def sleep(delay):
        clock[0] += delay
    monkeypatch.setattr(navigation.asyncio, "sleep", sleep)
    return SimpleNamespace(
        _conv_target=False, _current_conv_id=None, _cdp_event_handlers={},
        _cdp=AsyncMock(return_value={}), _js_strict=AsyncMock(return_value=state()),
        _dom=SimpleNamespace(is_generating=AsyncMock(return_value=False)),
    )


async def test_retry_page_recovers_once_before_send(driver):
    driver._js_strict.side_effect = [state(HOME), state(composer=False, retry_page=True), state()]
    await navigation.navigate_new_chat(driver, PROJECT)
    assert sum(call.args[0] == "Page.navigate" for call in driver._cdp.await_args_list) == 2
    assert driver._cdp_event_handlers == {}


async def test_persistent_retry_page_is_bounded(driver):
    driver._js_strict.return_value = state(composer=False, retry_page=True)
    with pytest.raises(navigation.NavigationError, match="page_load_failed"):
        await navigation.navigate_new_chat(driver, PROJECT)
    assert sum(call.args[0] == "Page.navigate" for call in driver._cdp.await_args_list) == 2


@pytest.mark.parametrize("flag", ["draft_length", "generating"])
async def test_preserves_draft_or_generation_without_navigating(driver, flag):
    driver._js_strict.return_value = state(**{flag: 1})
    with pytest.raises(navigation.NavigationError, match="target_busy"):
        await navigation.navigate_new_chat(driver, PROJECT)
    driver._cdp.assert_not_awaited()


async def test_target_busy_error_names_its_override(driver):
    """裁决5: a fail-closed guard must carry its own "I was wrong" exit — the
    error text must name force_new_chat so a blocked operator can self-rescue."""
    driver._js_strict.return_value = state(draft_length=3)
    with pytest.raises(navigation.NavigationError, match="force_new_chat"):
        await navigation.navigate_new_chat(driver, PROJECT)
    driver._cdp.assert_not_awaited()


async def test_force_skips_only_the_busy_precheck(driver):
    """force bypasses the draft/generation pre-check; navigation and readiness
    polling still run (Page.navigate is reached, target URL still verified)."""
    driver._js_strict.return_value = state(draft_length=3)
    await navigation.navigate_new_chat(driver, PROJECT, force=True)
    assert sum(call.args[0] == "Page.navigate" for call in driver._cdp.await_args_list) == 1


async def test_force_does_not_skip_readiness(driver):
    """force is not a blank cheque: a wrong-URL landing still fails closed."""
    driver._js_strict.return_value = state("https://chatgpt.com/g/g-p-other/project", draft_length=3)
    with pytest.raises(navigation.NavigationError, match="url displaced"):
        await navigation.navigate_new_chat(driver, PROJECT, force=True)


@pytest.mark.parametrize("challenge,reason", [(True, "challenge_required"), (False, "access_denied")])
async def test_challenge_is_distinguished_from_plain_403(driver, challenge, reason):
    async def cdp(method, params):
        if method == "Page.navigate":
            driver._cdp_event_handlers["Network.responseReceived"]({"params": {
                "type": "Fetch", "response": {
                    "url": "https://chatgpt.com/backend-api/me?secret=never-store",
                    "status": 403, "headers": {"Authorization": "secret", **({"cf-mitigated": "challenge"} if challenge else {})},
                },
            }})
        return {}
    driver._cdp.side_effect = cdp
    driver._js_strict.return_value = state(composer=False, retry_page=True)
    with pytest.raises(navigation.NavigationError) as caught:
        await navigation.navigate_new_chat(driver, PROJECT)
    assert caught.value.reason == reason
    assert "secret" not in json.dumps(caught.value.evidence)
    assert sum(call.args[0] == "Page.navigate" for call in driver._cdp.await_args_list) == 1


async def test_wrong_project_never_counts_as_ready(driver):
    driver._js_strict.return_value = state("https://chatgpt.com/g/g-p-other/project")
    with pytest.raises(navigation.NavigationError, match="url displaced"):
        await navigation.navigate_new_chat(driver, PROJECT)


def test_exact_origin_and_project_identity():
    assert navigation.target_matches(TARGET, PROJECT)
    assert navigation.target_matches(TARGET.replace(PROJECT, PROJECT + "-slug"), PROJECT)
    assert not navigation.target_matches(TARGET.replace("chatgpt.com", "chatgpt.com.evil.test"), PROJECT)
    assert not navigation.target_matches(TARGET + "/c/other", PROJECT)


def test_nav_probe_trims_prosemirror_empty_artifact():
    """2026-10-12 live-e2e finding: an empty ProseMirror composer reports
    innerText "\\n" (placeholder paragraph), so the untrimmed length was 1
    and the target_busy guard blocked EVERY new-chat send account-wide.
    Pin the trim in the probe expression."""
    import inspect
    src = inspect.getsource(navigation.navigate_new_chat)
    assert "draft_length:el ? (el.innerText || el.value || '').trim().length" in src


async def test_nav_probe_script_is_valid_js(driver, tmp_path):
    """The probe script is evaluated by the browser: a Python-side escape slip
    (a real newline landing inside a JS string literal) only surfaces live as
    CDPJSError SyntaxError — mock-based offline tests never parse the script.
    Pin validity by capturing the script and parsing it with node."""
    captured = []

    async def capture(script):
        captured.append(script)
        raise ValueError("stop after capture")

    driver._js_strict = AsyncMock(side_effect=capture)
    with pytest.raises(navigation.NavigationError, match="probe_failed"):
        await navigation.navigate_new_chat(driver)
    assert captured, "probe script never reached the driver"
    import shutil
    import subprocess
    node = shutil.which("node")
    if not node:
        pytest.skip("node unavailable for JS syntax check")
    f = tmp_path / "probe.js"
    f.write_text(captured[0], encoding="utf-8")
    r = subprocess.run([node, "--check", str(f)], capture_output=True, text=True)
    assert r.returncode == 0, f"probe script is not valid JS: {r.stderr}"
