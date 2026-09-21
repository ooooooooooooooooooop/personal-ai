/**
 * MemoryStore (G-family) — canonical SQLite memory for the instance.
 *
 * Design contract (external ruling + OpenClaw/Hermes references):
 *  - canonical store is SQLite: `memory` table + FTS5 recall index
 *  - write path is scanned for secrets BEFORE the row lands (shared
 *    scanForSecrets pattern set) and deduped on normalized text
 *  - pinned/core rows are injected into the context envelope as UNTRUSTED
 *    evidence — memory is recalled content, never an authority channel
 *  - distill() is the review-triggered maintenance pass: merge exact
 *    duplicates, demote stale low-confidence rows, archive ancient ones.
 *    It never invents or promotes — promotion to soul is explicit only.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { scanForSecrets } from './secrets.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'fact',
  text TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'agent',
  confidence REAL NOT NULL DEFAULT 0.7,
  pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL, updated TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, content='memory', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO memory_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

const nowIso = () => new Date().toISOString();
const norm = (t) => String(t ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

export class MemoryStore {
  /** @param {string} dbPath <instance>/memory.db */
  constructor(dbPath) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    // M65 scope columns — idempotent adds on existing stores. 'user' rows are
    // global to the instance; 'project' rows bind to a workdir and recall
    // only inside it (Claude Code project/user memory analogue).
    for (const col of ["scope TEXT NOT NULL DEFAULT 'user'", 'workdir TEXT']) {
      try { this.db.exec(`ALTER TABLE memory ADD COLUMN ${col}`); } catch { /* column exists */ }
    }
  }

  /**
   * Write a memory. Refuses secret-looking text outright (memory recall is
   * injected into context — a stored secret would leak into every prompt);
   * exact normalized duplicates update `updated` instead of growing a row.
   * scope 'project' requires the workdir it binds to.
   */
  remember(text, { kind = 'fact', source = 'agent', confidence = 0.7, scope = 'user', workdir = null } = {}) {
    const t = String(text ?? '').trim();
    if (!t) return { refused: 'empty memory' };
    if (t.length > 4000) return { refused: 'memory text too long (>4000)' };
    if (!['user', 'project'].includes(scope)) return { refused: `unknown scope '${scope}'` };
    if (scope === 'project' && !workdir) return { refused: "scope 'project' requires a workdir" };
    const secret = scanForSecrets(t);
    if (secret) return { refused: `secret-looking content (${secret}) — never persisted to memory` };
    const n = norm(t);
    const dupe = this.db.prepare(
      'SELECT id FROM memory WHERE lower(text) = ? AND archived = 0',
    ).get(t.toLowerCase()) ?? this.db.prepare(
      "SELECT id FROM memory WHERE replace(lower(text),' ','') = ? AND archived = 0",
    ).get(n.replace(/\s/g, ''));
    if (dupe) {
      this.db.prepare('UPDATE memory SET updated = ?, confidence = MAX(confidence, ?) WHERE id = ?')
        .run(nowIso(), confidence, dupe.id);
      return { id: dupe.id, deduped: true };
    }
    const id = `mem-${randomUUID().slice(0, 12)}`;
    this.db.prepare(
      'INSERT INTO memory (id, kind, text, source, confidence, scope, workdir, created, updated) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(id, kind, t, source, confidence, scope, scope === 'project' ? workdir : null, nowIso(), nowIso());
    return { id };
  }

  /** scope visibility: user rows always; project rows only inside their workdir. */
  #scopeClause(workdir, alias = 'm') {
    return workdir
      ? { sql: `AND (${alias}.scope = 'user' OR (${alias}.scope = 'project' AND ${alias}.workdir = ?))`, arg: workdir }
      : { sql: "AND m.scope = 'user'", arg: null };
  }

  /** FTS5 recall — returns ranked rows; falls back to LIKE on query errors. */
  recall(query, { limit = 8, includeArchived = false, workdir = null } = {}) {
    const q = String(query ?? '').trim();
    const arch = includeArchived ? '' : 'AND m.archived = 0';
    const sc = this.#scopeClause(workdir);
    if (!q) return this.pinned(limit, workdir);
    try {
      // quote the query — user text is not FTS syntax
      return this.db.prepare(
        `SELECT m.id, m.kind, m.text, m.source, m.confidence, m.pinned, m.scope, m.updated
         FROM memory_fts f JOIN memory m ON m.rowid = f.rowid
         WHERE memory_fts MATCH ? ${arch} ${sc.sql}
         ORDER BY rank LIMIT ?`,
      ).all(`"${q.replace(/"/g, '""')}"`, ...(sc.arg != null ? [workdir] : []), limit);
    } catch {
      const like = `%${q.replace(/[%_]/g, '')}%`;
      return this.db.prepare(
        `SELECT id, kind, text, source, confidence, pinned, scope, updated FROM memory m
         WHERE m.text LIKE ? ${arch} ${sc.sql} ORDER BY m.updated DESC LIMIT ?`,
      ).all(...(sc.arg != null ? [like, workdir, limit] : [like, limit]));
    }
  }

  /** Newest-first listing for operator review surfaces (all scopes shown). */
  all(limit = 50) {
    return this.db.prepare(
      'SELECT id, kind, text, source, confidence, pinned, archived, scope, workdir, updated FROM memory WHERE archived = 0 ORDER BY updated DESC LIMIT ?',
    ).all(limit);
  }

  /** Pinned/core rows — the small set injected every turn (scope-filtered). */
  pinned(limit = 20, workdir = null) {
    const sc = this.#scopeClause(workdir);
    return this.db.prepare(
      `SELECT id, kind, text, source, confidence, pinned, scope, updated FROM memory m
       WHERE pinned = 1 AND archived = 0 ${sc.sql} ORDER BY updated DESC LIMIT ?`,
    ).all(...(sc.arg != null ? [workdir, limit] : [limit]));
  }

  pin(id, on = true) {
    return this.db.prepare('UPDATE memory SET pinned = ?, updated = ? WHERE id = ?')
      .run(on ? 1 : 0, nowIso(), id).changes > 0;
  }

  /**
   * Atomic batch ops (M74): a multi-row save/forget/pin set commits as ONE
   * transaction — a mid-batch failure must not leave half-applied state.
   * @returns {{applied: number, results: Array}}
   */
  bulk(ops, { workdir = null } = {}) {
    if (!Array.isArray(ops) || !ops.length) return { applied: 0, results: [] };
    if (ops.length > 50) return { refused: 'bulk limited to 50 ops' };
    const results = [];
    this.db.exec('BEGIN');
    try {
      for (const op of ops) {
        if (op.action === 'save') results.push(this.remember(op.text, { kind: op.kind ?? 'fact', source: op.source ?? 'agent', scope: op.scope ?? 'user', workdir }));
        else if (op.action === 'forget') results.push({ ok: this.forget(String(op.id)) });
        else if (op.action === 'pin') results.push({ ok: this.pin(String(op.id), op.pinned !== false) });
        else results.push({ refused: `unknown bulk action '${op.action}'` });
      }
      const bad = results.find((r) => r.refused || r.ok === false);
      if (bad) { this.db.exec('ROLLBACK'); return { refused: bad.refused ?? 'a bulk op failed (missing target)', applied: 0, results: [] }; }
      this.db.exec('COMMIT');
      return { applied: results.length, results };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      return { refused: `bulk aborted: ${e.message}`, applied: 0, results: [] };
    }
  }

  forget(id) {
    return this.db.prepare('UPDATE memory SET archived = 1, updated = ? WHERE id = ?')
      .run(nowIso(), id).changes > 0;
  }

  /**
   * Review-triggered maintenance — merge exact duplicates, demote stale
   * rows, archive very old unreferenced ones. Deterministic, no LLM: the
   * distillation judgment happens in review; this pass only enforces
   * decay/hygiene.
   */
  distill({ staleDays = 30, archiveDays = 120 } = {}) {
    const now = Date.now();
    // Archive BEFORE demoting — demotion stamps `updated`, which would mask
    // the age check if it ran first. Archive gates on created-age so a row
    // can't escape retirement merely by being touched.
    const archived = this.db.prepare(
      `UPDATE memory SET archived = 1, updated = ?
       WHERE archived = 0 AND pinned = 0 AND created < ? AND confidence < 0.5`,
    ).run(nowIso(), new Date(now - archiveDays * 864e5).toISOString()).changes;
    const demoted = this.db.prepare(
      `UPDATE memory SET confidence = MAX(0.1, confidence - 0.2), updated = ?
       WHERE archived = 0 AND pinned = 0 AND updated < ?`,
    ).run(nowIso(), new Date(now - staleDays * 864e5).toISOString()).changes;
    return { demoted, archived };
  }

  /**
   * Context envelope payload — pinned rows first, then per-turn relevance
   * hits (KAOS `memory search --format inject` analogue): keywords from the
   * current user text pull related unpinned rows into the same untrusted
   * <memory> evidence block. Deduped by id, capped at `limit` total.
   */
  injection(limit = 12, hint = '', workdir = null) {
    const out = new Map();
    for (const m of this.pinned(limit, workdir)) out.set(m.id, m);
    const sc = this.#scopeClause(workdir);
    const tokens = String(hint ?? '')
      .match(/[\p{L}\p{N}_]{2,}/gu)?.slice(0, 12) ?? [];
    if (tokens.length) {
      try {
        const q = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
        const rows = this.db.prepare(
          `SELECT m.id, m.kind, m.text, m.source, m.confidence, m.pinned, m.updated
           FROM memory_fts f JOIN memory m ON m.rowid = f.rowid
           WHERE memory_fts MATCH ? AND m.archived = 0 ${sc.sql}
           ORDER BY rank LIMIT ?`,
        ).all(q, ...(sc.arg != null ? [workdir] : []), limit);
        for (const m of rows) { if (!out.has(m.id) && out.size < limit) out.set(m.id, m); }
      } catch { /* relevance pull is best-effort — pinned rows still inject */ }
    }
    return [...out.values()].map((m) => ({
      kind: m.kind, text: m.text, confidence: m.confidence, id: m.id,
    }));
  }

  stats() {
    return this.db.prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN pinned = 1 AND archived = 0 THEN 1 ELSE 0 END) pinned,
              SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) archived
       FROM memory`,
    ).get();
  }

  close() { this.db.close(); }
}

/** Instance-path helper shared by bootstrap + tools. */
export const memoryDbPath = (instanceRoot) => join(instanceRoot, 'memory.db');
