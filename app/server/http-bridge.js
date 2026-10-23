/**
 * Zero-dependency HTTP bridge between the UI and the BodySupervisor.
 *
 *   POST /cmd        {channel command} → supervisor.handle → JSON response
 *   GET  /events     SSE stream — every supervisor/body record as it happens
 *   GET  /api/state  one-shot snapshot {current, bodies, switching}
 *   GET  /*          static UI files from app/ui
 *
 * Localhost-only by construction — the listener binds 127.0.0.1.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DEFAULT_UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
const DIST_UI_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function createHttpBridge({ supervisor, uiDir = null, pickDir = null }) {
  const resolvedUiDir = uiDir
    ?? process.env.PAI_UI_DIR
    ?? (process.env.PAI_UI === 'modern' && existsSync(DIST_UI_DIR) ? DIST_UI_DIR : DEFAULT_UI_DIR);
  // M9 (CodeBuddy same-origin fix analogue): binding 127.0.0.1 does NOT stop
  // a malicious web page from POSTing /cmd cross-origin — CORS only gates
  // reads, writes still land. Reject browser cross-site POSTs: an Origin
  // header that isn't this bridge, or a Sec-Fetch-Site marking cross-site.
  const badOrigin = (req) => {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const h = new URL(origin).hostname;
        if (h !== '127.0.0.1' && h !== 'localhost' && h !== '[::1]') return true;
      } catch { return true; }
    }
    const sfs = req.headers['sec-fetch-site'];
    if (sfs && sfs !== 'same-origin' && sfs !== 'same-site' && sfs !== 'none') return true;
    return false;
  };
  const refuse = (res) => { res.writeHead(403); res.end('cross-origin POST refused'); };
  // DNS-rebinding guard: the Origin/Section-Fetch checks above only run on
  // POSTs, but a rebound hostname makes a browser page same-origin with this
  // listener — GET /events would then stream the live session telemetry to a
  // hostile page (EventSource sends no Origin). Gate EVERY request on the
  // Host header: only literal loopback authorities may talk to the bridge.
  const badHost = (req) => {
    const host = req.headers.host;
    if (!host) return false; // HTTP/1.0 clients carry no Host
    try {
      const h = new URL(`http://${host}`).hostname;
      return !(h === '127.0.0.1' || h === 'localhost' || h === '[::1]');
    } catch { return true; }
  };
  const sseClients = new Set();
  // SSE keep-alive heartbeat: sends a ping comment every 15s so idle/background
  // connections are never closed by Chromium, Node HTTP parser or intermediate proxies
  const ssePingTimer = setInterval(() => {
    for (const res of sseClients) {
      try { res.write(':ping\n\n'); } catch { sseClients.delete(res); }
    }
  }, 15_000);
  ssePingTimer.unref?.();

  const unsub = supervisor.subscribe((msg) => {
    const frame = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch { /* dropped client */ }
    }
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (badHost(req)) { res.writeHead(403); res.end('non-loopback Host refused'); return; }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(':ok\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/cmd') {
        if (badOrigin(req)) { refuse(res); return; }
        let body = '';
        for await (const chunk of req) body += chunk;
        const cmd = JSON.parse(body || '{}');
        const out = await supervisor.handle(cmd).catch((e) => ({
          id: cmd?.id, type: 'response', command: cmd?.type,
          success: false, error: e?.message ?? String(e),
        }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/pick-dir') {
        if (badOrigin(req)) { refuse(res); return; }
        if (!pickDir) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'directory picker unavailable' }));
          return;
        }
        const dir = await pickDir().catch(() => null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ dir: dir ?? null }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/artifact') {
        // Confined download surface: only files under <instance>/exports/** are
        // servable — browser screenshots/exports render in the UI, nothing else.
        const p = url.searchParams.get('path') ?? '';
        const root = normalize(join(supervisor.instanceRoot ?? '', 'exports'));
        const file = normalize(p);
        if (!file.startsWith(root + sep) || !existsSync(file)) {
          res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(readFileSync(file));
        return;
      }
      // Artifact listing (CodeBuddy 成果面板 analogue): everything the body
      // exported — screenshots, debug bundles, exports — browsable + openable.
      if (req.method === 'GET' && url.pathname === '/api/artifacts') {
        const root = normalize(join(supervisor.instanceRoot ?? '', 'exports'));
        const rows = [];
        const walk = (d, depth) => {
          if (depth > 4 || rows.length >= 200) return;
          let ents = [];
          try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else {
              try {
                const st = statSync(p);
                rows.push({ path: p, bytes: st.size, mtime: st.mtime.toISOString() });
              } catch { /* transient */ }
            }
          }
        };
        walk(root, 0);
        rows.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ artifacts: rows }));
        return;
      }
      // dedup-h #3934 — unified sessions listing endpoint (/api/v1/sessions
      // analogue): same governed op the UI uses, one REST shape for local
      // tooling. Session rows only — never transcript bodies.
      if (req.method === 'GET' && (url.pathname === '/api/v1/sessions' || url.pathname === '/api/sessions')) {
        const r = await supervisor.handle({ type: 'session_list' }).catch((e) => ({ success: false, error: e?.message ?? String(e) }));
        res.writeHead(r.success ? 200 : 502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r.success ? { sessions: r.data ?? [] } : { error: r.error ?? 'session_list failed' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const [current, bodies] = await Promise.all([
          supervisor.handle({ type: 'body_current' }),
          supervisor.handle({ type: 'body_list' }),
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ current: current.data ?? null, bodies: bodies.data ?? [] }));
        return;
      }
      // T3 (docs/user-and-tasks.md): machine-local sync health. The checkpoint
      // written by scripts/personal_ai_sync.py is the single source of truth
      // for "is my Personal AI in sync". Read per request, never cached; a
      // missing/corrupt file is a valid state (never synced). 机-plane data
      // served only to this localhost UI — it never leaves the device.
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const p = process.env.PA_SYNC_CHECKPOINT
          ?? join(homedir(), '.dsh', '.personal-ai-sync', 'status.json');
        let checkpoint = null;
        try { checkpoint = JSON.parse(readFileSync(p, 'utf-8')); } catch { /* absent/corrupt → unavailable */ }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ available: checkpoint !== null, checkpoint, serverTime: new Date().toISOString() }));
        return;
      }
      // /api/v1/metrics analogue (M75): honest process telemetry for the
      // bridge + the live body. RSS/heap/uptime — no invented gauges.
      if (req.method === 'GET' && url.pathname === '/api/metrics') {
        const mu = process.memoryUsage();
        const body = supervisor.active ?? null;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          bridge: {
            pid: process.pid,
            uptime_s: Math.round(process.uptime()),
            rss_bytes: mu.rss,
            heap_used_bytes: mu.heapUsed,
            heap_total_bytes: mu.heapTotal,
          },
          body: body ? {
            id: body.bodyId,
            pid: body.child?.pid ?? null,
            alive: !body.dead,
            pending_calls: body.pending?.size ?? 0,
          } : null,
          workdir: supervisor.workdir ?? null,
        }));
        return;
      }
      // dedup-h #3753 — liveness/readiness probes (k8s-style): /healthz
      // answers while the bridge loop runs; /readyz is honest — 503 until a
      // live body is attached, 200 once the active body reports !dead.
      if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/readyz' || url.pathname === '/ready')) {
        const body = supervisor.active ?? null;
        const ready = Boolean(body && !body.dead);
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ready, body: body?.bodyId ?? null }));
        return;
      }
      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^([/\\])+/, '');
        const file = join(resolvedUiDir, rel);
        if (!file.startsWith(resolvedUiDir) || !existsSync(file)) {
          res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(readFileSync(file));
        return;
      }
      res.writeHead(405); res.end('method not allowed');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e?.message ?? String(e) }));
    }
  });

  return {
    server,
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      clearInterval(ssePingTimer);
      unsub();
      for (const res of sseClients) { try { res.end(); } catch { /* already gone */ } }
      sseClients.clear();
      return new Promise((r) => server.close(r));
    },
  };
}
