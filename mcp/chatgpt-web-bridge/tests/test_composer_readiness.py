"""Observe each send; recovery cannot erase a draft or replay a submission."""
import asyncio
import json
import time
from unittest.mock import AsyncMock

import pytest

from chatgpt_web2api.cdp_driver import CDPDriver
from chatgpt_web2api.cdp_transport import CDPTimeoutError
from chatgpt_web2api.composer_surface import (
    ComposerReadinessError,
    recover_composer,
    validate_page,
    wait_composer_ready,
)
from chatgpt_web2api.send_recovery import (
    RecoveryBudget,
    recover_before_submission,
    run_with_send_recovery,
)

URL = 'https://chatgpt.com/g/project/c/conv-1'


def state(reason='ready', **extra):
    return dict(ready=reason == 'ready', reason=reason, url=URL,
                draft_present=False, attachments_present=False, **extra)


def driver(*states):
    d = CDPDriver(cdp_port=9222)
    d._target_id = 'target-1'
    d._current_conv_id = 'conv-1'
    d._conv_target = True
    d._dom.is_generating = AsyncMock(return_value=False)
    d._js_strict = AsyncMock(side_effect=[json.dumps(s) for s in states])
    d._cdp = AsyncMock()
    d._reset_delivery_metadata()
    return d


@pytest.mark.asyncio
async def test_delayed_composer_waits_without_reloading():
    d = driver(state('loading'), state())
    assert (await wait_composer_ready(d, timeout=1))['ready']
    d._cdp.assert_not_awaited()


@pytest.mark.asyncio
async def test_deadline_includes_unresponsive_probe():
    d = driver()
    async def slow(*a, **k):
        await asyncio.sleep(5)
    d._js_strict.side_effect = slow
    start = time.monotonic()
    with pytest.raises(ComposerReadinessError) as caught:
        await wait_composer_ready(d, timeout=0.03)
    assert time.monotonic() - start < 0.5
    assert caught.value.recovery_eligible is False
    d._cdp.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('reason', ['challenge', 'login_required', 'blocking_dialog',
                                  'ambiguous_composer', 'unsupported_composer', 'generating'])
async def test_terminal_barriers_do_not_retry_or_mutate(reason):
    d = driver(state(reason))
    async def operation():
        return await wait_composer_ready(d, timeout=0.03)
    with pytest.raises(ComposerReadinessError) as caught:
        await run_with_send_recovery(d, operation)
    assert caught.value.readiness['reason'] == reason
    assert caught.value.recovery_attempts == 0
    d._cdp.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_composer_recovers_one_same_page_reload():
    missing = state('composer_missing')
    d = driver(missing, state())
    fault = ComposerReadinessError(missing, target_id=d._target_id)
    budget = RecoveryBudget(d)
    assert await recover_before_submission(d, fault, budget)
    d._cdp.assert_awaited_once_with('Page.reload', {})
    assert d._target_id == 'target-1' and d._current_conv_id == 'conv-1'
    assert not await recover_before_submission(d, fault, budget)
    assert fault.recovery_attempts == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('field', ['draft_present', 'attachments_present'])
async def test_fresh_draft_or_attachment_prevents_reload(field):
    missing = state('composer_missing')
    fresh = dict(missing, **{field: True})
    d = driver(fresh)
    with pytest.raises(ComposerReadinessError):
        await recover_composer(d, ComposerReadinessError(missing, target_id=d._target_id))
    d._cdp.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('stage', ['submission_attempted', 'acknowledged', 'unknown'])
async def test_possible_submission_never_reloads(stage):
    d = driver()
    d._delivery_stage = stage
    fault = ComposerReadinessError(state('composer_missing'), target_id=d._target_id)
    assert not await recover_before_submission(d, fault, RecoveryBudget(d))
    d._js_strict.assert_not_awaited()
    d._cdp.assert_not_awaited()


@pytest.mark.asyncio
async def test_transport_and_composer_share_one_recovery():
    d = driver()
    d.reconnect_for_send_recovery = AsyncMock()
    budget = RecoveryBudget(d)
    assert await recover_before_submission(d, CDPTimeoutError('Runtime.evaluate'), budget)
    fault = ComposerReadinessError(state('composer_missing'), target_id=d._target_id)
    assert not await recover_before_submission(d, fault, budget)
    assert fault.recovery_attempts == 1
    d._cdp.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', [PermissionError('denied'), asyncio.CancelledError()])
async def test_denial_and_cancel_stop_recovery(failure):
    d = driver()
    d._js_strict.side_effect = failure
    with pytest.raises(type(failure)):
        await recover_composer(d, ComposerReadinessError(state('composer_missing'), target_id=d._target_id))
    d._cdp.assert_not_awaited()


@pytest.mark.asyncio
async def test_reused_conversation_is_checked_without_navigation():
    d = driver(state('blocking_dialog'))
    with pytest.raises(ComposerReadinessError):
        await d.navigate_conversation('conv-1')
    d._cdp.assert_not_awaited()


@pytest.mark.asyncio
async def test_readiness_failure_precedes_baseline_and_typing():
    d = driver(state('blocking_dialog'))
    d._read_assistant_count_baseline = AsyncMock()
    d.type_message = AsyncMock()
    with pytest.raises(ComposerReadinessError):
        _ = [chunk async for chunk in d.send_and_stream('hello')]
    d.type_message.assert_not_awaited()
    d._read_assistant_count_baseline.assert_not_awaited()


@pytest.mark.parametrize('url,reason', [
    ('https://chatgpt.com.evil.test/c/conv-1', 'unexpected_origin'),
    ('https://chatgpt.com/c/conv-2', 'conversation_mismatch'),
    ('https://chatgpt.com/auth/login', 'conversation_mismatch'),
])
def test_binding_is_verified_independently_of_composer(url, reason):
    result = validate_page(dict(state(), url=url), 'conv-1')
    assert result['ready'] is False and result['reason'] == reason


@pytest.mark.asyncio
async def test_target_drift_stops_before_reload():
    d = driver()
    error = ComposerReadinessError(state('composer_missing'), target_id='old-target')
    with pytest.raises(ComposerReadinessError, match='target_changed'):
        await recover_composer(d, error)
    d._js_strict.assert_not_awaited()
    d._cdp.assert_not_awaited()


@pytest.mark.asyncio
async def test_target_changes_during_fresh_probe_never_reloads():
    missing = state('composer_missing')
    d = driver()
    async def changed(*a, **k):
        d._target_id = 'other-target'
        return json.dumps(missing)
    d._js_strict.side_effect = changed
    with pytest.raises(ComposerReadinessError, match='target_changed'):
        await recover_composer(d, ComposerReadinessError(missing, target_id='target-1'))
    d._cdp.assert_not_awaited()


@pytest.mark.asyncio
async def test_empty_hydration_placeholder_can_become_ready_without_reload():
    d = driver(state('unsupported_composer'), state())
    assert (await wait_composer_ready(d, timeout=1))['ready']
    d._cdp.assert_not_awaited()


@pytest.mark.asyncio
async def test_reload_permission_response_stops_without_further_probe():
    missing = state('composer_missing')
    d = driver(missing)
    d._cdp.return_value = {'error': {'message': 'Permission denied'}}
    fault = ComposerReadinessError(missing, target_id=d._target_id)
    with pytest.raises(PermissionError) as caught:
        await recover_before_submission(d, fault, RecoveryBudget(d))
    assert caught.value.recovery_attempts == 1
    assert caught.value.readiness['reason'] == 'permission_denied'
    d._js_strict.assert_awaited_once()


@pytest.mark.asyncio
async def test_reload_cannot_change_the_bound_page():
    missing = state('composer_missing')
    d = driver(missing, dict(state(), url='https://chatgpt.com/c/conv-2'))
    with pytest.raises(ComposerReadinessError, match='conversation_mismatch'):
        await recover_composer(d, ComposerReadinessError(missing, target_id=d._target_id))
    assert d._current_conv_id == 'conv-1'
    d._cdp.assert_awaited_once_with('Page.reload', {})


def test_mcp_error_distinguishes_not_submitted_from_retry_advice():
    from chatgpt_web2api.mcp_server import _map_tool_exception
    d = driver()
    error = ComposerReadinessError(state('composer_missing'), target_id=d._target_id)
    d._annotate_delivery_error(error)
    error.recovery_attempts = 1
    result = _map_tool_exception(error)
    assert result.isError
    payload = result.structuredContent
    assert payload['delivery_stage'] == 'not_started'
    assert payload['retry_safe'] is True and payload['retry_recommended'] is False
    assert payload['recovery_attempts'] == 1
    assert payload['readiness']['reason'] == 'composer_missing'
