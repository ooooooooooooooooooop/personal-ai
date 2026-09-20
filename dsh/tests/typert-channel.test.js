/**
 * D1 DSH channel — Typert client + channel host against a fake wire server.
 * No real dsh needed: the server speaks the /api contract (unary POST,
 * respond, and a hand-rolled downlink-only WebSocket for events.mux).
 */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTypertClient } from '../adapter/typert.js';
import { createDshChannel } from '../adapter/channel.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Write one unmasked server→client text frame. */
function wsSend(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

/**
 * Fake DSH web server: unary methods + /api/respond + mux WS.
 * @returns {Promise<{server, port, calls, responds, push, muxOpen}>}
 */
async function fakeDsh(handlers = {}) {
  const calls = [];
  const responds = [];
  let muxSocket = null;
  let muxOpenResolve;
  const muxOpen = new Promise((r) => { muxOpenResolve = r; });

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/api/')) {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const msg = JSON.parse(body);
        if (req.url === '/api/respond') {
          responds.push(msg);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ accepted: true }));
          return;
        }
        const method = req.url.slice('/api/'.length);
        calls.push({ method, payload: msg.payload, rpcId: msg.rpcId });
        const handler = handlers[method] ?? (() => ({}));
        const value = handler(msg.payload);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ type: 'server-response', rpcId: msg.rpcId, result: { ok: true, value } }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/api/events.mux') { socket.destroy(); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on('data', (buf) => {
      // answer close frames so client ws.close() completes its handshake
      if (buf[0] === 0x88) socket.end();
    });
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    muxSocket = socket;
    muxOpenResolve();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const push = (payload) => {
    wsSend(muxSocket, { type: 'server-request', rpcId: randomUUID(), method: 'events.mux', payload });
  };
  const pushWithId = (rpcId, payload) => {
    wsSend(muxSocket, { type: 'server-request', rpcId, method: 'events.mux', payload });
  };
  const close = async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  };
  return { server, port, calls, responds, push, pushWithId, muxOpen, close };
}

const base = (port) => `http://127.0.0.1:${port}`;

test('typert client: unary call unwraps server-response, respond posts client-response', async () => {
  const { server, port, calls, responds , close } = await fakeDsh({
    'host.describe': () => ({ version: '0.1.1-rc.2' }),
  });
  try {
    const c = createTypertClient({ baseUrl: base(port) });
    const v = await c.call('host.describe', {});
    assert.equal(v.version, '0.1.1-rc.2');
    assert.equal(calls[0].method, 'host.describe');
    const r = await c.respond('rpc-x', { outcome: 'allowed-once' });
    assert.equal(r.accepted, true);
    assert.equal(responds[0].rpcId, 'rpc-x');
    assert.equal(responds[0].result.ok, true);
  } finally {
    await close();
  }
});

test('dsh channel: prompt forwards as session.prompt queue mode; cancel on abort', async () => {
  const { server, port, calls , close } = await fakeDsh({
    'session.create': () => ({ sessionId: 's-1' }),
    'session.prompt': () => ({ accepted: true }),
    'session.cancel': () => ({ accepted: true }),
  });
  try {
    const client = createTypertClient({ baseUrl: base(port) });
    const { channel, dispose } = createDshChannel({ client, sessionId: 's-1', cwd: '/tmp' });
    const r = await channel.handle({ id: '1', type: 'prompt', message: 'hello' });
    assert.equal(r.success, true);
    assert.equal(calls.at(-1).method, 'session.prompt');
    assert.equal(calls.at(-1).payload.mode, 'queue');
    assert.deepEqual(calls.at(-1).payload.content, [{ type: 'text', text: 'hello' }]);
    await channel.handle({ id: '2', type: 'abort' });
    assert.equal(calls.at(-1).method, 'session.cancel');
    dispose();
  } finally {
    await close();
  }
});

test('dsh channel: mux session events translate to host UI events', async () => {
  const { server, port, push, muxOpen , close } = await fakeDsh();
  try {
    const client = createTypertClient({ baseUrl: base(port) });
    const auditEvents = [];
    const { channel, dispose } = createDshChannel({
      client, sessionId: 's-1', cwd: '/tmp',
      audit: { write: (e) => auditEvents.push(e) },
    });
    const events = [];
    channel.subscribe((m) => events.push(m));
    await muxOpen;

    push({ type: 'session/event', sessionId: 's-1', event: { type: 'turn/start', data: { turn: 1 } } });
    push({ type: 'session/event', sessionId: 's-1', event: { type: 'assistant/chunk', data: { chunk: { type: 'block-start', index: 0, blockType: 'text' } } } });
    push({ type: 'session/event', sessionId: 's-1', event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: 'Hello' } } } });
    push({ type: 'session/event', sessionId: 's-1', event: { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: ' world' } } } });
    push({ type: 'session/event', sessionId: 's-1', event: { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] }, usage: { input: 1, output: 2 } } } });
    push({ type: 'session/event', sessionId: 's-1', event: { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } } });
    push({ type: 'session/event', sessionId: 's-1', event: { type: 'tool/result', data: { message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'out' }] }] } } } });
    push({ type: 'session/event', sessionId: 's-1', event: { type: 'turn/end', data: { turn: 1, reason: 'done' } } });
    // foreign session frames must not leak into our transcript
    push({ type: 'session/event', sessionId: 'other-session', event: { type: 'turn/start', data: { turn: 9 } } });

    await new Promise((r) => setTimeout(r, 100));
    const types = events.map((m) => m.event?.type);
    assert.deepEqual(types, [
      'agent_start', 'message_start', 'message_update', 'message_update',
      'message_end', 'tool_execution_start', 'tool_execution_end', 'agent_end',
    ]);
    assert.equal(events[4].event.message.usage.input, 1);
    assert.equal(events[5].event.toolName, 'bash');
    assert.deepEqual(events[5].event.args, { command: 'ls' });
    assert.equal(events[6].event.toolCallId, 'c1');
    assert.equal(events[6].event.isError, false);
    // D3: the canonical audit trail carries the DSH tool lifecycle
    assert.deepEqual(auditEvents.map((e) => e.kind), ['DSH_TOOL_CALL', 'DSH_TOOL_RESULT']);
    assert.equal(auditEvents[0].toolName, 'bash');
    assert.equal(auditEvents[1].data.isError, false);
    dispose();
  } finally {
    await close();
  }
});

test('dsh channel: approval/requested surfaces a governance ask; decision_resolve answers via /api/respond', async () => {
  const { server, port, pushWithId, muxOpen, responds , close } = await fakeDsh();
  try {
    const client = createTypertClient({ baseUrl: base(port) });
    const { channel, dispose } = createDshChannel({ client, sessionId: 's-1', cwd: '/tmp' });
    const events = [];
    channel.subscribe((m) => events.push(m));
    await muxOpen;

    const frameRpc = 'rpc-approval-1';
    pushWithId(frameRpc, {
      type: 'approval/requested', sessionId: 's-1',
      approvalId: 'appr-1', toolName: 'bash', reason: 'wants rm -rf',
    });
    await new Promise((r) => setTimeout(r, 50));
    const ask = events.find((m) => m.event?.type === 'governance_ask')?.event?.ask;
    assert.ok(ask, 'governance_ask emitted');
    assert.equal(ask.toolName, 'bash');

    const r = await channel.handle({ id: '9', type: 'decision_resolve', askId: ask.id, answer: 'allow' });
    assert.equal(r.success, true);
    await new Promise((r2) => setTimeout(r2, 50));
    assert.equal(responds.length, 1);
    assert.equal(responds[0].rpcId, frameRpc);
    assert.equal(responds[0].result.value.outcome, 'allowed-once');
    assert.equal(responds[0].result.value.approvalId, 'appr-1');
    dispose();
  } finally {
    await close();
  }
});

test('dsh channel: session.list maps to plain rows; history folds events', async () => {
  const { server, port , close } = await fakeDsh({
    'session.list': () => ({ sessions: [{ sessionId: 's-1', title: 'demo', lastPromptAt: '2026-01-01' }] }),
    'session.history': () => ({
      events: [
        { event: { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } } },
        { event: { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } } } },
        { event: { type: 'step/start', data: { turn: 1, step: 1 } } },
      ],
      hasMore: false,
    }),
  });
  try {
    const client = createTypertClient({ baseUrl: base(port) });
    const { channel, dispose } = createDshChannel({ client, sessionId: 's-1', cwd: '/tmp' });
    const list = await channel.handle({ id: '1', type: 'session_list' });
    assert.equal(list.success, true);
    assert.equal(list.data[0].id, 's-1');
    assert.equal(list.data[0].title, 'demo');
    const hist = await channel.handle({ id: '2', type: 'session_history' });
    assert.equal(hist.success, true);
    assert.deepEqual(hist.data.map((r) => r.role), ['user', 'assistant']);
    assert.equal(hist.data[1].text, 'yo');
    dispose();
  } finally {
    await close();
  }
});
