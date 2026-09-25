/**
 * browser_* tools (D2) — registration contract + blocklist semantics.
 * No real browser is spawned in tests: launch is lazy and only happens
 * inside execute(); registration/host-surface behavior is what's governed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { browserTools, BrowserSession } from '../src/adapter/browser.js';

const NAMES = ['browser_navigate', 'browser_read', 'browser_click', 'browser_type', 'browser_eval', 'browser_screenshot'];
// Fake hosts (ok.example, evil.test) never resolve — tests inject an
// always-pass resolver and exercise the REAL DNS boundary separately.
const passResolve = async () => ({ ok: true });

test('no browser binary → no tools registered (unconfigured = not advertised)', () => {
  const tools = browserTools({
    instanceRoot: mkdtempSync(join(tmpdir(), 'pai-br-')),
    env: { PAI_BROWSER_EXE: '', PROGRAMFILES: '/nonexistent', 'PROGRAMFILES(X86)': '/nonexistent', LOCALAPPDATA: '/nonexistent' },
  });
  assert.equal(tools.length, 0);
});

test('browser binary present → six tools registered, dispose attached', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-br-'));
  const fake = join(dir, 'fake-browser.exe');
  writeFileSync(fake, 'x');
  const tools = browserTools({
    instanceRoot: dir,
    env: { PAI_BROWSER_EXE: fake, PROGRAMFILES: '/nonexistent', 'PROGRAMFILES(X86)': '/nonexistent', LOCALAPPDATA: '/nonexistent' },
  });
  assert.deepEqual(tools.map((t) => t.name).sort(), NAMES.slice().sort());
  assert.equal(typeof tools.dispose, 'function');
  tools.dispose(); // no launch happened — teardown is a no-op
});

test('blocklist refuses navigation to blocked hosts before any launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-br-'));
  const fake = join(dir, 'fake-browser.exe');
  writeFileSync(fake, 'x');
  const tools = browserTools({
    instanceRoot: dir,
    env: {
      PAI_BROWSER_EXE: fake, PAI_BROWSER_BLOCKED: 'bank.example,evil.test',
      PROGRAMFILES: '/nonexistent', 'PROGRAMFILES(X86)': '/nonexistent', LOCALAPPDATA: '/nonexistent',
    },
  });
  const nav = tools.find((t) => t.name === 'browser_navigate');
  const r = await nav.execute('c1', { url: 'https://sub.bank.example/login' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /blocklist|blocked/i);
  // non-http protocol refused at the same boundary
  const r2 = await nav.execute('c2', { url: 'file:///etc/passwd' });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /http\/https/);
  tools.dispose();
});

test('redirect onto a blocked host is refused AFTER landing — the page is backed out to about:blank', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-br-'));
  const audits = [];
  const s = new BrowserSession({
    exe: 'fake', profileDir: join(dir, 'prof'),
    audit: { write: (e) => audits.push(e) }, blockedHosts: ['evil.test'],
    resolveHost: passResolve,
  });
  // stub the live-session state — no real browser launch
  const navigations = [];
  s.proc = { killed: false };
  s.sessionId = 'sid';
  s.cdp = {
    waitEvent: () => Promise.resolve({}),
    call: async (method, params) => {
      if (method === 'Page.navigate') { navigations.push(params.url); return {}; }
      if (method === 'Runtime.evaluate') {
        // the requested URL passed pre-flight; the redirect chain landed on evil.test
        if (params.expression === 'location.hostname') return { result: { value: 'evil.test' } };
        return { result: { value: null } };
      }
      return {};
    },
  };
  await assert.rejects(() => s.navigate('https://ok.example/'), /blocklist/);
  assert.ok(navigations.includes('about:blank'), 'blocked landing page backed out');
  assert.ok(audits.some((e) => e.kind === 'BROWSER_NAVIGATE_REFUSED' && e.data.landed_host === 'evil.test'));
  assert.ok(!audits.some((e) => e.kind === 'BROWSER_NAVIGATE'), 'a refused landing is not audited as a successful navigation');
});

// G4: click-driven navigation bypassed the blocklist — the pre-click check
// saw the SOURCE page; a link click could land the frame on a blocked host.
// The click now re-checks the landed host (same contract as navigate) and
// backs out to about:blank.
test('click that navigates onto a blocked host is refused and backed out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-br-'));
  const audits = [];
  const s = new BrowserSession({
    exe: 'fake', profileDir: join(dir, 'prof'),
    audit: { write: (e) => audits.push(e) }, blockedHosts: ['evil.test'],
    resolveHost: passResolve,
  });
  const navigations = [];
  let host = 'ok.example';
  s.proc = { killed: false };
  s.sessionId = 'sid';
  s.cdp = {
    waitEvent: () => Promise.resolve({}),
    call: async (method, params) => {
      if (method === 'Page.navigate') { navigations.push(params.url); return {}; }
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'location.hostname') return { result: { value: host } };
        if (params.expression.includes('el.click')) { host = 'evil.test'; return { result: { value: 'A link' } }; }
        return { result: { value: null } };
      }
      return {};
    },
  };
  await assert.rejects(() => s.click('a'), /blocklist/);
  assert.ok(navigations.includes('about:blank'), 'click landing on a blocked host backs out');
  assert.ok(audits.some((e) => e.kind === 'BROWSER_CLICK_REFUSED' && e.data.landed_host === 'evil.test'));
  assert.ok(!audits.some((e) => e.kind === 'BROWSER_CLICK'), 'a refused click is not audited as successful');
});

test('read/screenshot refuse while the page sits on a blocked host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-br-'));
  const s = new BrowserSession({
    exe: 'fake', profileDir: join(dir, 'prof'), blockedHosts: ['evil.test'],
    resolveHost: passResolve,
  });
  s.proc = { killed: false };
  s.sessionId = 'sid';
  s.cdp = {
    call: async (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression === 'location.hostname') {
        return { result: { value: 'evil.test' } };
      }
      return { result: { value: 'page text' } };
    },
    waitEvent: () => Promise.resolve({}),
  };
  await assert.rejects(() => s.read(), /blocklist/);
  await assert.rejects(() => s.screenshot(join(dir, 's.png')), /blocklist/);
});

// M63/M66 parity: the browser was the SSRF bypass around web_fetch — the
// metadata endpoint (a link-local LITERAL, no DNS needed) must be refused
// pre-flight, before any browser launch.
test('navigate to the link-local metadata address is refused at the DNS boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-br-'));
  const audits = [];
  const s = new BrowserSession({
    exe: 'fake', profileDir: join(dir, 'prof'),
    audit: { write: (e) => audits.push(e) },
    // real resolver — a literal IP needs no DNS and works offline
  });
  await assert.rejects(() => s.navigate('http://169.254.169.254/latest/meta-data'), /DNS boundary|forbidden/);
  assert.ok(audits.some((e) => e.kind === 'BROWSER_NAVIGATE_REFUSED'));
  assert.ok(!s.proc, 'refused pre-flight — no browser launched');
});

test('a public name resolving to a private address is refused (DNS pivot)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-br-'));
  const s = new BrowserSession({
    exe: 'fake', profileDir: join(dir, 'prof'),
    resolveHost: async () => ({ ok: false, reason: `'evil-corp.com' resolves to private/loopback address 10.1.2.3` }),
  });
  await assert.rejects(() => s.navigate('https://evil-corp.com/'), /DNS boundary/);
  assert.ok(!s.proc, 'refused pre-flight — no browser launched');
});

test('localhost names stay navigable (local dev baseline)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-br-'));
  const s = new BrowserSession({
    exe: 'fake', profileDir: join(dir, 'prof'),
    resolveHost: passResolve,
  });
  s.proc = { killed: false };
  s.sessionId = 'sid';
  s.cdp = {
    waitEvent: () => Promise.resolve({}),
    call: async (method, params) => {
      if (method === 'Page.navigate') return {};
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'location.hostname') return { result: { value: 'localhost' } };
        if (params.expression.startsWith('JSON.stringify')) return { result: { value: '{"url":"http://localhost:3000/","title":"dev"}' } };
        return { result: { value: null } };
      }
      return {};
    },
  };
  const r = await s.navigate('http://localhost:3000/');
  assert.equal(r.title, 'dev');
});

// #2160: browser_type secretRef — brokered credential fill: the resolved
// secret reaches the page (session.type) but never the tool result.
test('browser_type secretRef types the resolved secret; result/audit never carry it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-br-'));
  const fake = join(dir, 'fake-browser.exe');
  writeFileSync(fake, 'x');
  const audits = [];
  const tools = browserTools({
    instanceRoot: dir,
    audit: { write: (e) => audits.push(e) },
    env: { PAI_BROWSER_EXE: fake, PROGRAMFILES: '/nonexistent', 'PROGRAMFILES(X86)': '/nonexistent', LOCALAPPDATA: '/nonexistent' },
    secretResolver: (ref) => ({ ok: true, value: 'S3CR3T-value', scheme: 'op', item: 'vault/login' }),
  });
  const typed = [];
  const origType = BrowserSession.prototype.type;
  BrowserSession.prototype.type = async function (sel, text) { typed.push([sel, text]); return true; };
  try {
    const type = tools.find((t) => t.name === 'browser_type');
    const r = await type.execute('c1', { selector: '#pw', secretRef: 'op://vault/login/password' });
    assert.deepEqual(typed, [['#pw', 'S3CR3T-value']], 'resolved secret went into the page');
    assert.equal(r.isError, undefined);
    assert.doesNotMatch(r.content[0].text, /S3CR3T/, 'result text never carries the plaintext');
    assert.ok(audits.some((e) => e.kind === 'BROWSER_SECRET_FILL' && e.data.ok === true));
    assert.ok(!JSON.stringify(audits).includes('S3CR3T'), 'audit never carries the plaintext');
    // both text and secretRef → refused honestly
    const r2 = await type.execute('c2', { selector: '#pw', text: 'x', secretRef: 'op://v/i/f' });
    assert.equal(r2.isError, true);
    // neither → refused
    const r3 = await type.execute('c3', { selector: '#pw' });
    assert.equal(r3.isError, true);
    // resolver failure → fail-closed error, nothing typed
    const tools2 = browserTools({
      instanceRoot: dir,
      audit: { write: (e) => audits.push(e) },
      env: { PAI_BROWSER_EXE: fake, PROGRAMFILES: '/nonexistent', 'PROGRAMFILES(X86)': '/nonexistent', LOCALAPPDATA: '/nonexistent' },
      secretResolver: () => ({ ok: false, reason: 'source not enabled' }),
    });
    const t2 = tools2.find((t) => t.name === 'browser_type');
    const r4 = await t2.execute('c4', { selector: '#pw', secretRef: 'op://v/i/f' });
    assert.equal(r4.isError, true);
    assert.match(r4.content[0].text, /refused|not enabled/);
    assert.equal(typed.length, 1, 'failed resolution typed nothing');
    assert.ok(audits.some((e) => e.kind === 'BROWSER_SECRET_FILL' && e.data.ok === false));
    tools2.dispose();
  } finally {
    BrowserSession.prototype.type = origType;
    tools.dispose();
  }
});
