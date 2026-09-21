"""Run production composer JavaScript against synthetic DOM in real Chrome.

Uses one disposable background about:blank tab on the configured CDP browser.
Does not read or change account pages, or send any ChatGPT message.
"""
from __future__ import annotations

import argparse
import asyncio
import json

import websockets

from chatgpt_web2api.cdp_driver import CDPDriver
from chatgpt_web2api.chatgpt_dom import SEND_BUTTON_JS
from chatgpt_web2api.composer_surface import COMPOSER_ELEMENT_JS, COMPOSER_PROBE_JS
from chatgpt_web2api.runtime_info import get_runtime_info

EDITOR = '<div id="prompt-textarea" contenteditable="true" data-fixture="live"><p><br></p></div>'
BUTTON = '<button id="composer-submit-button" type="submit">Send</button>'


async def verify(port: int) -> dict:
    driver = CDPDriver(cdp_port=port)
    report = {'scope': 'synthetic_dom_real_browser_no_send', 'runtime': get_runtime_info(), 'checks': []}
    target = None
    denied = False
    try:
        async with asyncio.timeout(40):
            created = await driver._browser_cdp('Target.createTarget', {'url': 'about:blank', 'background': True})
            target = created['result']['targetId']
            driver._target_id = target
            driver._ws = await websockets.connect(
                f'ws://127.0.0.1:{port}/devtools/page/{target}', open_timeout=3, close_timeout=1,
            )
            driver._reader_task = asyncio.create_task(driver._reader_loop())
            tree = await driver._cdp('Page.getFrameTree')
            frame = tree['result']['frameTree']['frame']['id']

            async def fixture(name, html, reason='ready', selected='live', send=False):
                await driver._cdp('Page.setDocumentContent', {
                    'frameId': frame,
                    'html': '<!doctype html><style>[contenteditable]{min-height:24px;min-width:120px}</style>' + html,
                })
                observed = json.loads(await driver._js_strict(COMPOSER_PROBE_JS, timeout=3))
                assert observed['reason'] == reason, (name, observed)
                actual = await driver._js_strict(f'({COMPOSER_ELEMENT_JS})?.dataset.fixture || "none"', timeout=3)
                assert actual == selected, (name, actual)
                if send:
                    btn = await driver._js_strict(f'({SEND_BUTTON_JS})?.id || "none"', timeout=3)
                    assert btn == 'composer-submit-button', (name, btn)
                report['checks'].append(name)

            await fixture('role_optional', '<form>' + EDITOR + BUTTON + '</form>', send=True)
            await fixture('testid_variant', '<form>' + EDITOR.replace('id="prompt-textarea"', 'data-testid="prompt-textarea"') + '</form>')
            await fixture('prosemirror_variant', '<form>' + EDITOR.replace('id="prompt-textarea"', 'class="ProseMirror"') + '</form>')
            await fixture('hidden_legacy_fallback', '<form><textarea id="prompt-textarea" hidden>old</textarea>' + EDITOR + '</form>')
            await fixture('hidden_old_editor_first', '<form><div id="prompt-textarea" contenteditable="true" style="display:none">old</div>' + EDITOR + '</form>')
            await fixture('message_editor_excluded', '<article>' + EDITOR + '</article><form>' + EDITOR + '</form>')
            await fixture('search_editor_excluded', '<main><div contenteditable="true">search</div><form>' + EDITOR + '</form></main>')
            await fixture('hidden_only', '<form><textarea id="prompt-textarea" hidden></textarea></form>', 'composer_missing', 'none')
            await fixture('noneditable_div', '<form>' + EDITOR.replace('contenteditable="true"', '') + '</form>', 'composer_disabled', 'none')
            await fixture('readonly_textarea', '<form><textarea id="prompt-textarea" readonly></textarea></form>', 'composer_disabled', 'none')
            await fixture('duplicate_visible_editors', '<form>' + EDITOR + EDITOR + '</form>', 'ambiguous_composer', 'none')
            await fixture('unknown_editor', '<main><div contenteditable="true">draft</div></main>', 'unsupported_composer', 'none')
            await fixture('legacy_visible_textarea', '<form><textarea id="prompt-textarea" data-fixture="live"></textarea></form>')
            await fixture('hidden_old_send_button', '<form><button data-testid="send-button" hidden>Old</button>' + EDITOR + BUTTON + '</form>', send=True)
            await fixture('other_form_send_button', '<form><button data-testid="send-button">Other</button></form><form>' + EDITOR + BUTTON + '</form>', send=True)
            await fixture('challenge', '<form id="challenge-form">Verify</form>', 'challenge', 'none')
            await fixture('login', '<button data-testid="login-button">Login</button>', 'login_required', 'none')
            await fixture('blocking_dialog', '<dialog open aria-modal="true">Sign in</dialog>', 'blocking_dialog', 'none')
            report['ok'] = True
    except PermissionError:
        denied = True
        report.update(ok=False, error='PermissionError')
    except Exception as exc:
        report.update(ok=False, error=type(exc).__name__, message=str(exc)[:400])
    finally:
        await driver._stop_cdp_session(fail_pending=True, reset_poison=True, timeout=2)
        if target and not denied:
            await driver._browser_cdp('Target.closeTarget', {'targetId': target})
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cdp-port', type=int, default=9222)
    args = parser.parse_args()
    report = asyncio.run(verify(args.cdp_port))
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report['ok'] else 1)


if __name__ == '__main__':
    main()
