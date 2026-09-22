/**
 * M112 inbound webhooks — operator-declared endpoints at
 * <instance>/webhooks.json turn authenticated POSTs into governed prompts.
 * Default-deny: no config = no listener; every request carries the shared
 * secret; the fired prompt faces the normal decide chain (provenance only).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WebhookReceiver } from '../src/adapter/webhook.js';

const post = (port, path, { secret, body } = {}) => new Promise((resolve, reject) => {
  const headers = {};
  if (secret !== undefined) headers.Authorization = `Bearer ${secret}`;
  const data = body === undefined ? '' : String(body);
  if (data) headers['Content-Length'] = Buffer.byteLength(data);
  import('node:http').then(({ request }) => {
    const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    r.end(data);
  }).catch(reject);
});

const rig = (dir, cfg, sink) => {
  const configPath = join(dir, 'webhooks.json');
  if (cfg !== null) writeFileSync(configPath, JSON.stringify(cfg));
  const fired = [];
  const rcv = new WebhookReceiver({
    configPath,
    promptSink: sink ?? (async (msg, meta) => { fired.push({ msg, meta }); return { ok: true }; }),
    audit: { write() {} },
  });
  return { rcv, fired };
};

test('no config file → listener never starts (default-deny inbound)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wh-none-'));
  try {
    const { rcv } = rig(dir, null);
    const r = await rcv.listen();
    assert.equal(r.disabled, true);
    assert.equal(rcv.status().listening, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('enabled config → authenticated POST fires the governed sink', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wh-'));
  const { rcv, fired } = rig(dir, {
    enabled: true, port: 0,
    endpoints: [{ id: 'ci', secret: 's3cret', prompt: 'CI finished' }],
  });
  try {
    const { port: okPort } = await rcv.listen();

    // wrong secret refused + audited
    const bad = await post(okPort, '/hook/ci', { secret: 'nope' });
    assert.equal(bad.status, 403);
    // missing secret refused
    const none = await post(okPort, '/hook/ci', {});
    assert.equal(none.status, 403);
    // unknown endpoint refused
    const unk = await post(okPort, '/hook/nope', { secret: 's3cret' });
    assert.equal(unk.status, 404);
    // bad JSON refused
    const badJson = await post(okPort, '/hook/ci', { secret: 's3cret', body: 'not json' });
    assert.equal(badJson.status, 400);

    // good POST fires the sink with provenance meta
    const good = await post(okPort, '/hook/ci', { secret: 's3cret', body: '{"build":42}' });
    assert.equal(good.status, 200);
    assert.equal(fired.length, 1);
    assert.match(fired[0].msg, /\[webhook:ci\] CI finished/);
    assert.match(fired[0].msg, /"build":42/);
    assert.equal(fired[0].meta.webhook, 'ci');
  } finally { await rcv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('secretSha256 config never stores the raw token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wh-sha-'));
  const { rcv, fired } = rig(dir, {
    enabled: true, port: 0,
    endpoints: [{ id: 'gh', secretSha256: createHash('sha256').update('tok123').digest('hex'), prompt: 'push' }],
  });
  try {
    const { port } = await rcv.listen();
    assert.equal((await post(port, '/hook/gh', { secret: 'wrong' })).status, 403);
    assert.equal((await post(port, '/hook/gh', { secret: 'tok123' })).status, 200);
    assert.equal(fired.length, 1);
  } finally { await rcv.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('rate cap + busy sink are honest refusals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-wh-cap-'));
  const { rcv, fired } = rig(dir, {
    enabled: true, port: 0,
    endpoints: [{ id: 'e', secret: 's', prompt: 'x', max_per_hour: 2 }],
  });
  try {
    const { port } = await rcv.listen();
    assert.equal((await post(port, '/hook/e', { secret: 's' })).status, 200);
    assert.equal((await post(port, '/hook/e', { secret: 's' })).status, 200);
    assert.equal((await post(port, '/hook/e', { secret: 's' })).status, 429);
    assert.equal(fired.length, 2);
    await rcv.close();

    // busy session → 202 honest refusal, not a silent drop
    const { rcv: rcv2 } = rig(dir, {
      enabled: true, port: 0,
      endpoints: [{ id: 'e', secret: 's', prompt: 'x' }],
    }, async () => ({ refused: 'busy' }));
    const { port: p2 } = await rcv2.listen();
    const r = await post(p2, '/hook/e', { secret: 's' });
    assert.equal(r.status, 202);
    assert.match(r.body, /busy/);
    await rcv2.close();
  } finally { await rcv.close(); rmSync(dir, { recursive: true, force: true }); }
});
