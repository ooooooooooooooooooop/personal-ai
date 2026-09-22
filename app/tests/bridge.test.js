/**
 * HTTP bridge: POST /cmd round-trips to the supervisor handle(), /events
 * streams pushed records as SSE, static UI serves.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpBridge } from '../server/http-bridge.js';

function stubSupervisor(instanceRoot = null) {
  const listeners = new Set();
  return {
    instanceRoot,
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    push(m) { for (const l of listeners) l(m); },
    async handle(cmd) {
      if (cmd.type === 'boom') throw new Error('kaboom');
      return { id: cmd.id, type: 'response', command: cmd.type, success: true, data: { echo: cmd.type } };
    },
  };
}

test('bridge: /cmd round-trip, /events SSE, static index', async () => {
  const sup = stubSupervisor();
  const bridge = createHttpBridge({ supervisor: sup });
  const port = await bridge.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${base}/cmd`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x1', type: 'get_state' }),
    });
    const out = await r.json();
    assert.equal(out.success, true);
    assert.equal(out.data.echo, 'get_state');
    assert.equal(out.id, 'x1');

    const err = await fetch(`${base}/cmd`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'x2', type: 'boom' }),
    });
    const out2 = await err.json();
    assert.equal(out2.success, false);

    // SSE: a pushed record arrives as a data: frame
    const es = await fetch(`${base}/events`);
    const reader = es.body.getReader();
    const decoder = new TextDecoder();
    sup.push({ type: 'supervisor', event: { kind: 'ping' } });
    let buf = '';
    for (let i = 0; i < 5 && !buf.includes('"ping"'); i++) {
      buf += decoder.decode((await reader.read()).value ?? new Uint8Array());
    }
    assert.match(buf, /"ping"/);
    reader.cancel();

    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /Personal AI/);
    const nf = await fetch(`${base}/../secret`);
    assert.equal(nf.status === 404 || nf.status === 400, true);
  } finally {
    await bridge.close();
  }
});

test('bridge: /api/artifacts lists exports; /api/artifact confined to it', async () => {
  const inst = mkdtempSync(join(tmpdir(), 'pai-inst-'));
  mkdirSync(join(inst, 'exports', 'shots'), { recursive: true });
  writeFileSync(join(inst, 'exports', 'shots', 's.png'), 'PNGDATA');
  writeFileSync(join(inst, 'exports', 'debug.json'), '{}');
  const outside = join(inst, 'secret.txt');
  writeFileSync(outside, 'nope');
  const bridge = createHttpBridge({ supervisor: stubSupervisor(inst) });
  const port = await bridge.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const list = await (await fetch(`${base}/api/artifacts`)).json();
    const names = list.artifacts.map((a) => a.path.split(/[\\/]/).pop()).sort();
    assert.deepEqual(names, ['debug.json', 's.png']);
    assert.ok(list.artifacts.every((a) => typeof a.bytes === 'number' && a.mtime));
    // inside → 200 with bytes; outside / traversal / missing → 404
    const ok = await fetch(`${base}/api/artifact?path=${encodeURIComponent(join(inst, 'exports', 'debug.json'))}`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '{}');
    for (const p of [outside, join(inst, 'exports', '..', 'secret.txt'), join(inst, 'exports', 'missing.txt')]) {
      const r = await fetch(`${base}/api/artifact?path=${encodeURIComponent(p)}`);
      assert.equal(r.status, 404, p);
    }
  } finally {
    await bridge.close();
  }
});

test('M9: cross-origin POST /cmd refused; same-origin and non-browser pass', async () => {
  const sup = stubSupervisor();
  const bridge = createHttpBridge({ supervisor: sup });
  const port = await bridge.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const post = (headers) => fetch(`${base}/cmd`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ id: 'x', type: 'get_state' }),
  });
  try {
    // evil web page origin — refused before the body is read
    const evil = await post({ Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    // browser fetch metadata marking cross-site — refused even without Origin
    const sfs = await post({ 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(sfs.status, 403);
    // same-site is allowed (e.g. another local tool on the same host)
    const same = await post({ 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(same.status, 200);
    // loopback Origin (the real UI) — allowed
    const local = await post({ Origin: `http://127.0.0.1:${port}` });
    assert.equal(local.status, 200);
    // curl-style non-browser POST with no origin headers — allowed
    const bare = await post({});
    assert.equal(bare.status, 200);
  } finally { await bridge.close(); }
});

// G5 (DNS-rebinding): the Origin/SFS checks only run on POST, but a rebound
// hostname makes a hostile page same-origin with this listener — GET /events
// would stream live session telemetry to it. Every request is now gated on
// the Host header: only literal loopback authorities may talk to the bridge.
test('non-loopback Host header refused on every endpoint (DNS rebinding)', async () => {
  const { request } = await import('node:http');
  const sup = stubSupervisor();
  const bridge = createHttpBridge({ supervisor: sup });
  const port = await bridge.listen(0);
  const req = (path, host, method = 'GET') => new Promise((resolve, reject) => {
    const headers = { Host: host, Connection: 'close' };
    if (method === 'POST') headers['Content-Length'] = 2;
    const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    r.end(method === 'POST' ? '{}' : undefined);
  });
  try {
    // a rebound hostname reaching us — refused on SSE, state, static, POST
    for (const [path, method] of [['/events', 'GET'], ['/api/state', 'GET'], ['/', 'GET'], ['/cmd', 'POST']]) {
      const status = await req(path, 'rebound.attacker.example', method);
      assert.equal(status, 403, `${method} ${path} with foreign Host must refuse`);
    }
    // literal loopback Hosts pass — the real UI and local tooling
    assert.equal(await req('/api/state', `127.0.0.1:${port}`), 200);
    assert.equal(await req('/api/state', `localhost:${port}`), 200);
  } finally { await bridge.close(); }
});
