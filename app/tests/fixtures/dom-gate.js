/**
 * DOM gate driver — runs INSIDE Electron. Loads the real bridge UI offscreen,
 * drives the six review-mandated surfaces through the DOM itself, then prints
 * one `DOMGATE {json}` line for the node:test parent to assert on.
 *
 * env: DOM_GATE_URL — the http-bridge base URL.
 */
import { app, BrowserWindow } from 'electron';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');

const url = process.env.DOM_GATE_URL;
if (!url) { console.log('DOMGATE {"ok":false,"error":"no DOM_GATE_URL"}'); app.exit(2); }

const DRIVER = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (sel, fn, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = [...document.querySelectorAll(sel)].find((e) => !fn || fn(e));
      if (hit) return hit;
      await sleep(120);
    }
    return null;
  };
  const checks = {};
  try {
    await waitFor('#statusline', (e) => e.textContent.trim().length > 0, 25000);

    // 1. statusline — model + mode + workdir on the bottom row
    let slErr = null;
    try { await refreshState(); await paintStatusline(); } catch (e) { slErr = String(e?.stack ?? e); }
    const sl = document.querySelector('#statusline');
    checks.statusline = {
      ok: !!sl && sl.textContent.includes('fake-1') && /执行|计划/.test(sl.textContent),
      text: sl?.textContent ?? '', err: slErr,
      chip: document.querySelector('#model-chip')?.textContent ?? '',
    };

    // 2. todo panel — todos_list rendered as checklist rows
    const tp = await waitFor('#todo-panel:not(.hidden) .todo-item');
    checks.todoPanel = { ok: !!tp, count: document.querySelectorAll('#todo-panel .todo-item').length };

    // 3. @-attach — typing @note.txt then sending must attach the workdir file
    const input = document.querySelector('#input');
    input.value = '看 @note.txt 的内容';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send').click();
    const sysAttach = await waitFor('.sys', (e) => e.textContent.includes('已附着'), 10000);
    checks.atAttach = { ok: !!sysAttach };

    // 4. approval card — real payload visible (the exact command), not a bare summary
    const ask = await waitFor('.ask-card .ask-cmd', (e) => e.textContent.includes('rm -rf scratch/'), 10000);
    checks.askPayload = { ok: !!ask, text: ask?.textContent ?? '' };

    // 5. tool cards — bash output + edit diff both rendered pre-approval
    const tools = [...document.querySelectorAll('.tool')];
    checks.toolCards = {
      ok: tools.length >= 2
        && [...document.querySelectorAll('.tool pre')].some((p) => p.textContent.includes('domgate-out'))
        && [...document.querySelectorAll('.tool')].some((t) => t.textContent.includes('const x')),
      count: tools.length,
    };

    // approve → card resolves, turn completes
    document.querySelector('.ask-btn[data-a="allow"]')?.click();
    const resolved = await waitFor('.ask-card.resolved', null, 10000);
    checks.askResolved = { ok: !!resolved };

    // 6b. image attachment — a pasted image must arrive as options.images (B2)
    const f = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(f);
    input.value = '看图';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Synthetic ClipboardEvent.clipboardData is unreliable in headless —
    // the drop path exercises the same attachFiles() wiring via DragEvent,
    // whose dataTransfer init IS honored.
    const composer = document.querySelector('#composer');
    composer.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const chipEl = await waitFor('#attach-row .attach-chip', null, 8000);
    checks.imageChip = { ok: !!chipEl, text: chipEl?.textContent ?? '' };
    document.querySelector('#send').click();
    const imgEcho = await waitFor('.msg .bubble', (e) => e.textContent.includes('收到图片 1'), 10000);
    checks.imageAttach = { ok: !!imgEcho, text: imgEcho?.textContent ?? '' };

    // 6. job detail — jobs view row → drawer with real command + output tail
    switchView('jobs');
    const row = await waitFor('#jobs tbody tr.clickable');
    row?.click();
    const jd = await waitFor('#job-detail:not(.hidden) .jd-cmd', (e) => e.textContent.includes('pytest'), 10000);
    checks.jobDetail = {
      ok: !!jd && document.querySelector('#job-detail .jd-out')?.textContent.includes('collecting'),
      cmd: jd?.textContent ?? '',
    };

    return {
      ok: Object.values(checks).every((c) => c.ok), checks,
      pageErrors: window.__errs ?? [],
      transcriptTail: document.querySelector('#transcript')?.textContent?.slice(-600) ?? '',
      queueLen: queue.length, busy,
    };
  } catch (e) {
    return { ok: false, error: String(e?.stack ?? e), checks, pageErrors: window.__errs ?? [] };
  }
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { offscreen: true, sandbox: false },
  });
  const consoleErrs = [];
  win.webContents.on('console-message', (_e, _lvl, msg) => consoleErrs.push(msg));
  try {
    await win.loadURL(url);
    await win.webContents.executeJavaScript(
      'window.__errs=[];window.addEventListener("error",e=>__errs.push(String(e.error?.stack??e.message)));window.addEventListener("unhandledrejection",e=>__errs.push("rej:"+String(e.reason?.stack??e.reason)));1');
    const results = await win.webContents.executeJavaScript(DRIVER);
    results.pageErrors = [...(results.pageErrors ?? []), ...consoleErrs].slice(0, 12);
    console.log(`DOMGATE ${JSON.stringify(results)}`);
    app.exit(results?.ok ? 0 : 1);
  } catch (e) {
    console.log(`DOMGATE ${JSON.stringify({ ok: false, error: String(e) })}`);
    app.exit(2);
  }
});
