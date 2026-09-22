"""One live composer resolver and bounded, read-only send readiness.

The probe returns structure and lengths, never conversation or draft text.
Recovery is separate from discovery: missing DOM is not a transport failure.
"""
from __future__ import annotations

import asyncio
import json
import time
from urllib.parse import urlsplit

COMPOSER_SELECTOR = (
    'div#prompt-textarea, div[data-testid="prompt-textarea"], div.ProseMirror'
)
COMPOSER_FALLBACK_SELECTOR = 'textarea#prompt-textarea, textarea[data-testid="prompt-textarea"]'

# Resolve afresh for every operation. Never retain a node across hydration,
# accept hidden fallback textareas, or target a message-edit/search field.
COMPOSER_RESOLVER_JS = r'''(() => {
  const visible = el => {
    if (!el.isConnected || el.closest('[hidden],[inert],[aria-hidden="true"]')) return false;
    if (el.checkVisibility && !el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' && Number(style.opacity) !== 0 &&
      [...el.getClientRects()].some(r => r.width > 0 && r.height > 0);
  };
  const outsideMessage = el => !el.closest('[data-message-author-role],[data-message-id],article');
  const known = [...document.querySelectorAll(
    'div#prompt-textarea,div[data-testid="prompt-textarea"],div.ProseMirror,' +
    'textarea#prompt-textarea,textarea[data-testid="prompt-textarea"]'
  )].filter(outsideMessage).filter(el =>
    el.id === 'prompt-textarea' || el.dataset.testid === 'prompt-textarea' ||
    !!el.closest('form,[data-type="unified-composer"],#thread-bottom-container')
  );
  const editable = el => !el.disabled && !el.readOnly &&
    el.getAttribute('aria-disabled') !== 'true' &&
    (el.tagName === 'TEXTAREA' || el.isContentEditable);
  const live = known.filter(el => visible(el) && editable(el));
  const element = live.length === 1 ? live[0] : null;
  const extras = [...document.querySelectorAll('main [contenteditable="true"],main textarea')]
    .filter(outsideMessage).filter(visible).filter(el => !known.includes(el));
  const hasVisible = selector => [...document.querySelectorAll(selector)].some(visible);
  const challenge = hasVisible('#challenge-form,#challenge-running,.cf-turnstile') ||
    /^(just a moment|attention required|verify you are human)/i.test(document.title);
  const login = hasVisible('a[href^="/auth/login"],button[data-testid="login-button"]');
  const generating = hasVisible('[data-testid="stop-button"]');
  const dialog = hasVisible('[role="dialog"][aria-modal="true"],dialog[open]');
  let reason = 'composer_missing';
  if (challenge) reason = 'challenge';
  else if (login) reason = 'login_required';
  else if (dialog) reason = 'blocking_dialog';
  else if (generating) reason = 'generating';
  else if (live.length > 1) reason = 'ambiguous_composer';
  else if (element) reason = 'ready';
  else if (known.some(visible)) reason = 'composer_disabled';
  else if (extras.length) reason = 'unsupported_composer';
  else if (document.readyState === 'loading') reason = 'loading';
  const draft = [...known, ...extras].some(el =>
    !!(el.tagName === 'TEXTAREA' ? el.value : el.textContent || '').trim());
  const attachments = hasVisible('[data-testid="attachment"],[data-testid="file-chip"],' +
    '[data-testid*="attachment"],button[aria-label^="Remove file"],button[aria-label^="移除文件"]') ||
    [...document.querySelectorAll('input[type="file"]')].some(el => el.files?.length > 0);
  return {element, state: {
    reason, ready: reason === 'ready', url: location.href,
    ready_state: document.readyState, candidate_count: known.length,
    live_candidate_count: live.length, unrecognized_editor_count: extras.length,
    draft_present: draft, attachments_present: attachments,
    candidates: known.slice(0, 6).map(el => ({
      tag: el.tagName, id: el.id, role: el.getAttribute('role'),
      visible: visible(el), editable: editable(el), in_form: !!el.closest('form')
    }))
  }};
})()'''

COMPOSER_ELEMENT_JS = f'({COMPOSER_RESOLVER_JS}).element'
COMPOSER_PROBE_JS = f'JSON.stringify(({COMPOSER_RESOLVER_JS}).state)'


def send_button_js(selectors: str) -> str:
    return (
        '(() => { const el = ' + COMPOSER_ELEMENT_JS + '; const form = el?.closest("form");'
        ' if (!form) return null; const buttons = [...form.querySelectorAll('
        + json.dumps(selectors) + ')].filter(b => '
        '!b.disabled && b.getAttribute("aria-disabled") !== "true" && '
        '!b.matches("[data-testid=stop-button]") && !b.closest("[hidden],[inert],[aria-hidden=true]") && '
        'getComputedStyle(b).visibility !== "hidden" && '
        '[...b.getClientRects()].some(r => r.width > 0 && r.height > 0));'
        ' return buttons.length === 1 ? buttons[0] : null; })()'
    )


def composer_element_js(selector: str | None = None) -> str:
    """A selector may narrow the unique live editor, never choose another one."""
    if not selector:
        return COMPOSER_ELEMENT_JS
    return (
        '(() => { const el = ' + COMPOSER_ELEMENT_JS + '; return el && el.matches('
        + json.dumps(selector) + ') ? el : null; })()'
    )


class ComposerReadinessError(RuntimeError):
    def __init__(self, state: dict, *, target_id: str | None = None):
        self.readiness = state
        self.target_id = target_id
        self.recovery_eligible = (
            state.get('reason') in {'composer_missing', 'loading'}
            and state.get('draft_present') is False
            and state.get('attachments_present') is False
        )
        self.retry_recommended = False
        super().__init__(f"Composer not ready: {state.get('reason', 'unknown')}")


def validate_page(state: dict, conversation_id: str | None) -> dict:
    from .backend_client import canonical_conversation_id_from_url

    state = dict(state)
    url = state.get('url')
    try:
        parsed = urlsplit(url) if isinstance(url, str) else None
        valid_origin = parsed and parsed.scheme == 'https' and parsed.netloc == 'chatgpt.com'
    except ValueError:
        valid_origin = False
    if state.get('reason') == 'probe_invalid':
        return state
    if not valid_origin:
        state.update(ready=False, reason='unexpected_origin')
    elif conversation_id and canonical_conversation_id_from_url(url) != conversation_id:
        state.update(ready=False, reason='conversation_mismatch')
    return state


async def probe_composer(driver, *, timeout: float = 3, conversation_id=None) -> dict:
    raw = await driver._js_strict(COMPOSER_PROBE_JS, timeout=timeout)
    try:
        state = json.loads(raw) if isinstance(raw, str) else raw
        if not isinstance(state, dict) or not isinstance(state.get('ready'), bool):
            raise ValueError('invalid readiness probe')
    except (ValueError, TypeError):
        state = {'ready': False, 'reason': 'probe_invalid'}
    expected = conversation_id or driver._current_conv_id or getattr(driver, '_conv_affinity', None)
    return validate_page(state, expected)


async def wait_composer_ready(driver, *, timeout: float = 8, conversation_id=None) -> dict:
    """One absolute deadline includes slow CDP calls; no refresh or navigation."""
    started = time.monotonic()
    target_id = driver._target_id
    state = {'ready': False, 'reason': 'probe_timeout'}
    try:
        async with asyncio.timeout(timeout):
            while True:
                remaining = timeout - (time.monotonic() - started)
                # Do not start a doomed millisecond CDP call at the end of a
                # DOM wait and turn normal absence into a poisoned transport.
                if remaining < 0.25 and state.get('reason') != 'probe_timeout':
                    break
                state = await probe_composer(driver, timeout=max(0.01, min(3, remaining)),
                                            conversation_id=conversation_id)
                if driver._target_id != target_id:
                    state.update(ready=False, reason='target_changed')
                if state.get('ready'):
                    return state
                transient = state.get('reason') in {
                    'composer_missing', 'loading', 'composer_disabled',
                } or (state.get('reason') == 'unsupported_composer' and not state.get('draft_present'))
                if not transient:
                    break
                await asyncio.sleep(0.25)
    except TimeoutError as exc:
        # CDPTimeoutError is a typed transport failure with its own recovery.
        from .cdp_transport import CDPTimeoutError
        if isinstance(exc, CDPTimeoutError):
            raise
    state['elapsed_s'] = round(time.monotonic() - started, 3)
    raise ComposerReadinessError(state, target_id=target_id)


async def recover_composer(driver, error: ComposerReadinessError) -> None:
    """Reload the SAME page once only after a fresh no-draft/no-submit proof."""
    async with asyncio.timeout(15):
        if driver.delivery_metadata.get('delivery_stage') != 'not_started':
            raise error
        if driver._target_id != error.target_id:
            raise ComposerReadinessError({'reason': 'target_changed'}, target_id=driver._target_id)
        state = await probe_composer(driver)
        if driver._target_id != error.target_id:
            raise ComposerReadinessError({'reason': 'target_changed'}, target_id=driver._target_id)
        if state.get('url') != error.readiness.get('url'):
            state.update(ready=False, reason='page_changed')
        if state.get('ready'):
            return
        current = ComposerReadinessError(state, target_id=driver._target_id)
        if not current.recovery_eligible:
            raise current
        # Normal browser navigation, no cache/permission/security bypass.
        response = await driver._cdp('Page.reload', {})
        if isinstance(response, dict) and response.get('error'):
            from .cdp_transport import CDPTransport
            CDPTransport._raise_for_cdp_error('Page.reload', response, 15)
            raise ComposerReadinessError({'reason': 'reload_failed'}, target_id=driver._target_id)
        after = await wait_composer_ready(driver, timeout=10)
        if after.get('url') != state.get('url'):
            after.update(ready=False, reason='page_changed')
            raise ComposerReadinessError(after, target_id=driver._target_id)
