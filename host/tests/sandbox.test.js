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

test('ssh backend: target required + spec shape — b64 transport, batch mode, remote dir', () => {
  const p = new SandboxProvider('ssh', { target: 'alice@example.com:2222', dir: '/srv/work', key: '/k/id' });
  const spec = p.spawnSpec('rm -rf /tmp/x && echo done', 'C:\w');
  if (!spec) return; // ssh binary absent — probe fails closed instead
  assert.equal(spec.file, 'ssh');
  assert.equal(spec.shell, false);
  assert.ok(spec.args.includes('BatchMode=yes'));
  assert.ok(spec.args.includes('-p') && spec.args.includes('2222'));
  assert.ok(spec.args.includes('-i') && spec.args.includes('/k/id'));
  assert.equal(spec.args.at(-5), 'alice@example.com');
  // command crosses as base64 inside the remote script — never re-parsed
  const remote = spec.args.at(-1);
  assert.match(remote, /cd \/srv\/work && printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d \| bash/);
  const b64 = remote.match(/'([A-Za-z0-9+/=]+)'/)[1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf-8'), 'rm -rf /tmp/x && echo done');
  assert.equal(spec.remote, true);
});

test('ssh backend refuses bad/missing targets before any process', () => {
  assert.throws(() => new SandboxProvider('ssh', {}).spawnSpec('x', '.'), SandboxUnavailableError);
  assert.throws(() => new SandboxProvider('ssh', { target: 'no-at-sign' }).spawnSpec('x', '.'), SandboxUnavailableError);
});

test('docker backend: spec mounts workdir at /work, names the container', () => {
  const p = new SandboxProvider('docker', { image: 'alpine:3' });
  try {
    const spec = p.spawnSpec('echo hi', 'C:\w');
    assert.equal(spec.file, 'docker');
    assert.equal(spec.shell, false);
    assert.match(spec.containerName, /^pai-job-[0-9a-f]{12}$/);
    assert.deepEqual(spec.args.slice(0, 4), ['run', '--rm', '--name', spec.containerName]);
    assert.ok(spec.args.includes('-v') && spec.args.includes('C:\w:/work'));
    assert.ok(spec.args.includes('-w') && spec.args.includes('/work'));
    assert.equal(spec.args.at(-4), 'alpine:3');
  } catch (e) {
    // no docker on this host — fail-closed is the correct observable too
    assert.equal(e.code, 'SANDBOX_UNAVAILABLE');
  }
});

test('fromEnv: docker/ssh options wire through', () => {
  const d = SandboxProvider.fromEnv({ PAI_SANDBOX: 'docker', PAI_SANDBOX_IMAGE: 'alpine:3' });
  assert.equal(d.kind, 'docker');
  assert.equal(d.image, 'alpine:3');
  const s = SandboxProvider.fromEnv({ PAI_SANDBOX: 'ssh', PAI_SANDBOX_SSH_TARGET: 'u@h:22', PAI_SANDBOX_SSH_DIR: '/w', PAI_SANDBOX_SSH_KEY: '/k' });
  assert.equal(s.target, 'u@h:22');
  assert.equal(s.dir, '/w');
});
