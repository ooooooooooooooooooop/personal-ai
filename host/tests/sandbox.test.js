import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxProvider, SandboxUnavailableError } from '../src/core/sandbox.js';

test('sandbox none: passthrough preserves shell semantics', () => {
  const p = new SandboxProvider('none');
  const spec = p.spawnSpec('echo hi', 'C:\\work');
  assert.deepEqual(spec, { file: 'echo hi', args: [], shell: true, cwd: 'C:\\work' });
});

test('sandbox wsl: argv spec — user command is one argv element, never cmd-quoted', () => {
  const p = new SandboxProvider('wsl', { distro: 'Ubuntu' });
  if (process.platform !== 'win32') {
    assert.throws(() => p.spawnSpec('ls', '/tmp'), SandboxUnavailableError);
    return;
  }
  const spec = p.spawnSpec('ls && rm -rf x', 'C:\\work');
  assert.equal(spec.shell, false);
  assert.equal(spec.file, 'wsl.exe');
  assert.deepEqual(spec.args.slice(0, 2), ['-d', 'Ubuntu']);
  assert.deepEqual(spec.args.at(-2), ['-lc'].at(-1)); // placeholder guard
  assert.equal(spec.args.at(-1), 'ls && rm -rf x');
  assert.ok(spec.args.includes('--cd'));
  assert.ok(spec.args.includes('bash'));
});

test('sandbox wsl default distro omits -d', () => {
  const p = new SandboxProvider('wsl');
  if (process.platform !== 'win32') return;
  const spec = p.spawnSpec('ls', 'C:\\w');
  assert.ok(!spec.args.includes('-d'));
});

test('sandbox unknown backend fails closed', () => {
  const p = new SandboxProvider('gvisor');
  assert.throws(() => p.spawnSpec('ls', '.'), SandboxUnavailableError);
});

test('fromEnv: PAI_SANDBOX selects backend, unset defaults none', () => {
  assert.equal(SandboxProvider.fromEnv({}).kind, 'none');
  assert.equal(SandboxProvider.fromEnv({ PAI_SANDBOX: 'wsl', PAI_SANDBOX_DISTRO: 'Debian' }).kind, 'wsl');
  assert.equal(SandboxProvider.fromEnv({ PAI_SANDBOX: 'wsl', PAI_SANDBOX_DISTRO: 'Debian' }).distro, 'Debian');
});
