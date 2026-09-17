/**
 * HTTP bridge: POST /cmd round-trips to the supervisor handle(), /events
 * streams pushed records as SSE, static UI serves.
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpBridge } from '../server/http-bridge.js';

function stubSupervisor() {
  const listeners = new Set();
  return {
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
