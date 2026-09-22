/**
 * PendingAsks — the operator-in-the-loop surface behind policy 'ask' rules.
 * Every unresolved path must resolve to a refusal; nothing may stay suspended.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingAsks } from '../src/core/asks.js';

const desc = (over = {}) => ({ toolName: 'bash', toolCallId: 'tc-1', rule: 'risk_destructive', summary: 'command: rm -rf x', ...over });

test('operator answers resolve the suspended ask; events fire on raise and resolve', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const events = [];
  asks.subscribe((e) => events.push(e));

  const p = asks.ask(desc());
  assert.equal(asks.list().length, 1);
  const askId = asks.list()[0].id;
  assert.equal(events[0].type, 'governance_ask');
  assert.equal(events[0].ask.toolName, 'bash');
  assert.equal(events[0].ask.summary, 'command: rm -rf x');

  const r = asks.resolve(askId, 'allow');
  assert.equal(r.ok, true);
  assert.equal(await p, 'allow');
  assert.equal(asks.list().length, 0);
  assert.equal(events[1].type, 'governance_resolved');
  assert.equal(events[1].answer, 'allow');
});

test('allow_session auto-allows later asks for the same tool; resetSession clears', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const p1 = asks.ask(desc());
  asks.resolve(asks.list()[0].id, 'allow_session');
  assert.equal(await p1, 'allow_session');

  // no new pending record — straight through
  assert.equal(await asks.ask(desc({ toolCallId: 'tc-2' })), 'allow');
  assert.equal(asks.list().length, 0);

  asks.resetSession();
  const p2 = asks.ask(desc({ toolCallId: 'tc-3' }));
  assert.equal(asks.list().length, 1);
  asks.resolve(asks.list()[0].id, 'deny');
  assert.equal(await p2, 'deny');
});

test('unanswered asks expire to a refusal (timeout = deny upstream)', async () => {
  const asks = new PendingAsks({ timeoutMs: 30 });
  const answer = await asks.ask(desc());
  assert.equal(answer, 'timeout');
  assert.equal(asks.list().length, 0);
});

test('abort signal resolves pending asks as aborted', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const ac = new AbortController();
  const p = asks.ask(desc(), ac.signal);
  ac.abort();
  assert.equal(await p, 'aborted');
});

test('an already-aborted call resolves immediately, including a session-allowed tool', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const events = [];
  asks.subscribe((event) => events.push(event));
  const ac = new AbortController();
  ac.abort();
  assert.equal(await asks.ask(desc(), ac.signal), 'aborted');
  assert.deepEqual(asks.list(), []);
  assert.deepEqual(events, []);

  const allowed = asks.ask(desc());
  asks.resolve(asks.list()[0].id, 'allow_session');
  assert.equal(await allowed, 'allow_session');
  assert.equal(await asks.ask(desc(), ac.signal), 'aborted');
  assert.deepEqual(asks.list(), []);
  asks.dispose();
});

test('resolve validates: unknown id and bad answers fail politely', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const p = asks.ask(desc());
  const id = asks.list()[0].id;
  assert.equal(asks.resolve('ask-nope', 'allow').ok, false);
  assert.equal(asks.resolve(id, 'maybe').ok, false);
  asks.resolve(id, 'deny');
  await p;
  // double resolve is a polite error, not a crash
  assert.equal(asks.resolve(id, 'allow').ok, false);
});

test('dispose refuses everything still suspended', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const p1 = asks.ask(desc({ toolCallId: 'a' }));
  const p2 = asks.ask(desc({ toolCallId: 'b' }));
  asks.dispose();
  assert.equal(await p1, 'aborted');
  assert.equal(await p2, 'aborted');
});

test('truncation metadata survives into the governance_ask event (B1 WYSIWYG chain)', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const events = [];
  asks.subscribe((e) => events.push(e));
  const p = asks.ask(desc({ args: { command: 'x'.repeat(100) }, argsTruncated: true, argsTotalChars: 99999 }));
  const ev = events.find((e) => e.type === 'governance_ask');
  assert.equal(ev.ask.argsTruncated, true);
  assert.equal(ev.ask.argsTotalChars, 99999);
  // also visible on the pending list — reconnecting UIs render the same warning
  assert.equal(asks.list()[0].argsTruncated, true);
  asks.resolve(ev.ask.id, 'deny');
  await p;
});

test('question kind resolves with arbitrary operator text; empty answers rejected', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const events = [];
  asks.subscribe((e) => events.push(e));
  const p = asks.ask(desc({
    kind: 'question',
    toolName: 'ask_user',
    summary: 'which database?',
    options: [{ label: 'sqlite', description: 'local file' }, { label: 'postgres' }],
  }));
  const ev = events.find((e) => e.type === 'governance_ask');
  assert.equal(ev.ask.kind, 'question');
  assert.equal(ev.ask.options.length, 2);
  assert.equal(ev.ask.options[0].description, 'local file');
  // option label is a valid answer; so is arbitrary text
  assert.equal(asks.resolve(ev.ask.id, '').ok, false);
  assert.equal(asks.resolve(ev.ask.id, '  ').ok, false);
  assert.equal(asks.resolve(ev.ask.id, 'postgres').ok, true);
  assert.equal(await p, 'postgres');
});

test('questions bypass sessionAllows and never record it', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  // approve the tool for the session, then ask a question under the same name
  const p1 = asks.ask(desc({ toolName: 'ask_user' }));
  asks.resolve(asks.list()[0].id, 'allow_session');
  assert.equal(await p1, 'allow_session');
  assert.deepEqual(asks.sessionAllows(), ['ask_user']);
  // a question under the same tool name must still suspend for the operator
  const p2 = asks.ask(desc({ kind: 'question', toolName: 'ask_user', summary: 'q?' }));
  assert.equal(asks.list().length, 1);
  asks.resolve(asks.list()[0].id, 'free text');
  assert.equal(await p2, 'free text');
  // and answering a question must not create an allow_session grant
  assert.deepEqual(asks.sessionAllows(), ['ask_user']);
});

test('abortPending refuses open asks but keeps listeners (session rebuild)', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const events = [];
  asks.subscribe((e) => events.push(e));
  const p = asks.ask(desc({ kind: 'question', toolName: 'ask_user' }));
  asks.abortPending();
  assert.equal(await p, 'aborted');
  // listeners survive — a new ask still emits
  const p2 = asks.ask(desc());
  assert.equal(events.filter((e) => e.type === 'governance_ask').length, 2);
  asks.resolve(asks.list()[0].id, 'deny');
  await p2;
});

test("'always' persists {tool,command} to alwaysPath and auto-allows across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-always-'));
  const path = join(dir, 'always-allow.json');
  const asks = new PendingAsks({ timeoutMs: 5000 }, path);
  const p = asks.ask(desc({ args: { command: 'git status' } }));
  asks.resolve(asks.list()[0].id, 'always');
  assert.equal(await p, 'always');
  // exact command auto-allows; different command still asks
  assert.equal(await asks.ask(desc({ args: { command: 'git status' } })), 'allow');
  const p2 = asks.ask(desc({ toolCallId: 'tc-3', args: { command: 'git push' } }));
  assert.equal(asks.list().length, 1);
  asks.resolve(asks.list()[0].id, 'deny');
  await p2;
  // restart: persisted entries survive
  const asks2 = new PendingAsks({ timeoutMs: 5000 }, path);
  assert.equal(await asks2.ask(desc({ args: { command: 'git status' } })), 'allow');
});

test("'always' on a path-arg tool scopes the grant to THAT path — never tool-wide", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-always-'));
  const path = join(dir, 'always-allow.json');
  const asks = new PendingAsks({ timeoutMs: 5000 }, path);
  const p = asks.ask(desc({ toolName: 'write', args: { path: 'notes/a.txt' } }));
  asks.resolve(asks.list()[0].id, 'always');
  assert.equal(await p, 'always');
  // same path auto-allows…
  assert.equal(await asks.ask(desc({ toolName: 'write', args: { path: 'notes/a.txt' } })), 'allow');
  // …a different path still asks (the grant must not cover every write)
  const p2 = asks.ask(desc({ toolName: 'write', toolCallId: 'tc-b', args: { path: 'src/critical.js' } }));
  assert.equal(asks.list().length, 1, 'different path must still open a card');
  asks.resolve(asks.list()[0].id, 'deny');
  await p2;
  // the persisted entry carries the path scope across restart
  const persisted = JSON.parse(readFileSync(path, 'utf-8'));
  assert.deepEqual(persisted, [{ tool: 'write', path: 'notes/a.txt' }]);
  const asks2 = new PendingAsks({ timeoutMs: 5000 }, path);
  assert.equal(await asks2.ask(desc({ toolName: 'write', args: { path: 'notes/a.txt' } })), 'allow');
  const p3 = asks2.ask(desc({ toolName: 'write', toolCallId: 'tc-c', args: { path: 'etc.txt' } }));
  assert.equal(asks2.list().length, 1);
  asks2.resolve(asks2.list()[0].id, 'deny');
  await p3;
});

test("legacy tool-wide entries (no command, no path) still match any args; persist is atomic (no tmp debris)", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-always-'));
  const path = join(dir, 'always-allow.json');
  mkdirSync(dir, { recursive: true });
  // legacy shape from before path-scoping existed
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, JSON.stringify([{ tool: 'browser_navigate' }]));
  const asks = new PendingAsks({ timeoutMs: 5000 }, path);
  assert.equal(await asks.ask(desc({ toolName: 'browser_navigate', args: { url: 'https://x.test' } })), 'allow');
  // adding another grant leaves no tmp debris
  const p = asks.ask(desc({ toolName: 'bash', args: { command: 'ls' } }));
  asks.resolve(asks.list()[0].id, 'always');
  await p;
  assert.ok(!readdirSync(dir).some((f) => f.includes('.tmp-')), 'no tmp debris');
});

test("'always' refused on truncated payload; deny cascades same tool:arg for the session", async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const p = asks.ask(desc({ args: { command: 'x' }, argsTruncated: true }));
  const r = asks.resolve(asks.list()[0].id, 'always');
  assert.equal(r.ok, false);
  assert.match(r.error, /truncated/);
  asks.resolve(asks.list()[0].id, 'allow');

  // deny cascade: deny once → same tool:command refused without re-asking
  const d1 = asks.ask(desc({ args: { command: 'rm -rf build' } }));
  asks.resolve(asks.list()[0].id, 'deny');
  assert.equal(await d1, 'deny');
  assert.equal(await asks.ask(desc({ toolCallId: 'tc-9', args: { command: 'rm -rf build' } })), 'deny');
  assert.equal(asks.list().length, 0); // never even opened a card
  // different args still get their own card
  const d2 = asks.ask(desc({ toolCallId: 'tc-10', args: { command: 'rm -rf other' } }));
  assert.equal(asks.list().length, 1);
  asks.resolve(asks.list()[0].id, 'deny');
  await d2;
});

test('ASK_RESOLVED audit row lands per resolution (stats outcome trail)', async () => {
  const { AuditWriter } = await import('../src/core/audit.js');
  const dir = mkdtempSync(join(tmpdir(), 'pai-askres-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const asks = new PendingAsks({ audit, timeoutMs: 50 });
  const p = asks.ask({ toolName: 'bash', args: { command: 'ls' } });
  const pend = asks.list()[0];
  asks.resolve(pend.id, 'deny');
  const ans = await p;
  assert.equal(ans, 'deny');
  const rows = readFileSync(readdirSync(join(dir, 'audit')).map((f) => join(dir, 'audit', f))[0], 'utf-8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const r = rows.find((e) => e.kind === 'ASK_RESOLVED');
  assert.equal(r.toolName, 'bash');
  assert.equal(r.data.answer, 'deny');
  assert.equal(r.data.kind, 'approval');
});

test('edited approval: object answer carries edited args, deny cannot edit', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const p = asks.ask({ toolName: 'bash', args: { command: 'rm -rf a' } });
  const pend = asks.list()[0];
  // deny + edit is meaningless → refused
  const bad = asks.resolve(pend.id, { answer: 'deny', edited: { command: 'rm -rf b' } });
  assert.equal(bad.ok, false);
  // editing a key not present in the card args → refused (no arg injection)
  const bad2 = asks.resolve(pend.id, { answer: 'allow', edited: { url: 'x' } });
  assert.equal(bad2.ok, false);
  // allow + edited command → resolves the object
  const ok = asks.resolve(pend.id, { answer: 'allow', edited: { command: 'rm -rf a' } });
  assert.equal(ok.ok, true);
  const ans = await p;
  assert.deepEqual(ans, { answer: 'allow', edited: { command: 'rm -rf a' } });
});

test('edited approval refused on truncated payloads', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  const p = asks.ask({ toolName: 'bash', args: { command: 'x'.repeat(50) }, argsTruncated: true });
  const pend = asks.list()[0];
  const r = asks.resolve(pend.id, { answer: 'allow', edited: { command: 'ls' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /truncated/);
  // still pending — resolve normally so the ask doesn't linger
  asks.resolve(pend.id, 'deny');
  await p;
});

test('grantSession: operator-issued session grant unblocks later asks (request_permission)', async () => {
  const asks = new PendingAsks({ timeoutMs: 5000 });
  asks.grantSession('bash');
  assert.deepEqual(asks.sessionAllows(), ['bash']);
  // granted tool passes without a card; ungranted still suspends
  assert.equal(await asks.ask({ toolName: 'bash', args: { command: 'ls' } }), 'allow');
  const p = asks.ask(desc({ toolName: 'write_file' }));
  assert.equal(asks.list().length, 1);
  asks.resolve(asks.list()[0].id, 'deny');
  await p;
  // grant does not survive a session rebuild
  asks.resetSession();
  const p2 = asks.ask({ toolName: 'bash', args: { command: 'ls' } });
  assert.equal(asks.list().length, 1);
  asks.resolve(asks.list()[0].id, 'deny');
  await p2;
});
