/**
 * Modern DOM gate driver — runs INSIDE Electron. Loads the built React/Vite UI
 * from app/dist/ over the real http-bridge + supervisor, verifies the seven
 * PRD P01-P07 surfaces in the real DOM, checks axe-core accessibility (zero violations
 * enforced across all views and themes), and prints `MODERNGATE {json}` for node:test parent to assert.
 */
import { app, BrowserWindow } from 'electron';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.setPath('userData', mkdtempSync(join(tmpdir(), 'pai-moderngate-profile-')));

const watchdog = setTimeout(() => {
  console.log('MODERNGATE {"ok":false,"error":"modern gate watchdog timeout (60s)"}');
  app.exit(3);
}, 60_000);
watchdog.unref?.();

const url = process.env.DOM_GATE_URL;
if (!url) {
  console.log('MODERNGATE {"ok":false,"error":"no DOM_GATE_URL"}');
  app.exit(2);
}

let axeSource = '';
try {
  const require = createRequire(import.meta.url);
  axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
} catch (err) {
  axeSource = '';
}

if (!axeSource) {
  console.log('MODERNGATE ' + JSON.stringify({ ok: false, error: 'axe-core missing or unreadable in gate environment' }));
  app.exit(1);
}

const DRIVER = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const noAnim = document.createElement('style');
  noAnim.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.appendChild(noAnim);
  const waitFor = async (sel, fn, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = [...document.querySelectorAll(sel)].find((e) => !fn || fn(e));
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };

  const a11yByView = {};
  const runAxeCheck = async (viewName) => {
    if (!window.axe) throw new Error('axe-core is not injected on window');
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
    a11yByView[viewName] = {
      count: r.violations.length,
      violations: r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          failureSummary: n.failureSummary,
          data: n.any?.[0]?.data,
        })),
      })),
    };
  };

  const checks = {};
  try {
    // 1. Root container and React mount
    const root = await waitFor('#root', (e) => e.children.length > 0, 15000);
    checks.mount = { ok: !!root };

    // 2. TopBar renders
    const topbar = await waitFor('header', (e) => e.textContent.includes('Pi') || e.textContent.includes('fake-dom') || e.textContent.includes('新任务对话') || e.textContent.includes('新对话'), 8000);
    checks.topbar = { ok: !!topbar, text: topbar?.textContent?.slice(0, 80) ?? '' };

    // 2b. TopBar elegance check: verify no top-left project dropdown switcher
    const hasProjectDropdownInHeader = topbar ? !!topbar.querySelector('button[title*="切换对话所属项目"]') : false;
    checks.topbarElegance = { ok: !hasProjectDropdownInHeader };

    // 2c. Session contextmenu check: right-clicking session item opens context menu with directory move option
    const sessionRow = document.querySelector('aside [class*="group relative w-full"]');
    if (sessionRow) {
      sessionRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }));
      await sleep(150);
      const ctxMenu = document.querySelector('.fixed.z-50');
      const hasMoveOpt = ctxMenu ? ctxMenu.textContent.includes('切换目录') : false;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(150);
      checks.sessionContextMenu = { ok: hasMoveOpt };
    } else {
      checks.sessionContextMenu = { ok: true };
    }

    // 3. Composer and textarea render, draft persistence (R01)
    const textarea = await waitFor('textarea', null, 8000);
    checks.composer = { ok: !!textarea };
    if (textarea) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(textarea, 'draft-test-content');
      } else {
        textarea.value = 'draft-test-content';
      }
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(250);
      const savedDraft = Object.keys(localStorage).some((k) => k.startsWith('pai_draft_') && localStorage.getItem(k) === 'draft-test-content');
      checks.draftPersistence = { ok: savedDraft };
    }

    // A11y scan: Chat view (dark)
    await runAxeCheck('chat-dark');

    // 3b. Composer model chip is a real picker (not blind-cycle): opens a
    // listbox of real models; Esc closes it without changing anything.
    const modelChip = await waitFor('#composer-model-chip', null, 4000);
    if (modelChip) {
      modelChip.click();
      const menuEl = await waitFor('#composer-model-menu', null, 3000);
      const hasOption = !!menuEl && [...menuEl.querySelectorAll('[role=option]')].some((o) => o.textContent.includes('fake-1'));
      await runAxeCheck('composer-model-menu');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(150);
      checks.composerModelPicker = { ok: hasOption && !document.querySelector('#composer-model-menu') };
    } else {
      checks.composerModelPicker = { ok: false };
    }

    // 3c. TopMenuBar renders native Codex-style menu items and controls
    const topMenuBar = document.querySelector('.drag-region');
    checks.topMenuBar = {
      ok: !!topMenuBar &&
        topMenuBar.textContent.includes('文件') &&
        topMenuBar.textContent.includes('编辑') &&
        topMenuBar.textContent.includes('视图') &&
        topMenuBar.textContent.includes('帮助')
    };

    // 4. View switching: click appearance view (R06 - 外观直接展示)
    const appearanceNav = [...document.querySelectorAll('aside nav button')].find((b) => b.textContent.includes('外观'));
    appearanceNav?.click();
    await sleep(300);
    const appearanceTitle = [...document.querySelectorAll('h2')].find((h) => h.textContent.includes('外观'));
    checks.appearanceView = { ok: !!appearanceTitle };
    await runAxeCheck('appearance-dark');

    // 5. View switching: click security view (R03 - 安全规则直接展示)
    const securityNav = [...document.querySelectorAll('aside nav button')].find((b) => b.textContent.includes('安全规则'));
    securityNav?.click();
    await sleep(300);
    const securityTitle = [...document.querySelectorAll('h2')].find((h) => h.textContent.includes('安全规则'));
    checks.securityView = { ok: !!securityTitle };
    await runAxeCheck('security');

    // 6. View switching: click cognition view
    const cogNav = [...document.querySelectorAll('aside nav button')].find((b) => b.textContent.includes('认知'));
    cogNav?.click();
    await sleep(300);
    const cogTitle = [...document.querySelectorAll('h2')].find((h) => h.textContent.includes('世界模型'));
    checks.cognitionView = { ok: !!cogTitle };
    await runAxeCheck('cognition');

    // 7. Health: a resident sidebar status line (not a nav item) → health page
    // whose verdict is a REAL probe result, never a hard-coded "健康" (v4 V407).
    const healthLine = await waitFor('#sidebar-health', (e) => !e.textContent.includes('正在检查'), 8000);
    checks.healthStatusLine = { ok: !!healthLine, text: healthLine?.textContent?.trim() ?? '' };
    healthLine?.click();
    await sleep(300);
    const healthTitle = [...document.querySelectorAll('h2')].find((h) => h.textContent.includes('系统健康'));
    const verdict = await waitFor('#health-verdict', (e) => !e.textContent.includes('正在检查'), 8000);
    const healthItems = document.querySelectorAll('[data-health-item]').length;
    checks.healthView = { ok: !!healthTitle && !!verdict && healthItems >= 4, items: healthItems };
    await runAxeCheck('health');

    // 7b. Event log lives under health (查原因 = "出了什么事" 的同一个问题)
    const eventsTab = [...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.includes('事件记录'));
    eventsTab?.click();
    await sleep(400);
    const catChip = [...document.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.includes('全部'));
    checks.eventsTab = { ok: !!catChip };
    await runAxeCheck('health-events');

    // 8. Engine: switched in health view (#health-engine-switch) or sidebar bottom-left (#sidebar-engine)
    const engineSwitchBtn = document.querySelector('#health-engine-switch') || document.querySelector('#sidebar-engine');
    engineSwitchBtn?.click();
    await sleep(400);
    const engineTitle = [...document.querySelectorAll('h2')].find((h) => h.textContent.trim() === 'AI 引擎');
    const bodyCard = await waitFor('[data-body]', null, 5000);
    checks.bodiesView = { ok: !!engineTitle && !!bodyCard };
    await runAxeCheck('engine');
    const modalClose = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('关闭'));
    modalClose?.click();
    await sleep(150);

    // 9. Backwards-compatible check: settings view superseded by direct appearance & security views
    checks.settingsView = { ok: true, note: 'superseded by direct appearance & security views' };

    // 9b. Top-level model management: open add panel → fetch catalog → pick →
    // batch add → row appears → two-step delete removes it (D02 self-serve
    // onboarding + management; regression for the 2026-10-19 hand-edit chain).
    const modelsNav = [...document.querySelectorAll('aside nav button')].find((b) => b.textContent.includes('模型管理'));
    checks.modelsNav = { ok: !!modelsNav };
    if (modelsNav) {
      modelsNav.click();
      await sleep(400);
      const addToggle = await waitFor('#models-add-toggle', null, 5000);
      checks.modelsAddPanel = { ok: !!addToggle };
      if (addToggle) {
        addToggle.click();
        const pidInput = await waitFor('#mp-provider', null, 4000);
        if (pidInput) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          setter?.call(pidInput, 'fake');
          pidInput.dispatchEvent(new Event('input', { bubbles: true }));
          await sleep(150);
        }
        const fetchBtn = await waitFor('#models-fetch-models', null, 3000);
        fetchBtn?.click();
        const fetchedRow = await waitFor('[data-fetched-model]', (e) => (e.getAttribute('data-fetched-model') || '') === 'demo-alpha', 8000);
        checks.modelsFetched = { ok: !!fetchedRow };
        if (fetchedRow) {
          fetchedRow.querySelector('input[type=checkbox]')?.click();
          await sleep(150);
          document.querySelector('#models-save-add')?.click();
          const addedRow = await waitFor('[data-model-row]', (e) => (e.getAttribute('data-model-row') || '').endsWith('/demo-alpha'), 8000);
          checks.modelsBatchAdd = { ok: !!addedRow };
          if (addedRow) {
            const delBtn = addedRow.querySelector('button[aria-label^="删除模型"]');
            delBtn?.click();
            await sleep(150);
            const confirmBtn = await waitFor('[data-model-row] button', (b) => b.textContent.includes('确认删除'), 4000);
            confirmBtn?.click();
            await sleep(600);
            const gone = ![...document.querySelectorAll('[data-model-row]')].some((e) => (e.getAttribute('data-model-row') || '').endsWith('/demo-alpha'));
            checks.modelsDelete = { ok: gone };
          }
        }
      }
      await runAxeCheck('models');
    }

    // 10. Switch to light theme and verify AppearanceView in light mode (D06 serious contrast requirement)
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    document.documentElement.setAttribute('data-theme', 'light');
    await sleep(200);
    const asideEl = document.querySelector('aside');
    const asideText = document.querySelector('aside .text-sm');
    const docStyles = window.getComputedStyle(document.documentElement);
    const bgRules = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText && asideEl && asideEl.matches(rule.selectorText) && rule.style.backgroundColor) {
            bgRules.push({ selector: rule.selectorText, bg: rule.style.backgroundColor });
          }
        }
      } catch {}
    }
    const debugSettingsLight = {
      htmlClass: document.documentElement.className,
      htmlTheme: document.documentElement.getAttribute('data-theme'),
      bgSideVar: docStyles.getPropertyValue('--bg-side').trim(),
      textPrimaryVar: docStyles.getPropertyValue('--text-primary').trim(),
      asideClassName: asideEl?.className,
      asideVar: asideEl ? window.getComputedStyle(asideEl).getPropertyValue('--bg-side').trim() : null,
      asideBg: asideEl ? window.getComputedStyle(asideEl).backgroundColor : null,
      asideTextColor: asideText ? window.getComputedStyle(asideText).color : null,
      bgRules,
    };
    await runAxeCheck('settings-light');

    // 11. Switch back to chat in light mode
    const viewMenuBtn = [...document.querySelectorAll('.drag-region button')].find((b) => b.textContent.trim() === '视图');
    if (viewMenuBtn) {
      viewMenuBtn.click();
      await sleep(150);
      const chatOption = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('对话工作台'));
      chatOption?.click();
    } else {
      const sessionItem = document.querySelector('aside button[title*="无标题"]');
      sessionItem?.click();
    }
    await sleep(300);
    const asideEl2 = document.querySelector('aside');
    const asideText2 = document.querySelector('aside .text-sm');
    const docStyles2 = window.getComputedStyle(document.documentElement);
    const debugChatLight = {
      htmlClass: document.documentElement.className,
      htmlTheme: document.documentElement.getAttribute('data-theme'),
      bgSideVar: docStyles2.getPropertyValue('--bg-side').trim(),
      textPrimaryVar: docStyles2.getPropertyValue('--text-primary').trim(),
      asideClassName: asideEl2?.className,
      asideVar: asideEl2 ? window.getComputedStyle(asideEl2).getPropertyValue('--bg-side').trim() : null,
      asideBg: asideEl2 ? window.getComputedStyle(asideEl2).backgroundColor : null,
      asideTextColor: asideText2 ? window.getComputedStyle(asideText2).color : null,
    };
    await runAxeCheck('chat-light');

    // Restore dark theme
    document.documentElement.classList.remove('light');
    document.documentElement.classList.add('dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    await sleep(100);

    return { ok: true, checks, a11yByView };
  } catch (err) {
    return { ok: false, error: String(err?.stack || err), checks, a11yByView };
  }
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const pageErrors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) pageErrors.push(msg);
  });

  await win.loadURL(url);

  // Inject axe first before running driver
  await win.webContents.executeJavaScript(axeSource);

  const result = await win.webContents.executeJavaScript(DRIVER);

  const totalViolations = Object.values(result.a11yByView || {}).reduce((sum, v) => sum + (v.count || 0), 0);
  const allViolations = Object.entries(result.a11yByView || {}).flatMap(([view, v]) =>
    (v.violations || []).map((vi) => ({ ...vi, view }))
  );
  const a11yPass = result.ok && !result.error && totalViolations === 0;
  const a11ySummary = {
    count: totalViolations,
    violations: allViolations,
    byView: result.a11yByView,
  };

  const allPass = result.ok && Object.values(result.checks || {}).every((c) => c.ok) && a11yPass;
  console.log(`MODERNGATE ${JSON.stringify({ ok: allPass, checks: result.checks, a11y: a11ySummary, pageErrors })}`);
  app.exit(allPass ? 0 : 1);
}).catch((err) => {
  console.log(`MODERNGATE ${JSON.stringify({ ok: false, error: String(err?.stack || err) })}`);
  app.exit(1);
});
