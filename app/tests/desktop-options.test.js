import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveStartupOptions } from '../desktop/options.js';

test('desktop-options: defaults to classic uiMode and standard paths', () => {
  const tempUser = mkdtempSync(join(tmpdir(), 'pai-opt-user-'));
  const tempInst = mkdtempSync(join(tmpdir(), 'pai-opt-inst-empty-'));
  try {
    const opts = resolveStartupOptions({
      argv: ['node', 'desktop/main.js', '--instance', tempInst],
      env: {},
      userDataPath: tempUser,
      defaultWorkdir: '/default/docs',
    });
    assert.equal(opts.uiMode, 'classic');
    assert.equal(opts.instanceRoot, tempInst);
    assert.equal(opts.workdir, '/default/docs');
  } finally {
    rmSync(tempUser, { recursive: true, force: true });
    rmSync(tempInst, { recursive: true, force: true });
  }
});

test('desktop-options: parses --ui modern and --modern flags', () => {
  const tempInst = mkdtempSync(join(tmpdir(), 'pai-opt-inst-empty-'));
  try {
    const opts1 = resolveStartupOptions({
      argv: ['electron.exe', '.', '--instance', tempInst, '--ui', 'modern'],
      env: {},
    });
    assert.equal(opts1.uiMode, 'modern');

    const opts2 = resolveStartupOptions({
      argv: ['electron.exe', '.', '--instance', tempInst, '--modern'],
      env: {},
    });
    assert.equal(opts2.uiMode, 'modern');
  } finally {
    rmSync(tempInst, { recursive: true, force: true });
  }
});

test('desktop-options: respects PAI_UI environment variable', () => {
  const tempInst = mkdtempSync(join(tmpdir(), 'pai-opt-inst-empty-'));
  try {
    const opts = resolveStartupOptions({
      argv: ['electron.exe', '.', '--instance', tempInst],
      env: { PAI_UI: 'modern' },
    });
    assert.equal(opts.uiMode, 'modern');
  } finally {
    rmSync(tempInst, { recursive: true, force: true });
  }
});

test('desktop-options: loads ui and workdir from instance app-config.json', () => {
  const instDir = mkdtempSync(join(tmpdir(), 'pai-opt-inst-'));
  try {
    writeFileSync(
      join(instDir, 'app-config.json'),
      JSON.stringify({ ui: 'modern', workdir: '/from/config' })
    );

    const opts = resolveStartupOptions({
      argv: ['electron.exe', '.', '--instance', instDir],
      env: {},
    });
    assert.equal(opts.uiMode, 'modern');
    assert.equal(opts.instanceRoot, instDir);
    assert.equal(opts.workdir, '/from/config');
  } finally {
    rmSync(instDir, { recursive: true, force: true });
  }
});

test('desktop-options: CLI flags override app-config.json and env', () => {
  const instDir = mkdtempSync(join(tmpdir(), 'pai-opt-inst2-'));
  try {
    writeFileSync(
      join(instDir, 'app-config.json'),
      JSON.stringify({ ui: 'modern', workdir: '/from/config' })
    );

    const opts = resolveStartupOptions({
      argv: ['electron.exe', '.', '--instance', instDir, '--ui', 'classic', '--workdir', '/override/work'],
      env: { PAI_UI: 'modern', PAI_WORKDIR: '/env/work' },
    });
    assert.equal(opts.uiMode, 'classic');
    assert.equal(opts.workdir, '/override/work');
  } finally {
    rmSync(instDir, { recursive: true, force: true });
  }
});

test('desktop-options: env variables override app-config.json', () => {
  const instDir = mkdtempSync(join(tmpdir(), 'pai-opt-inst3-'));
  try {
    writeFileSync(
      join(instDir, 'app-config.json'),
      JSON.stringify({ ui: 'classic', workdir: '/from/config' })
    );

    const opts = resolveStartupOptions({
      argv: ['electron.exe', '.', '--instance', instDir],
      env: { PAI_UI: 'modern', PAI_WORKDIR: '/from/env' },
    });
    assert.equal(opts.uiMode, 'modern');
    assert.equal(opts.workdir, '/from/env');
  } finally {
    rmSync(instDir, { recursive: true, force: true });
  }
});
