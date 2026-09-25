/**
 * DOM gate driver — runs INSIDE Electron. Loads the real bridge UI offscreen,
 * drives the six review-mandated surfaces through the DOM itself, then prints
 * one `DOMGATE {json}` line for the node:test parent to assert on.
 *
 * env: DOM_GATE_URL — the http-bridge base URL.
 */
import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');

const url = process.env.DOM_GATE_URL;
if (!url) { console.log('DOMGATE {"ok":false,"error":"no DOM_GATE_URL"}'); app.exit(2); }

// axe-core source, injected into the page after the driver run. The approval
// card is a safety-critical surface: a11y defects there cause mis-approval, so
// the a11y check is part of the gate, not an optional extra.
const AXE_A11Y_ONLY = process.env.DOM_GATE_AXE !== '0';
let axeSource = '';
if (AXE_A11Y_ONLY) {
  try {
    const require = createRequire(import.meta.url);
    axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  } catch (e) {
    axeSource = '';
    console.error(`dom-gate: axe-core unavailable, a11y check skipped: ${e?.message ?? e}`);
  }
}

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

    // #1392 — edit-then-approve + wand action: open the edit box, describe
    // the change in plain language, the fast-model rewrite lands IN THE BOX
    // for review, then approval carries the edited command envelope.
    document.querySelector('.ask-edit-toggle')?.click();
    const editBox = await waitFor('.ask-edit:not(.hidden)', null, 8000);
    const wandRow = await waitFor('.ask-wand:not(.hidden)', null, 8000);
    checks.askEditWand = { ok: !!editBox && !!wandRow };
    document.querySelector('.ask-wand-in').value = '只删 .log 文件';
    document.querySelector('.ask-wand-btn').click();
    const wandDone = await waitFor('.ask-edit', (e) => e.value.includes('# 只删 .log 文件'), 8000);
    checks.wandRewrite = {
      ok: !!wandDone,
      text: document.querySelector('.ask-edit')?.value ?? '',
      toast: [...document.querySelectorAll('.toast')].map((x) => x.textContent),
      btn: document.querySelector('.ask-wand-btn')?.textContent ?? '',
    };

    // #1507 — MCP Apps surface: the tool result declares details.ui, so the
    // card offers an explicit open button; clicking fetches the ui:// resource
    // through the host and renders it in a sandboxed iframe (no same-origin,
    // no bridge — opaque origin only).
    const appCard = [...document.querySelectorAll('.tool')].find((t) => t.textContent.includes('chart data'));
    const appBtn = appCard?.querySelector('.mcp-app-btn');
    checks.mcpAppButton = { ok: !!appBtn, title: appBtn?.title ?? '' };
    appBtn?.click();
    const appFrame = await waitFor('iframe.mcp-app-frame', null, 8000);
    checks.mcpAppFrame = {
      ok: !!appFrame
        && appFrame?.getAttribute('sandbox') === 'allow-scripts'
        && !appFrame?.getAttribute('sandbox')?.includes('same-origin')
        && (appFrame?.srcdoc ?? '').includes('chart-app'),
      sandbox: appFrame?.getAttribute('sandbox') ?? null,
    };

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

    /* ---- batch-4 UI features (M109/M126/M127/M128/M129/C1) ---- */
    switchView('chat');
    const inputEl = document.querySelector('#input');

    // M126 — draft-level undo: a programmatic snapshot survives Ctrl+Z
    inputEl.value = 'domgate-draft-A';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    pushDraft();
    inputEl.value = 'domgate-draft-B';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    checks.draftUndo = { ok: inputEl.value === 'domgate-draft-A', got: inputEl.value };
    // redo walks back forward
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
    checks.draftRedo = { ok: inputEl.value === 'domgate-draft-B', got: inputEl.value };
    inputEl.value = ''; inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    // M127 — fuzzy matching + session entries in the slash surface
    checks.fuzzyScore = {
      ok: fuzzyScore('nw', 'new') > 0 && fuzzyScore('zzz', 'new') === -1
        && fuzzyScore('ss', 'sessions') > 0,
    };
    sessionsCache.push({
      path: 'zz-domgate-session.jsonl', name: 'zzdomgate target',
      firstMessage: '', modified: new Date().toISOString(), messageCount: 1,
    });
    inputEl.value = '/zzdomgate';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    const sessItem = await waitFor('.slash-item', (e) => e.textContent.includes('切换到会话'), 6000);
    checks.slashSession = { ok: !!sessItem, items: document.querySelectorAll('.slash-item').length };
    inputEl.value = ''; inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    // M109 — transcript selection shows the quote button; click inserts '> '
    const bub = [...document.querySelectorAll('#transcript .msg .bubble')].pop();
    if (bub) {
      const rng = document.createRange(); rng.selectNodeContents(bub);
      const sel2 = window.getSelection(); sel2.removeAllRanges(); sel2.addRange(rng);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      await sleep(80);
      let upErr = null;
      try { updateSelQuote(); } catch (e) { upErr = String(e?.stack ?? e); }
      const qb = document.querySelector('#sel-quote:not(.hidden)');
      const selTxt = String(window.getSelection());
      const anch = window.getSelection()?.anchorNode;
      qb?.click();
      checks.selQuote = {
        ok: !!qb && inputEl.value.includes('> '), val: inputEl.value.slice(0, 60),
        selLen: selTxt.length, collapsed: window.getSelection()?.isCollapsed,
        btnExists: !!document.querySelector('#sel-quote'),
        btnHidden: document.querySelector('#sel-quote')?.classList?.contains('hidden'),
        upErr,
        anchName: anch?.nodeName,
        anchInT: !!(anch && (anch instanceof Element ? anch : anch.parentElement) && document.querySelector('#transcript').contains(anch instanceof Element ? anch : anch.parentElement)),
        quoteTxt: selQuoteText?.length,
      };
    } else checks.selQuote = { ok: false, why: 'no .msg .bubble to select' };
    inputEl.value = ''; inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    // M128 — scroll preference persists to localStorage
    const sc = document.querySelector('#set-scroll');
    sc.value = 'always'; sc.dispatchEvent(new Event('change'));
    checks.scrollPref = { ok: localStorage.getItem('pai.scrollmode') === 'always' };
    sc.value = 'near'; sc.dispatchEvent(new Event('change'));

    // M129 — long paste carrying path:line refs badges the attach chip
    const longTxt = 'line '.repeat(400) + ' src/foo.ts:42:7 boom';
    const dt2 = new DataTransfer(); dt2.items.add(longTxt, 'text/plain');
    inputEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt2, bubbles: true, cancelable: true }));
    const refChip = await waitFor('#attach-row .attach-refs', null, 6000);
    checks.pasteBadge = { ok: !!refChip && refChip.textContent.includes('src/foo.ts:42'), text: refChip?.textContent ?? '' };
    document.querySelector('#attach-row .attach-x')?.click();

    // C1 — pinned group, status dot element, hover card with real metadata
    sessionsCache[0].pinned = true;
    renderSessions();
    const pinHdr = [...document.querySelectorAll('.sess-group')].find((h) => h.textContent.includes('置顶'));
    const sessRow = document.querySelector('#session-list .sess');
    checks.sessPinnedGroup = { ok: !!pinHdr };
    checks.sessDot = { ok: !!sessRow?.querySelector('.sess-dot') };
    sessRow?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    await sleep(600);
    const card = document.querySelector('#sess-card');
    checks.sessCard = {
      ok: !!card && card.textContent.includes('条') && card.textContent.includes('修改'),
      text: card?.textContent?.slice(0, 90) ?? '',
    };
    sessRow?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));

    // dedup-h #2173 — a session whose cwd is a git worktree carries the
    // branch name in its sess-meta (upstream sidebar branch display).
    await refreshSessions();
    const metas = [...document.querySelectorAll('#session-list .sess .sess-meta')].map((m) => m.textContent);
    checks.sessBranchTag = {
      ok: metas.some((m) => m.includes('⎇ main')) && metas.every((m) => !m.includes('⎇') || m.includes('⎇ main')),
      text: metas.join(' | '),
    };

    // dedup-h #753 — threaded /resume ordering: a fork renders indented
    // (↳ title + padding) immediately under its parent inside its group.
    const nowIso = new Date().toISOString();
    sessionsCache.push(
      { path: '/tmp/domgate/root.jsonl', name: 'TRoot', modified: nowIso, messageCount: 1 },
      { path: '/tmp/domgate/child.jsonl', name: 'TChild', modified: nowIso, messageCount: 1, parentSessionPath: '/tmp/domgate/root.jsonl' },
      { path: '/tmp/domgate/grand.jsonl', name: 'TGrand', modified: nowIso, messageCount: 1, parentSessionPath: '/tmp/domgate/child.jsonl' },
    );
    renderSessions();
    const tTitles = [...document.querySelectorAll('#session-list .sess .sess-title')].map((t) => t.textContent);
    const ri = tTitles.indexOf('TRoot');
    const ci = tTitles.indexOf('↳ TChild');
    const gi = tTitles.indexOf('↳ TGrand');
    const tRows = [...document.querySelectorAll('#session-list .sess')];
    checks.sessThread = {
      ok: ri >= 0 && ci === ri + 1 && gi === ri + 2
        && Number.parseInt(tRows[ci]?.style.paddingLeft ?? '0', 10) > 10
        && Number.parseInt(tRows[gi]?.style.paddingLeft ?? '0', 10) > Number.parseInt(tRows[ci]?.style.paddingLeft ?? '0', 10),
      order: [ri, ci, gi].join(','),
    };
    sessionsCache.length -= 3;

    // dedup-h #895 — Session Insights button: on-demand aggregate analysis
    // from the drawer; nothing computes insights unless asked.
    const insBtn = [...document.querySelectorAll('.sess-insights-btn')][0];
    insBtn?.click();
    await sleep(250);
    const insTxt = document.querySelector('#transcript')?.textContent ?? '';
    checks.sessInsights = {
      ok: !!insBtn && insTxt.includes('聚合剖析 2 个会话') && insTxt.includes('bash×3'),
      btn: !!insBtn, saw: insTxt.includes('聚合剖析'),
    };

    // candidates-open #2 — /worktree dispatches job_spawn{worktree:true} and
    // lands the operator in the jobs view on success.
    inputEl.value = '/worktree echo domgate';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(250);
    const sysTail = document.querySelector('#transcript')?.textContent ?? '';
    checks.worktreeCmd = {
      ok: currentView === 'jobs' && !sysTail.includes('worktree 任务失败'),
      view: currentView, tail: sysTail.slice(-120),
    };
    switchView('chat');
    inputEl.value = ''; inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    // dedup-h #509 — bare /worktree = management pane (worktree_list cmd,
    // rendered rows with managed flag); /worktree-open dispatches
    // job_spawn{in_worktree} and lands in jobs view.
    inputEl.value = '/worktree';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(250);
    const wtPane = document.querySelector('#transcript')?.textContent ?? '';
    checks.worktreeList = {
      ok: wtPane.includes('git worktrees（2）') && wtPane.includes('wt-linked') && wtPane.includes('(任务托管)'),
      tail: wtPane.slice(-160),
    };
    inputEl.value = '/worktree-open wt-linked echo hi';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(250);
    checks.worktreeOpen = {
      ok: currentView === 'jobs' && !((document.querySelector('#transcript')?.textContent ?? '').includes('打开 worktree 失败')),
      view: currentView,
    };
    switchView('chat');
    inputEl.value = ''; inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    /* dedup-h #3094 — recipe argument-hint: the /recipe picker row shows the
     * authored [topic] [depth] signature, and picking the recipe prints a
     * missing-params line carrying the authored hint (not synthesized k=v).
     * Runs BEFORE the worktree pick — set_workdir moves the recipes root. */
    inputEl.value = '/recipe';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(80);
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const hinted = await waitFor('#chip-menu .menu-item .mi-sub', (e) => e.textContent.includes('[topic] [depth]'), 8000);
    hinted?.closest('.menu-item')?.click();
    const hintLine = await waitFor('.sys', (e) => e.textContent.includes('[topic] [depth]'), 8000);
    checks.recipeArgHint = { ok: !!hinted && !!hintLine, listed: !!hinted, hintShown: !!hintLine };
    document.querySelector('#chip-menu')?.classList.add('hidden');

    /* dedup-h #1353 — draft thread targets a worktree: the sidebar worktree
     * button lists git worktrees; picking wt-linked runs the REAL supervisor
     * set_workdir (existsSync passes — fixture dir is real) → body respawn →
     * session_new on the new workdir. Assert the menu listed the entry, the
     * toast confirmed, and refreshed state reports the new workdir + fresh
     * session file. */
    document.querySelector('#new-task-wt')?.click();
    const wtItem = await waitFor('#wt-menu .menu-item', (e) => e.textContent.includes('wt-linked'), 8000);
    checks.wtPickerListed = { ok: !!wtItem, count: document.querySelectorAll('#wt-menu .menu-item').length };
    wtItem?.click();
    // Match the NEW-session toast specifically — the earlier /worktree-open
    // check leaves a '/repo/wt-linked' job toast in the box for ~4.4s, and a
    // bare 'wt-linked' match would return before session_new even lands.
    const wtToast = await waitFor('.toast', (e) => e.textContent.includes('wt-linked') && e.textContent.includes('新会话'), 15000);
    // Poll state until the respawned body reports the fresh session file —
    // set_workdir resolves before session_new lands, so one fixed sleep races.
    let stErr = null, stOk = false;
    for (let i = 0; i < 25 && !stOk; i++) {
      try { await refreshState(); } catch (e) { stErr = String(e?.stack ?? e); }
      stOk = String(state?.workdir ?? '').endsWith('wt-linked')
        && String(state?.session?.file ?? '').endsWith('new.jsonl');
      if (!stOk) await sleep(200);
    }
    checks.worktreeNewSession = {
      ok: !!wtToast && stOk,
      toast: !!wtToast, workdir: state?.workdir ?? '', file: state?.session?.file ?? '', stErr,
    };

    /* dedup-h #143 — model-invoked builtin commands: queued while the turn
     * is live, drained on agent_end, executed through the same paths as the
     * operator's slash commands. The scripted '看图' turn still has its ask
     * pending — requests now must queue, not run mid-turn. */
    onAgentEvent({ type: 'command_request', name: 'config', arg: '' });
    await sleep(250);
    checks.cmdQueuedWhileBusy = {
      ok: sessionCmdQueue.length === 1
        && !(document.querySelector('#transcript')?.textContent ?? '').includes('模型请求执行 /config'),
      len: sessionCmdQueue.length,
    };
    document.querySelector('.ask-btn[data-a="allow"]')?.click();
    const cfgLine = await waitFor('.sys', (e) => e.textContent.includes('当前设置'), 10000);
    checks.cmdConfig = {
      ok: !!cfgLine
        && (document.querySelector('#transcript')?.textContent ?? '').includes('模型请求执行 /config'),
      text: cfgLine?.textContent ?? '',
    };
    onAgentEvent({ type: 'command_request', name: 'resume', arg: 'resume-target' });
    await sleep(500);
    checks.cmdResume = {
      ok: String(currentSessionFile).endsWith('s2.jsonl'),
      file: currentSessionFile,
      tail: (document.querySelector('#transcript')?.textContent ?? '').slice(-200),
      errs: (window.__errs ?? []).slice(-3),
    };
    onAgentEvent({ type: 'command_request', name: 'resume', arg: 'zzz-no-match' });
    const missLine = await waitFor('.sys', (e) => e.textContent.includes('找不到会话'), 8000);
    checks.cmdResumeMiss = { ok: !!missLine };
    onAgentEvent({ type: 'command_request', name: 'model', arg: 'fake/fake-2' });
    const mdlLine = await waitFor('.sys', (e) => e.textContent.includes('模型请求执行 /model fake/fake-2'), 8000);
    checks.cmdModel = { ok: !!mdlLine };

    /* dedup-h #286 — bang-command operator shell: the command runs through
     * the governed bash_run path; its output is stashed and prepended to
     * the NEXT prompt as an <operator-bash> context block. send() is a
     * page global — awaiting it waits for the internal cmd('bash_run')
     * reply, no sleeps. */
    inputEl.value = '!echo domgate-bang';
    await send();
    checks.bangStash = {
      ok: pendingBash.length === 1 && pendingBash[0].command === 'echo domgate-bang'
        && pendingBash[0].output.includes('domgate-bash-out'),
      pending: pendingBash.length, out: pendingBash[0]?.output?.slice(0, 60) ?? '',
    };
    inputEl.value = 'bang next';
    await send();
    const bangMsg = await waitFor('.msg', (e) => e.textContent.includes('domgate-bash-out[echo domgate-bang]'), 8000);
    checks.bangShell = {
      ok: !!bangMsg && bangMsg.textContent.includes('<operator-bash command="echo domgate-bang"'),
      text: bangMsg?.textContent?.slice(0, 140) ?? '',
      drained: pendingBash.length === 0,
    };
    inputEl.value = ''; inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    /* dedup-h #1846 — double-bang context-free form: same governed
     * bash_run and the same TUI display, stored in input history, but the
     * output must NEVER join the next prompt's context (pendingBash stays
     * empty). Single-bang is now history-stored too — recall reaches it. */
    inputEl.value = '!!echo domgate-nocontext';
    await send();
    checks.bangBang = {
      ok: pendingBash.length === 0
        && promptHist[promptHist.length - 1] === '!!echo domgate-nocontext'
        && promptHist.includes('!echo domgate-bang'),
      pending: pendingBash.length,
      hist: promptHist[promptHist.length - 1] ?? '',
      bangInHist: promptHist.includes('!echo domgate-bang'),
    };
    inputEl.value = ''; inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    /* dedup-h #303 — ArrowUp queue-edit: the most recent queued message
     * pulls back into the composer (typed text, not the expanded outbound;
     * image attachments restored onto the attach row; queue pops). */
    queue.push({
      text: 'expanded-outbound', label: 'dg-queued', typed: 'dg-queued',
      attachments: [{ name: 'q.png', mime: 'image/png', data: 'aGk=', bytes: 3 }],
    });
    renderQueue();
    inputEl.value = ''; inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    checks.queueEdit = {
      ok: inputEl.value === 'dg-queued' && queue.length === 0 && pendingAttach.length === 1,
      val: inputEl.value, qlen: queue.length, attach: pendingAttach.length,
    };
    inputEl.value = ''; pendingAttach.length = 0; renderAttach();
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    /* dedup-h #655 — /deep-research sends the recipe_run instruction as a
     * real prompt; the echo proves the full send path ran. The bang turn
     * left a scripted ask pending — resolve it first so send() doesn't
     * queue behind a busy session. */
    document.querySelector('.ask-btn[data-a="allow"]')?.click();
    await waitFor('.sys,.msg', (e) => e.textContent.includes('done'), 8000);
    await sleep(400);
    await SLASH.find((s) => s.cmd === '/deep-research').run('固态电池产业链');
    const drEcho = await waitFor('.msg', (e) => e.textContent.includes('recipe_run') && e.textContent.includes('固态电池产业链'), 10000);
    checks.deepResearch = { ok: !!drEcho, text: drEcho?.textContent?.slice(0, 100) ?? '' };

    /* dedup-h #571 — session_command 'new' (Cline new_task): the model asks
     * for a fresh session whose first message is its handoff briefing; the
     * briefing rides the same prompt path as operator text. The deep-
     * research turn left its scripted ask pending — resolve so 'new' drains. */
    document.querySelector('.ask-btn[data-a="allow"]')?.click();
    await waitFor('.sys,.msg', (e) => e.textContent.includes('done'), 8000);
    await sleep(400); // let agent_end clear busy so the queued request drains
    onAgentEvent({ type: 'command_request', name: 'new', arg: 'handoff: continue fixing parser at src/parse.js' });
    const newBrief = await waitFor('.msg', (e) => e.textContent.includes('handoff: continue fixing parser'), 10000);
    const newEcho = await waitFor('.msg', (e) => e.textContent.includes('echo:handoff: continue fixing parser'), 10000);
    checks.cmdNew = {
      ok: !!newBrief && !!newEcho
        && (document.querySelector('#transcript')?.textContent ?? '').includes('模型请求执行 /new'),
      brief: !!newBrief, echo: !!newEcho,
    };

    /* dedup-h #697 — credential_request form card: a 'secret' field renders
     * as a masked password input; the typed value rides decision_resolve
     * back to the host and is never painted into the transcript. The 'new'
     * turn's scripted ask is still pending — clear it so the card is alone. */
    document.querySelector('.ask-btn[data-a="allow"]')?.click();
    await waitFor('.sys,.msg', (e) => e.textContent.includes('done'), 8000);
    onAgentEvent({ type: 'governance_ask', ask: {
      id: 'ask-cred-1', toolName: 'credential_request', kind: 'form',
      summary: "agent 请求会话凭据 'MY_SERVICE'",
      fields: [{ key: 'value', label: '凭据值 → MY_SERVICE', type: 'secret', required: true }],
      createdAt: new Date().toISOString(), expiresAt: Date.now() + 30000,
    } });
    const pwd = await waitFor('.ask-card input[type="password"]', null, 8000);
    if (pwd) {
      pwd.value = 'sk-live-domgate';
      [...document.querySelectorAll('.ask-card .ask-btn')].find((b) => b.textContent === '提交')?.click();
      await waitFor('.ask-card.resolved', null, 8000);
    }
    checks.credentialForm = {
      ok: !!pwd && !document.querySelector('#transcript')?.textContent?.includes('sk-live-domgate'),
      masked: !!pwd,
      leaked: document.querySelector('#transcript')?.textContent?.includes('sk-live-domgate') ?? null,
    };

    /* dedup-h #1955 — changes view live-updates: open the view (entry
     * refresh shows turn-1's patch receipt — a tool name the old UI set
     * missed), then a second prompt's patch lands a NEW row while the view
     * stays open — real-time, not on-entry refresh. Wait for the credential
     * turn's agent_end first or #send routes to steer(). */
    await waitFor('.sys,.msg', (e) => e.textContent.includes('done'), 8000);
    await sleep(400);
    document.querySelector('.nav-item[data-view="changes"]')?.click();
    const firstRow = await waitFor('#changes tbody .change-path', (e) => e.textContent.includes('gen-0'), 10000);
    const rows0 = document.querySelectorAll('#changes tbody .change-path').length;
    input.value = '再改一处';
    await send(); // page global — if a turn is still draining this queues and sends on agent_end
    // Earlier scripted turns already produced receipts — a NEW row (count
    // grows past rows0 while the view stays open) is the live-update proof.
    const newRow = await waitFor('#changes tbody .change-path',
      () => document.querySelectorAll('#changes tbody .change-path').length > rows0, 10000);
    checks.changesLive = {
      ok: !!firstRow && !!newRow,
      badge: document.querySelector('#badge-changes')?.textContent ?? '',
      rows: rows0 + '->' + document.querySelectorAll('#changes tbody .change-path').length,
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

    // a11y pass — same real DOM, after the driver has driven every surface
    // into its populated state (ask card, tool cards, job drawer).
    if (axeSource) {
      try {
        await win.webContents.executeJavaScript(axeSource);
        const axeRaw = await win.webContents.executeJavaScript(`(async () => {
          const r = await axe.run(document, {
            resultTypes: ['violations'],
            rules: {
              // Offscreen Chromium reports colour-contrast as "incomplete"
              // without a compositor; not a real defect and not runnable here.
              'color-contrast': { enabled: false },
            },
          });
          return r.violations.map((v) => ({
            id: v.id, impact: v.impact, help: v.help,
            nodes: v.nodes.length,
            sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
          }));
        })()`);
        const serious = axeRaw.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        results.checks.a11y = {
          ok: serious.length === 0,
          total: axeRaw.length,
          serious,
            all: axeRaw.map((v) => `${v.id}(${v.impact}):${v.nodes}`),
        };
        if (!results.checks.a11y.ok) results.ok = false;
      } catch (e) {
        results.checks.a11y = { ok: false, error: String(e?.message ?? e) };
        results.ok = false;
      }
    }

    results.pageErrors = [...(results.pageErrors ?? []), ...consoleErrs].slice(0, 12);
    console.log(`DOMGATE ${JSON.stringify(results)}`);
    app.exit(results?.ok ? 0 : 1);
  } catch (e) {
    console.log(`DOMGATE ${JSON.stringify({ ok: false, error: String(e) })}`);
    app.exit(2);
  }
});
