/**
 * SessionEnv unit tests — overlay set/unset/list/view semantics plus the
 * dedup-h #697 setSecret channel: a credential stored through the masked
 * prompt is masked on EVERY read surface regardless of the key name, while
 * view() still carries the real value for spawn-time merge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionEnv, ENV_INJECT_RE, KEY_RE } from '../src/core/sessionenv.js';

test('setSecret: unconditionally masked in list; view keeps the real value; unset drops the flag', () => {
  const env = new SessionEnv({});
  const r = env.setSecret('MY_SERVICE', 'sk-live-9');
  assert.equal(r.ok, true);
  assert.equal(env.view().MY_SERVICE, 'sk-live-9');
  const row = env.list().find((x) => x.key === 'MY_SERVICE');
  assert.equal(row.value, '[REDACTED]', 'benign key name must still mask a setSecret value');
  assert.equal(row.sensitive, true);

  // a normal set under the same name keeps the flag — the secrecy of the
  // stored value does not downgrade because a later call overwrote it
  env.set('MY_SERVICE', 'other');
  assert.equal(env.list().find((x) => x.key === 'MY_SERVICE').value, '[REDACTED]');

  env.unset('MY_SERVICE');
  assert.equal(env.view().MY_SERVICE, undefined);
  env.set('MY_SERVICE', 'plain');
  assert.equal(env.list().find((x) => x.key === 'MY_SERVICE').value, 'plain', 'unset clears the secret flag');
});

test('setSecret: refuses injection vectors and malformed keys — no value stored', () => {
  const env = new SessionEnv({});
  for (const bad of ['PATH', 'NODE_OPTIONS', 'GIT_SSH_COMMAND', 'not a key', '']) {
    const r = env.setSecret(bad, 'v');
    assert.equal(r.ok, false, bad || '(empty)');
    assert.equal(env.view()[bad], undefined);
  }
  assert.ok(ENV_INJECT_RE.test('LD_PRELOAD'));
  assert.ok(KEY_RE.test('A_KEY_1') && !KEY_RE.test('1KEY'));
});

test('clear: secret flags go with the values', () => {
  const env = new SessionEnv({});
  env.setSecret('TOK', 'x');
  env.set('PLAIN', 'y');
  env.clear();
  assert.equal(env.view().TOK, undefined);
  env.set('TOK', 'z');
  assert.equal(env.list().find((r) => r.key === 'TOK').value, 'z', 'post-clear set is not secret-flagged');
});

test('#2547: JVM build-tool flags + glibc tunables refused as injection vectors', () => {
  const env = new SessionEnv({});
  for (const bad of [
    'MAVEN_OPTS', 'SBT_OPTS', 'GRADLE_OPTS', 'ANT_OPTS',
    'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
    'GLIBC_TUNABLES', 'GCONV_PATH',
    'DOTNET_STARTUP_HOOKS', 'DOTNET_ADDITIONAL_DEPS',
    'SHELLOPTS', 'IFS', 'PS1',
  ]) {
    const r = env.set(bad, '-javaagent:/tmp/x.jar');
    assert.equal(r.ok, false, bad);
    assert.equal(env.view()[bad], undefined);
  }
  assert.equal(env.set('MY_BUILD_FLAG', 'release').ok, true, 'ordinary keys still set');
});
