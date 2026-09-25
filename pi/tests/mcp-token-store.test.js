/**
 * dedup-h #2177 — mcp OAuth token store encryption at rest: on DPAPI
 * platforms the file carries ciphertext only; legacy plaintext still
 * reads and migrates on next write.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dpapiAvailable } from '../../host/src/core/cryptostore.js';
import { mcpOperatorSurface } from '../extensions/mcp/index.js';

test('#2177 DPAPI platforms: token file is ciphertext-only, reads back, migrates legacy', () => {
  if (!dpapiAvailable()) return; // platform has no DPAPI — plaintext path is the honest fallback
  const dir = mkdtempSync(join(tmpdir(), 'pai-tok-'));
  const store = join(dir, 'mcp-oauth.json');
  process.env.PAI_MCP_TOKEN_STORE = store;
  try {
    mcpOperatorSurface.writeTokenStore({ srv: { access_token: 'tok-abc-123', expires_at: 9 } });
    const raw = readFileSync(store, 'utf-8');
    assert.ok(!raw.includes('tok-abc-123'), 'on-disk file carries no plaintext token');
    const doc = JSON.parse(raw);
    assert.equal(doc.enc, 'dpapi');
    assert.equal(mcpOperatorSurface.readTokenStore().srv.access_token, 'tok-abc-123');
    // corrupt blob → {} (re-auth path), never a partial decode
    doc.data = 'AAAA';
    writeFileSync(store, JSON.stringify(doc));
    assert.deepEqual(mcpOperatorSurface.readTokenStore(), {});
    // legacy plaintext file still reads; next write migrates to ciphertext
    writeFileSync(store, JSON.stringify({ old: { access_token: 'legacy' } }));
    assert.equal(mcpOperatorSurface.readTokenStore().old.access_token, 'legacy');
    mcpOperatorSurface.writeTokenStore({ old: { access_token: 'legacy' } });
    assert.equal(JSON.parse(readFileSync(store, 'utf-8')).enc, 'dpapi');
  } finally {
    delete process.env.PAI_MCP_TOKEN_STORE;
  }
});
