/**
 * D07.5 falsifier driver — runs INSIDE Electron, loads the built React UI off
 * the real http-bridge + supervisor, drives ONE defect scenario through the
 * real DOM, and prints a single `FALSIFY {json}` line for the node:test parent.
 *
 * Why a separate driver instead of more checks in modern-gate.js: v4 §7 D07.5
 * demands that each of these defects "fails the gate on recurrence". A check
 * buried in a 40-check gate tells you the gate went red, not WHICH guard was
 * deleted. One scenario per process = one named failing test per defect.
 *
 * env: DOM_GATE_URL, FALSIFY=<scenario name>
 */
import { app, BrowserWindow } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
// Fresh profile per run so a zombie offscreen process cannot wedge the next one.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'pai-falsify-profile-')));

const WATCHDOG_MS = 90_000;
const watchdog = setTimeout(() => {
  console.log(`FALSIFY ${JSON.stringify({ ok: false, error: 'falsifier watchdog timeout' })}`);
  app.exit(3);
}, WATCHDOG_MS);
watchdog.unref?.();

const url = process.env.DOM_GATE_URL;
const SCENARIO = process.env.FALSIFY ?? '';
if (!url || !SCENARIO) {
  console.log(`FALSIFY ${JSON.stringify({ ok: false, error: 'missing DOM_GATE_URL or FALSIFY' })}`);
  app.exit(2);
}

/* Page-side prelude. Kept as a plain string (no backticks, no ${}) because a
 * stray template delimiter here kills the Electron main at parse time. */
const PRELUDE = [
  'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
  'const waitFor = async (sel, fn, ms = 15000) => {',
  '  const t0 = Date.now();',
  '  while (Date.now() - t0 < ms) {',
  '    const hit = [...document.querySelectorAll(sel)].find((e) => !fn || fn(e));',
  '    if (hit) return hit;',
  '    await sleep(100);',
  '  }',
  '  return null;',
  '};',
  'const byText = (sel, text) => [...document.querySelectorAll(sel)].find((e) => ((e.textContent || "").includes(text)));',
  'const setVal = (el, v) => {',
  '  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;',
  '  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;',
  '  if (setter) setter.call(el, v); else el.value = v;',
  '  el.dispatchEvent(new Event("input", { bubbles: true }));',
  '};',
  'const bodyText = () => document.body.innerText || "";',
  // The composer reloads its draft (and drops attachments) whenever
  // activeSessionId changes. Typing before that lands is a race, not a bug —
  // every scenario that touches the composer waits for the app to settle FIRST.
  'const settle = async (ms = 900) => {',
  '  await waitFor("#sidebar-health", (e) => !((e.textContent || "").includes("正在检查")), 25000);',
  '  await sleep(ms);',
  '};',
  'const checks = {};',
].join('\n');

/* One body per scenario. Each ends by assigning checks.<name>; no early
 * return (the body is concatenated into a single async function). */
const SCENARIOS = {
  /* V401 — a session_history answer that arrives after the operator already
   * switched must be DISCARDED, not painted over the newer session. */
  lateHistory: [
    'await settle(300);',
    'const rowB = await waitFor("aside button", (b) => ((b.textContent || "").includes("resume-target")), 25000);',
    'const rowA1 = byText("aside button", "DOM验收");',
    'if (rowB && rowA1) {',
    '  rowB.click();',
    '  await sleep(450);',
    '  const rowA2 = byText("aside button", "DOM验收");',
    '  if (rowA2) rowA2.click();',
    '  await sleep(3200);',
    '  const t = bodyText();',
    '  checks.lateHistory = {',
    '    ok: t.includes("hist:s1.jsonl") && !t.includes("hist:s2.jsonl"),',
    '    keptNewer: t.includes("hist:s1.jsonl"),',
    '    lateOverwrote: t.includes("hist:s2.jsonl"),',
    '    tail: t.slice(-260),',
    '  };',
    '} else {',
    '  checks.lateHistory = { ok: false, why: "session rows not clickable", rows: [...document.querySelectorAll("aside button")].map((b) => (b.textContent || "").slice(0, 24)).slice(0, 24) };',
    '}',
  ].join('\n'),

  /* V404 — a REFUSED stop must leave the run running and say why. Faking a
   * stop hands the operator a lie about who still owns the turn. */
  stopRefused: [
    'await settle();',
    'const ta = await waitFor("textarea", null, 25000);',
    'const sendBtn = await waitFor("button[title*=\\"发送指令\\"]", null, 8000);',
    'if (ta && sendBtn) {',
    '  setVal(ta, "长跑任务 falsifier");',
    '  sendBtn.click();',
    '  const stopBtn = await waitFor("button[aria-label=\\"立即停止执行\\"]", null, 12000);',
    '  if (stopBtn) stopBtn.click();',
    '  await sleep(1500);',
    '  const t = bodyText();',
    '  const stillRunning = !!document.querySelector("button[aria-label=\\"立即停止执行\\"]");',
    '  checks.stopRefused = {',
    '    ok: !!stopBtn && stillRunning && t.includes("停止失败"),',
    '    sawStopButton: !!stopBtn,',
    '    stillRunning,',
    '    saidFailure: t.includes("停止失败"),',
    '    notices: t.split("\\n").filter((l) => l.includes("停止")).slice(0, 6),',
    '  };',
    '} else {',
    '  checks.stopRefused = { ok: false, why: "composer not actionable", ta: !!ta, sendBtn: !!sendBtn };',
    '}',
  ].join('\n'),

  /* V406 — an attachment must reach the body WITH its bytes. The body refuses
   * a sourceless attachment, so a payload that lost `data` cannot echo. */
  attachmentData: [
    'await settle();',
    'const ta = await waitFor("textarea", null, 25000);',
    'const fileInput = await waitFor("#pai-file-attachment-input", null, 8000);',
    'if (ta && fileInput) {',
    '  const bytes = new Uint8Array([104, 105, 10]);',
    '  const dt = new DataTransfer();',
    '  dt.items.add(new File([bytes], "note.txt", { type: "text/plain" }));',
    '  fileInput.files = dt.files;',
    '  fileInput.dispatchEvent(new Event("change", { bubbles: true }));',
    '  const chip = await waitFor("button[aria-label^=\\"移除附件\\"]", null, 10000);',
    '  setVal(ta, "看这个附件 falsifier");',
    '  const sendBtn = await waitFor("button[title*=\\"发送指令\\"]", null, 8000);',
    '  if (sendBtn) sendBtn.click();',
    '  const echo = await (async () => {',
    '    const t0 = Date.now();',
    '    while (Date.now() - t0 < 15000) {',
    '      if (bodyText().includes("echo:看这个附件 falsifier")) return true;',
    '      await sleep(150);',
    '    }',
    '    return false;',
    '  })();',
    '  const t = bodyText();',
    '  checks.attachmentData = {',
    '    ok: !!chip && echo && !t.includes("未获取到文件内容"),',
    '    chipped: !!chip,',
    '    echoed: echo,',
    '    refusedLocally: t.includes("未获取到文件内容"),',
    '  };',
    '} else {',
    '  checks.attachmentData = { ok: false, why: "composer/file input missing", ta: !!ta, fileInput: !!fileInput };',
    '}',
  ].join('\n'),

  /* V407 — a probe that answered NOTHING must read as unknown, never as ok. */
  unknownHealth: [
    'const line = await waitFor("#sidebar-health", (e) => !((e.textContent || "").includes("正在检查")), 25000);',
    'if (line) line.click();',
    'const backupRow = await waitFor("[data-health-item=\\"backup\\"]", null, 15000);',
    'await sleep(400);',
    'const row = (id) => document.querySelector("[data-health-item=\\"" + id + "\\"]")?.textContent || "";',
    'const backup = row("backup");',
    'const checksRow = row("checks");',
    'checks.unknownHealth = {',
    '  ok: !!backupRow',
    '    && backup.includes("尚未检查")',
    '    && checksRow.includes("尚未检查")',
    '    && !backup.includes("备份正常")',
    '    && !checksRow.includes("自检正常"),',
    '  backup,',
    '  checksRow,',
    '  verdict: document.querySelector("#health-verdict")?.textContent || "",',
    '};',
  ].join('\n'),

  /* V409 — switching to light must actually repaint: tokens AND rendered bg.
   * Comparing tokens alone would pass on a rule that never applies. */
  themeLight: [
    'const lum = (css) => {',
    '  const m = String(css || "").match(/(\\d+)\\D+(\\d+)\\D+(\\d+)/);',
    '  if (!m) return null;',
    '  const v = [Number(m[1]), Number(m[2]), Number(m[3])].map((n) => n / 255);',
    '  return Math.round((0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) * 1000) / 1000;',
    '};',
    'const token = () => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();',
    'const paint = () => getComputedStyle(document.body).backgroundColor;',
    'await waitFor("aside nav button", null, 25000);',
    'const darkToken = token();',
    'const darkPaint = paint();',
    'const appearanceNav = byText("aside nav button", "外观");',
    'if (appearanceNav) appearanceNav.click();',
    'const lightBtn = await waitFor("button", (b) => ((b.textContent || "").includes("浅色模式")), 10000);',
    'if (lightBtn) lightBtn.click();',
    'await sleep(500);',
    'const lightToken = token();',
    'const lightPaint = paint();',
    'checks.themeLight = {',
    '  ok: !!lightBtn',
    '    && darkToken !== lightToken',
    '    && darkPaint !== lightPaint',
    '    && lum(lightPaint) > 0.75',
    '    && lum(darkPaint) < 0.25,',
    '  lightBtn: !!lightBtn,',
    '  darkToken, lightToken, darkPaint, lightPaint,',
    '  lumDark: lum(darkPaint), lumLight: lum(lightPaint),',
    '  themeAttr: document.documentElement.getAttribute("data-theme"),',
    '};',
  ].join('\n'),

  /* V410 — picking a suggestion FILLS the composer; it must not dispatch. */
  suggestionNoAutosend: [
    'await settle();',
    'const ta = await waitFor("textarea", null, 25000);',
    'const card = await waitFor("button", (b) => ((b.textContent || "").includes("帮我梳理一个问题")), 12000);',
    'if (card && ta) {',
    '  card.click();',
    '  await sleep(1200);',
    '  const t = bodyText();',
    '  checks.suggestionNoAutosend = {',
    '    ok: ta.value.includes("请帮我梳理当前代码库") && t.includes("今天有什么可以帮你的"),',
    '    filled: ta.value.includes("请帮我梳理当前代码库"),',
    '    valueHead: ta.value.slice(0, 40),',
    '    stillEmpty: t.includes("今天有什么可以帮你的"),',
    '  };',
    '} else {',
    '  checks.suggestionNoAutosend = { ok: false, why: "empty-state suggestion not found", card: !!card, ta: !!ta };',
    '}',
  ].join('\n'),
};

const body = SCENARIOS[SCENARIO];
const DRIVER = body
  ? `(async () => {
${PRELUDE}
try {
${body}
  return { ok: Object.values(checks).every((c) => c.ok), checks, pageErrors: window.__errs ?? [] };
} catch (e) {
  return { ok: false, error: String(e?.stack ?? e), checks, pageErrors: window.__errs ?? [] };
}
})()`
  : null;

app.whenReady().then(async () => {
  if (!DRIVER) {
    console.log(`FALSIFY ${JSON.stringify({ ok: false, error: `unknown scenario '${SCENARIO}'` })}`);
    app.exit(2);
    return;
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL(url);
    await win.webContents.executeJavaScript(
      'window.__errs=[];window.addEventListener("error",(e)=>__errs.push(String(e.error?.stack??e.message)));window.addEventListener("unhandledrejection",(e)=>__errs.push("rej:"+String(e.reason?.stack??e.reason)));1',
    );
    const result = await win.webContents.executeJavaScript(DRIVER);
    result.scenario = SCENARIO;
    console.log(`FALSIFY ${JSON.stringify(result)}`);
    app.exit(result?.ok ? 0 : 1);
  } catch (err) {
    console.log(`FALSIFY ${JSON.stringify({ ok: false, scenario: SCENARIO, error: String(err?.stack || err) })}`);
    app.exit(2);
  }
});
