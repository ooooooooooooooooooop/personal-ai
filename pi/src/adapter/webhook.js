/**
 * M112 inbound webhooks (TaskFlow/external-event wake analogue): an
 * operator-configured HTTP listener that turns authenticated POSTs into
 * governed session prompts.
 *
 * Default-deny by construction:
 *  - No <instance>/webhooks.json (or enabled:false) → the listener never
 *    starts; there is no inbound surface at all.
 *  - Config lives at the INSTANCE ROOT (operator-private like gate
 *    hooks.json) — a workdir-controlled file must never arm an inbound
 *    listener the operator did not declare.
 *  - Every request must carry the endpoint's shared secret
 *    (`Authorization: Bearer <secret>` or `x-pai-secret`), compared with
 *    timingSafeEqual; unknown endpoint / bad secret / wrong method are
 *    refused and audited. No request ever carries authority — the fired
 *    prompt travels the normal channel prompt path where every tool call
 *    still faces the decide chain (CommandAuthorized posture: the webhook
 *    only marks provenance via meta.webhook, it does not grant).
 *
 * Hardening over the naive endpoint:
 *  - binds literal loopback only unless the operator explicitly sets bind;
 *  - 32KB body cap, JSON payloads only;
 *  - per-endpoint sliding-window rate ceiling (default 30/hr, hard cap 240)
 *    so a leaked secret mints noise, not unlimited model turns;
 *  - secrets may be stored as `secretSha256` so the raw token never sits in
 *    the config file.
 */
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const BODY_CAP = 32 * 1024;
const WINDOW_MS = 3_600_000;
const DEFAULT_MAX_PER_HOUR = 30;
const HARD_CEILING = 240;
const PAYLOAD_CAP = 4000;

const eq = (a, b) => {
  const ba = Buffer.from(String(a ?? '')), bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

export class WebhookReceiver {
  /**
   * @param {(msg:string, meta:object)=>Promise<{ok?:boolean,refused?:string}>} promptSink
   * @param {string} opts.configPath  <instance>/webhooks.json
   */
  constructor({ promptSink, audit = null, configPath, now = () => Date.now() }) {
    this.promptSink = promptSink;
    this.audit = audit;
    this.configPath = configPath;
    this.now = now;
    this.server = null;
    this.endpoints = new Map(); // id → {id, secret?, secretSha256?, prompt, maxPerHour, firedAt[]}
    this.configError = null;
  }

  #load() {
    this.endpoints.clear();
    this.configError = null;
    if (!this.configPath || !existsSync(this.configPath)) return { enabled: false };
    let doc;
    try { doc = JSON.parse(readFileSync(this.configPath, 'utf-8')); }
    catch (e) { this.configError = `webhooks.json unreadable: ${e.message}`; return { enabled: false }; }
    if (doc?.enabled !== true) return { enabled: false };
    for (const ep of Array.isArray(doc?.endpoints) ? doc.endpoints : []) {
      const id = String(ep?.id ?? '');
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) { this.configError = `bad endpoint id '${id}'`; continue; }
      if (!ep.secret && !ep.secretSha256) { this.configError = `endpoint '${id}' has no secret`; continue; }
      const n = Number(ep.max_per_hour);
      this.endpoints.set(id, {
        id,
        secret: ep.secret ? String(ep.secret) : null,
        secretSha256: ep.secretSha256 ? String(ep.secretSha256) : null,
        prompt: String(ep.prompt ?? 'Webhook event received.'),
        maxPerHour: Number.isFinite(n) && n > 0 ? Math.min(HARD_CEILING, Math.floor(n)) : DEFAULT_MAX_PER_HOUR,
        firedAt: [],
      });
    }
    return { enabled: true, bind: doc.bind ?? '127.0.0.1', port: doc.port };
  }

  /** Start the listener. Resolves {port} when bound; resolves {disabled:true}
   *  when config is absent/disabled — that is a quiet no-op, not an error. */
  listen() {
    const cfg = this.#load();
    if (!cfg.enabled) return Promise.resolve({ disabled: true, reason: this.configError ?? 'no enabled config' });
    const port = Number(cfg.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return Promise.resolve({ disabled: true, reason: `bad port '${cfg.port}'` });
    }
    const bind = String(cfg.bind ?? '127.0.0.1');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(bind)) {
      // non-loopback bind is an explicit operator choice but loudly audited
      this.audit?.write({ kind: 'WEBHOOK_BIND_WIDE', data: { bind } });
    }
    this.server = createServer((req, res) => { this.#handle(req, res); });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, bind === 'localhost' ? '127.0.0.1' : bind, () => {
        this.audit?.write({ kind: 'WEBHOOK_LISTEN', data: { bind, port: this.server.address().port, endpoints: this.endpoints.size } });
        resolve({ port: this.server.address().port, endpoints: this.endpoints.size });
      });
    });
  }

  #refuse(res, code, msg, auditKind, extra = {}) {
    this.audit?.write({ kind: auditKind, data: extra });
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
  }

  async #handle(req, res) {
    if (req.method !== 'POST') return this.#refuse(res, 405, 'POST only', 'WEBHOOK_METHOD_REFUSED', { method: req.method });
    const m = /^\/hook\/([a-zA-Z0-9_-]{1,64})$/.exec(new URL(req.url, 'http://x').pathname);
    if (!m) return this.#refuse(res, 404, 'no such endpoint', 'WEBHOOK_UNKNOWN_PATH', { url: req.url?.slice(0, 80) });
    const ep = this.endpoints.get(m[1]);
    if (!ep) return this.#refuse(res, 404, 'no such endpoint', 'WEBHOOK_UNKNOWN_ENDPOINT', { id: m[1] });

    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-pai-secret'];
    const ok = ep.secretSha256 ? eq(sha(token ?? ''), ep.secretSha256) : eq(token ?? '', ep.secret ?? '');
    if (!ok) return this.#refuse(res, 403, 'bad secret', 'WEBHOOK_AUTH_REFUSED', { id: ep.id });

    let body = '';
    let tooBig = false;
    req.on('data', (c) => { body += c; if (body.length > BODY_CAP) { tooBig = true; req.destroy(); } });
    await new Promise((r) => { req.on('end', r); req.on('close', r); req.on('error', r); });
    if (tooBig) return this.#refuse(res, 413, 'body too large', 'WEBHOOK_BODY_CAP', { id: ep.id });

    let payload = null;
    if (body.trim()) {
      try { payload = JSON.parse(body); }
      catch { return this.#refuse(res, 400, 'JSON body required', 'WEBHOOK_BAD_JSON', { id: ep.id }); }
    }

    const cutoff = this.now() - WINDOW_MS;
    ep.firedAt = ep.firedAt.filter((t) => t > cutoff);
    if (ep.firedAt.length >= ep.maxPerHour) {
      return this.#refuse(res, 429, 'rate cap', 'WEBHOOK_RATE_CAP', { id: ep.id });
    }
    ep.firedAt.push(this.now());

    const msg = `[webhook:${ep.id}] ${ep.prompt}` +
      (payload != null ? `\n\nPayload (untrusted):\n${JSON.stringify(payload).slice(0, PAYLOAD_CAP)}` : '');
    const r = await this.promptSink(msg, { webhook: ep.id }).catch((e) => ({ refused: e?.message ?? 'sink error' }));
    if (!r?.ok) {
      this.audit?.write({ kind: 'WEBHOOK_SINK_REFUSED', data: { id: ep.id, refused: r?.refused ?? 'unknown' } });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: false, refused: r?.refused ?? 'session busy' }));
      return;
    }
    this.audit?.write({ kind: 'WEBHOOK_FIRED', data: { id: ep.id } });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  }

  status() {
    return {
      listening: !!this.server,
      endpoints: [...this.endpoints.values()].map((e) => ({ id: e.id, maxPerHour: e.maxPerHour, firedThisHour: e.firedAt.length })),
      configError: this.configError,
    };
  }

  async close() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(r));
    this.server = null;
  }
}
