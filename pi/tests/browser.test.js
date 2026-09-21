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
import { browserTools } from '../src/adapter/browser.js';

const NAMES = ['browser_navigate', 'browser_read', 'browser_click', 'browser_type', 'browser_eval', 'browser_screenshot'];

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
