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
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createHttpBridge({ supervisor, uiDir = UI_DIR, pickDir = null }) {
  const sseClients = new Set();
  const unsub = supervisor.subscribe((msg) => {
    const frame = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch { /* dropped client */ }
    }
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
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
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const [current, bodies] = await Promise.all([
          supervisor.handle({ type: 'body_current' }),
          supervisor.handle({ type: 'body_list' }),
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ current: current.data ?? null, bodies: bodies.data ?? [] }));
        return;
      }
      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^([/\\])+/, '');
        const file = join(uiDir, rel);
        if (!file.startsWith(uiDir) || !existsSync(file)) {
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
      unsub();
      for (const res of sseClients) { try { res.end(); } catch { /* already gone */ } }
      sseClients.clear();
      return new Promise((r) => server.close(r));
    },
  };
}
