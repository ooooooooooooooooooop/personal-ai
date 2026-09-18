/**
 * Typert — minimal zero-dependency client for the DSH web profile's /api
 * wire protocol (see @deepseek-ai/dsh-client-connection).
 *
 * Wire contract (four-quadrant RPC):
 *   client → host unary:   POST /api/<method>  {type:'client-request', rpcId, method, payload}
 *                          → {type:'server-response', rpcId, result:{ok,value}|{ok:false,error}}
 *   host → client streams: GET /api/events.mux + /api/events.host (WebSocket
 *                          upgrade; server sends {type:'server-request',
 *                          rpcId, method, payload} text frames — client sends
 *                          nothing on the socket)
 *   client answers:        POST /api/respond   {type:'client-response', rpcId, result}
 *                          → RpcReceipt (echoes the answerable frame's rpcId)
 *
 * The /api trust fence accepts loopback authorities — we always bind and
 * dial 127.0.0.1, so no Origin/Host games are needed.
 */
import { randomUUID } from 'node:crypto';

export class TypertError extends Error {
  constructor(method, error) {
    super(error?.message ?? `${method} failed`);
    this.code = error?.code ?? 'internal';
    this.details = error?.details;
  }
}

export function createTypertClient({ baseUrl }) {
  const api = `${baseUrl}/api`;

  async function call(method, payload = {}) {
    const res = await fetch(`${api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload }),
    });
    const msg = await res.json().catch(() => null);
    if (msg?.type !== 'server-response' || !msg.result?.ok) {
      throw new TypertError(method, msg?.result?.error ?? { message: `HTTP ${res.status}` });
    }
    return msg.result.value;
  }

  async function respond(rpcId, value) {
    const res = await fetch(`${api}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value } }),
    });
    const receipt = await res.json().catch(() => null);
    return receipt ?? { accepted: false, reason: 'bad-response' };
  }

  /**
   * Open a downlink-only WebSocket stream (/api/events.mux | /api/events.host).
   * Calls onFrame(serverRequest) per frame; onOpen/onClose for lifecycle.
   * Reconnect policy belongs to the caller — this is one physical socket.
   * @returns {{close: () => void}}
   */
  function openStream(path, { onFrame, onOpen, onClose } = {}) {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}${path}`);
    ws.onopen = () => onOpen?.();
    ws.onmessage = (m) => {
      let frame = null;
      try { frame = JSON.parse(m.data); } catch { /* non-JSON frame: ignore */ }
      if (frame?.type === 'server-request') onFrame?.(frame);
    };
    ws.onclose = (e) => onClose?.(e);
    ws.onerror = () => { /* onclose follows with the terminal state */ };
    return { close: () => { try { ws.close(); } catch { /* already closed */ } } };
  }

  return { call, respond, openStream, baseUrl };
}
