"""Opt-in no-send acceptance test of the INSTALLED bridge and real browser.

Run with the same Python interpreter used by the host's MCP installation:
    python scripts/verify_browser.py --cdp-port 9222

Creates its own background scratch tab, types synthetic text, verifies and
clears it, exercises same-target reconnect and cancellation, then closes only
that tab. Never calls click_send or sends a ChatGPT message. No token, project
name, conversation content or browser URL is printed. JSON output describes
this process; it is NOT an attestation of an already-running host connection.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time

from chatgpt_web2api.cdp_driver import CDPDriver
from chatgpt_web2api.cdp_transport import CDPTimeoutError
from chatgpt_web2api.composer_surface import COMPOSER_ELEMENT_JS, wait_composer_ready
from chatgpt_web2api.runtime_info import get_runtime_info
from chatgpt_web2api.send_recovery import run_with_send_recovery


async def verify(port: int) -> dict:
    report = {"runtime": get_runtime_info(), "scope": "fresh_process_no_send", "checks": []}
    driver = CDPDriver(cdp_port=port, tab_mode="owned", parallel_tabs=True)

    async def check(name, operation, budget=15):
        report["current_check"] = name
        started = time.monotonic()
        async with asyncio.timeout(budget):
            value = await operation()
        report["checks"].append({"name": name, "elapsed_s": round(time.monotonic() - started, 3)})
        report.pop("current_check", None)
        return value

    async def attach():
        # connect() alone can adopt an existing shared homepage. Explicitly
        # create our disposable target first, so no user's draft is touched.
        await driver._create_owned_tab(scratch=True)
        await driver.connect()
        assert driver._owns_target and driver._scratch_target_id == driver._target_id
        assert not driver._current_conv_id

    permission_denied = False
    try:
        await check("owned_scratch_connect", attach, 45)
        original_target = driver._target_id

        async def probe():
            assert await driver._js_strict("6 * 7", timeout=3) == 42

        await check("evaluate", probe)

        async def delayed_composer():
            # Only this verifier's empty, disposable page is modified.
            await driver._js_strict(
                '(() => { const el = ' + COMPOSER_ELEMENT_JS + ';'
                ' if (!el || el.textContent.trim()) throw new Error("scratch not empty");'
                ' const parent = el.parentNode; const next = el.nextSibling; el.remove();'
                ' setTimeout(() => parent.insertBefore(el, next), 500); return true; })()'
            )
            await wait_composer_ready(driver, timeout=3)
        await check("composer_delayed_mount", delayed_composer)

        async def missing_composer_recovery():
            await driver._js_strict(
                '(() => { const el = ' + COMPOSER_ELEMENT_JS + ';'
                ' if (!el || el.textContent.trim()) throw new Error("scratch not empty");'
                ' el.remove(); return true; })()'
            )
            original_cdp = driver._cdp
            reloads = []
            async def observe(method, *args, **kwargs):
                if method == 'Page.reload':
                    reloads.append(driver._target_id)
                return await original_cdp(method, *args, **kwargs)
            driver._cdp = observe
            try:
                await run_with_send_recovery(driver, lambda: wait_composer_ready(driver, timeout=0.3))
                assert reloads == [original_target]
                assert driver._target_id == original_target
            finally:
                driver._cdp = original_cdp
        await check("missing_composer_one_same_page_recovery", missing_composer_recovery, 20)

        async def role_optional():
            await driver._js_strict(f'(() => {{ ({COMPOSER_ELEMENT_JS}).removeAttribute("role"); return true; }})()')
            await driver.type_message('role-optional test')
            assert await driver._clear_composer()
        await check("role_optional_real_editor_input", role_optional)

        # Public backend access has its own acceptance entrypoint:
        # verify_stdio.py --read. Do not duplicate account reads here or let
        # an upstream read failure prevent transport/composer checks running.
        for lines in (90, 300):
            payload = "\n".join(f"测试 {i:03d} — café 😀  A  B\tC" for i in range(lines))

            async def composer():
                # type_message's production canonical verifier is authoritative.
                await driver.type_message(payload)
                assert await driver._clear_composer(), "composer clear failed"

            await check(f"composer_{lines}_lines_exact_verify_and_clear", composer, 10)

        async def cancelled_read():
            task = asyncio.create_task(driver._js_strict(
                "new Promise(resolve => setTimeout(() => resolve(1), 1000))", timeout=3
            ))
            await asyncio.sleep(0.1)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            await probe()

        await check("read_after_cancellation", cancelled_read, 20)

        async def timeout_recovery():
            old_socket = driver._ws
            old_reader = driver._reader_task
            try:
                # Observation-only fault: no DOM or network side effects.
                await driver._js_strict("new Promise(function(){})", timeout=0.5)
            except CDPTimeoutError:
                pass
            else:
                raise AssertionError("pending evaluate did not time out")
            assert driver._session_poisoned
            await probe()  # Real poison recovery, including its own sanity probe.
            assert driver._ws is not old_socket and old_reader.done()
            assert driver._target_id == original_target

        await check("evaluate_timeout_then_automatic_same_target_recovery", timeout_recovery, 10)

        for attempt in range(3):
            async def reattach():
                await driver.reconnect_for_send_recovery()
                assert driver._target_id == original_target
                await probe()
                assert not driver._pending and not driver._pending_meta
                assert driver._reader_task and not driver._reader_task.done()

            await check(f"same_target_reattach_{attempt + 1}", reattach, 20)

        async def concurrent_reads():
            values = await asyncio.gather(*(
                driver._js_strict(str(i), timeout=3) for i in range(12)
            ))
            assert values == list(range(12))
            assert not driver._pending and not driver._pending_meta

        await check("concurrent_response_routing", concurrent_reads)
        report["ok"] = True
    except PermissionError:
        permission_denied = True
        report["failed_check"] = report.get("current_check")
        report.update(ok=False, error="PermissionError", reason="Browser access denied; no recovery or alternate access attempted")
    except Exception as exc:
        report["failed_check"] = report.get("current_check")
        report.update(ok=False, error=type(exc).__name__)
        report['reason'] = getattr(exc, 'readiness', {}).get('reason')
        report['recovery_attempts'] = getattr(exc, 'recovery_attempts', None)
    finally:
        if not permission_denied:
            try:
                await check("close_owned_scratch", driver.close, 15)
            except Exception as exc:
                report.update(ok=False, cleanup_error=type(exc).__name__)
        else:
            # Closing our local socket is safe; do not issue another browser
            # command after a permission denial, even for tab cleanup.
            if driver._ws is not None:
                await driver._ws.close()
        report["runtime_after"] = get_runtime_info()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cdp-port", type=int, default=9222)
    args = parser.parse_args()
    result = asyncio.run(verify(args.cdp_port))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result["ok"] else 1)


if __name__ == "__main__":
    main()
