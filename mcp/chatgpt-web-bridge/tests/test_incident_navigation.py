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
