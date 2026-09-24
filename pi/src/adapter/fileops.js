/**
 * File-mutation safety — WorkBuddy-style backup/recycle semantics.
 *
 * Every governed file mutation routes through here:
 *  - delete → move into <instance>/recycle/<ts>/ (recoverable, never rm -f)
 *  - write/edit → byte-exact backup into <instance>/backups/<ts>/ before mutation
 *  - serialization via withFileMutationQueue (pi-coding-agent) per target path
 *  - every operation is receipted into an operations log so restore() can undo
 *
 * These wrappers wrap the tool call args the kernel already admitted — they do
 * NOT replace the guard; they make admitted mutations recoverable.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { unifiedDiff } from '../../../host/src/core/diffutil.js';
import { createHash, randomUUID } from 'node:crypto';

export class FileOpsGuard {
  /**
   * @param {string} instanceRoot — recycle/ backups/ ops-log live here
   * @param {object} [opts]
   * @param {number} [opts.artifactCap=200] — retained artifacts PER store
   *        (backups/, recycle/); oldest evicted first. Unbounded growth would
   *        eventually fill the disk on a long-lived instance; undo surfaces
   *        already degrade honestly when an artifact is gone (recoverable:false
   *        in list(), 'artifact gone' in diff()), so eviction is safe.
   */
  constructor(instanceRoot, { artifactCap = 200, workdir = null, onCheckpoint = null } = {}) {
    this.root = instanceRoot;
    // GC boundary for dirsCreated receipts: only directories strictly inside
    // the workspace are ever candidates for empty-dir removal on undo.
    this.workdir = workdir ? resolve(workdir) : null;
    this.recycleDir = join(instanceRoot, 'recycle');
    this.backupDir = join(instanceRoot, 'backups');
    this.opsLog = join(instanceRoot, 'fileops.jsonl');
    this.artifactCap = artifactCap;
    // dedup-h #884 — unstable_Checkpoint analogue: every mutation receipt
    // (pre-image already captured) additionally notifies this callback so
    // the host can fire a `file_checkpoint` hook event. 'purge' sweeps and
    // non-mutating logs stay silent.
    this.onCheckpoint = onCheckpoint;
    for (const d of [this.recycleDir, this.backupDir]) mkdirSync(d, { recursive: true });
  }

  /**
   * Move a file OR directory into an artifact store. renameSync fails with
   * EXDEV when the workspace and the instance root sit on different volumes
   * (a multi-drive Windows box is the norm, not the edge) — fall back to
   * copy+remove so a cross-volume delete/restore-displace still works.
   */
  #moveTree(src, dest) {
    try {
      renameSync(src, dest);
    } catch (e) {
      if (e?.code !== 'EXDEV') throw e;
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    }
  }

  /** Evict oldest artifacts beyond the cap; receipted as purge (invisible to undo). */
  #sweep(dirPath) {
    let files;
    try {
      files = readdirSync(dirPath)
        .map((f) => ({ p: join(dirPath, f), m: statSync(join(dirPath, f)).mtimeMs }))
        .sort((a, b) => a.m - b.m);
    } catch { return; } // store unreadable — sweep is best-effort
    for (const f of files.slice(0, Math.max(0, files.length - this.artifactCap))) {
      try {
        rmSync(f.p, { recursive: true, force: true });
        this.#log({ op: 'purge', target: f.p, swept: true });
      } catch { /* locked artifact — next sweep retries */ }
    }
  }

  /**
   * Recoverable delete: move the target into the recycle bin.
   * @returns {Promise<{recycled:string, receiptId:string}>}
   */
  async delete(targetPath, { toolCallId = null } = {}) {
    const abs = resolve(targetPath);
    return withFileMutationQueue(abs, async () => {
      if (!existsSync(abs)) throw new Error(`delete target missing: ${abs}`);
      const receiptId = `fo-${randomUUID().slice(0, 8)}`;
      // receiptId in the artifact name: same-basename files mutated within the
      // same millisecond (multi_edit across dirs) must not overwrite each
      // other's backups — a silent clobber here corrupts a LATER restore.
      const dest = join(this.recycleDir, `${Date.now()}-${receiptId}-${basename(abs)}`);
      this.#moveTree(abs, dest);
      this.#log({ receiptId, op: 'delete', target: abs, recycledTo: dest, toolCallId });
      this.#sweep(this.recycleDir);
      return { recycled: dest, receiptId };
    });
  }

  /**
   * Pre-execution snapshot: byte-copy the existing target into backups/ and
   * receipt it — the mutation itself is then performed by the admitted tool.
   * New files get a 'create' tombstone receipt instead of nothing: the
   * receipt records that the target did NOT exist pre-mutation, so a
   * dual-scope rewind can undo the creation by removing the file.
   */
  async backup(targetPath, { toolCallId = null } = {}) {
    const abs = resolve(targetPath);
    return withFileMutationQueue(abs, async () => {
      const receiptId = `fo-${randomUUID().slice(0, 8)}`;
      if (!existsSync(abs)) {
        this.#log({ receiptId, op: 'create', target: abs, backup: null, preSha: null, toolCallId });
        return { backup: null, receiptId };
      }
      const preSha = createHash('sha256').update(readFileSync(abs)).digest('hex');
      const backup = join(this.backupDir, `${Date.now()}-${receiptId}-${basename(abs)}`);
      copyFileSync(abs, backup);
      this.#log({ receiptId, op: 'backup', target: abs, backup, preSha, toolCallId });
      this.#sweep(this.backupDir);
      return { backup, receiptId };
    });
  }

  /**
   * Backup-then-write: existing targets are byte-copied to backups/ first.
   * @returns {Promise<{backup:string|null, receiptId:string}>}
   */
  async write(targetPath, content, { toolCallId = null } = {}) {
    const abs = resolve(targetPath);
    return withFileMutationQueue(abs, async () => {
      const receiptId = `fo-${randomUUID().slice(0, 8)}`;
      let backup = null;
      let preSha = null;
      if (existsSync(abs)) {
        preSha = createHash('sha256').update(readFileSync(abs)).digest('hex');
        backup = join(this.backupDir, `${Date.now()}-${receiptId}-${basename(abs)}`);
        copyFileSync(abs, backup);
      }
      // #1277 — record which ancestors this write is about to create so a
      // later tombstone restore can remove ONLY the dirs it made AND only
      // while they are still empty (upstream revert semantics).
      let dirsCreated = null;
      if (this.workdir) {
        const missing = [];
        let d = dirname(abs);
        while (d !== this.workdir && d.startsWith(this.workdir + sep) && !existsSync(d)) {
          missing.push(d); // deepest first
          d = dirname(d);
        }
        if (missing.length) dirsCreated = missing;
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      this.#log({ receiptId, op: 'write', target: abs, backup, preSha, toolCallId, dirsCreated });
      if (backup) this.#sweep(this.backupDir);
      return { backup, receiptId };
    });
  }

  /**
   * Restore the most recent backup/recycled copy of a path. Creation
   * tombstones (op 'create', or 'write' with no backup artifact) undo by
   * recycling the target — the file did not exist pre-mutation, so undo
   * means it should not exist afterwards either.
   */
  restore(receiptId) {
    const ops = this.#ops().filter((o) => o.receiptId === receiptId);
    const op = ops.at(-1);
    if (!op) throw new Error(`no fileops receipt ${receiptId}`);
    const source = op.recycledTo ?? op.backup;
    if (!source) {
      if (op.op !== 'create' && !(op.op === 'write' && !op.backup)) {
        throw new Error(`receipt ${receiptId} has no recoverable artifact`);
      }
      if (existsSync(op.target)) {
        const rid = `fo-${randomUUID().slice(0, 8)}`;
        const dest = join(this.recycleDir, `${Date.now()}-${rid}-${basename(op.target)}`);
        this.#moveTree(op.target, dest);
        const dirsRemoved = [];
        // #1277 — a created file's undo also reaps the empty directories the
        // creating write made; still-nonempty dirs (user dropped content in)
        // are kept, and non-recursive rmdir is fail-safe on the race.
        for (const d of op.dirsCreated ?? []) {
          try { if (existsSync(d) && readdirSync(d).length === 0) { rmdirSync(d); dirsRemoved.push(d); } } catch { /* keep */ }
        }
        this.#log({ receiptId: rid, op: 'restore', target: op.target, removedTo: dest, dirsRemoved: dirsRemoved.length ? dirsRemoved : undefined });
        this.#sweep(this.recycleDir);
      }
      return op.target;
    }
    if (!existsSync(source)) throw new Error(`receipt ${receiptId} has no recoverable artifact`);
    // ZCode safety-checkpoint semantics: never clobber the current file —
    // if bytes exist at the target now (agent edits or external changes),
    // they are recycled before the overwrite, so a restore is itself
    // recoverable instead of destroying un-receipted work.
    if (existsSync(op.target)) {
      const rid = `fo-${randomUUID().slice(0, 8)}`;
      const dest = join(this.recycleDir, `${Date.now()}-${rid}-${basename(op.target)}`);
      this.#moveTree(op.target, dest);
      this.#log({ receiptId: rid, op: 'restore-displace', target: op.target, removedTo: dest });
      this.#sweep(this.recycleDir);
    }
    copyFileSync(source, op.target);
    this.#log({ receiptId: `fo-${randomUUID().slice(0, 8)}`, op: 'restore', target: op.target, from: source });
    return op.target;
  }

  /**
   * Tool-call-scoped undo: restore every mutation receipt attributed to one
   * tool call. This is the tool-level checkpoint surface — the operator can
   * undo exactly what a single admitted call did to files without rewinding
   * the whole session. Returns {restored:[targets], skipped:[{receiptId,reason}]};
   * restores run newest-first and each restore is itself receipted.
   */
  async undoCall(toolCallId) {
    const ops = this.#ops()
      .filter((o) => o.toolCallId === toolCallId && !['restore', 'restore-displace', 'purge'].includes(o.op))
      .reverse(); // newest-first: later mutations revert before earlier ones
    const restored = [];
    const skipped = [];
    for (const op of ops) {
      try {
        restored.push(this.restore(op.receiptId));
      } catch (e) {
        skipped.push({ receiptId: op.receiptId, reason: e.message });
      }
    }
    if (!restored.length && !skipped.length) throw new Error(`no receipts for tool call ${toolCallId}`);
    return { restored, skipped };
  }

  /**
   * Checkpoint-boundary undo: rewind workspace file state to just BEFORE the
   * given receipt — the anchor op plus every newer receipted mutation is
   * reverted, newest-first. (Rewind-to-after-the-anchor is
   * `undoFrom(nextReceipt)`; the UI offers the anchor as the boundary.)
   */
  async undoFrom(receiptId) {
    const ops = this.#ops();
    const idx = ops.findIndex((o) => o.receiptId === receiptId);
    if (idx < 0) throw new Error(`no fileops receipt ${receiptId}`);
    const targets = ops.slice(idx)
      .filter((o) => !['restore', 'restore-displace', 'purge'].includes(o.op))
      .reverse();
    const restored = [];
    const skipped = [];
    for (const op of targets) {
      try {
        restored.push(this.restore(op.receiptId));
      } catch (e) {
        skipped.push({ receiptId: op.receiptId, reason: e.message });
      }
    }
    return { restored, skipped };
  }

  /** Hard purge of a recycled artifact (operator-level; logged). */
  purge(recycledName) {
    const p = join(this.recycleDir, basename(recycledName));
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      this.#log({ op: 'purge', target: p });
    }
  }

  #ops() {
    if (!existsSync(this.opsLog)) return [];
    // per-line tolerance: a torn tail row (crash mid-append) must not kill the
    // ENTIRE undo surface — restore/undoFrom/diff all parse through here.
    return readFileSync(this.opsLog, 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  /** Receipted ops newest-first, plain data for the channel's fileops facade. */
  list(n = 50) {
    return this.#listOps().slice(-n).reverse();
  }

  /**
   * Uncapped receipt scan for dual-scope rewind — the UI list cap (50) must
   * not silently drop undoable mutations past the anchor.
   */
  listAll() {
    return this.#listOps().reverse();
  }

  /**
   * Aggregated unified diff of the N newest receipted mutations (newest-first
   * receipts, emitted oldest-first so the diff reads chronologically). For
   * 'backup'/'write' ops: backup bytes → current target bytes. For 'create':
   * empty → current. For 'delete': recycled bytes → empty. Returns
   * {diffs:[{receiptId,op,target,diff}], skipped:[{receiptId,reason}]} — a
   * receipt whose artifacts vanished is reported, not silently dropped.
   */
  diff(n = 10, receiptId = null) {
    let ops = this.#ops().filter((o) => o.receiptId && o.op !== 'restore');
    if (receiptId) ops = ops.filter((o) => o.receiptId === receiptId);
    else ops = ops.slice(-n);
    const diffs = [];
    const skipped = [];
    for (const op of ops) {
      try {
        const current = existsSync(op.target) ? readFileSync(op.target, 'utf-8') : null;
        if (op.op === 'create' || ((op.op === 'write' || op.op === 'backup') && !op.backup)) {
          // create-tombstone: file did not exist pre-mutation — empty → current
          diffs.push({ receiptId: op.receiptId, op: op.op, target: op.target, diff: unifiedDiff('', current ?? '', { path: op.target }) });
        } else if (op.op === 'delete' && op.recycledTo && existsSync(op.recycledTo)) {
          diffs.push({ receiptId: op.receiptId, op: op.op, target: op.target, diff: unifiedDiff(readFileSync(op.recycledTo, 'utf-8'), '', { path: op.target }) });
        } else if (op.backup && existsSync(op.backup)) {
          diffs.push({ receiptId: op.receiptId, op: op.op, target: op.target, diff: unifiedDiff(readFileSync(op.backup, 'utf-8'), current ?? '', { path: op.target }) });
        } else {
          skipped.push({ receiptId: op.receiptId, reason: 'artifact gone — nothing to diff against' });
        }
      } catch (e) {
        skipped.push({ receiptId: op.receiptId, reason: String(e?.message ?? e).slice(0, 200) });
      }
    }
    return { diffs, skipped };
  }

  #listOps() {
    return this.#ops()
      .filter((o) => o.receiptId && o.op !== 'restore')
      .map((o) => {
        const recoverable = Boolean(o.recycledTo ?? o.backup) && existsSync(o.recycledTo ?? o.backup);
        return {
          receiptId: o.receiptId,
          op: o.op,
          target: o.target,
          at: o.at,
          toolCallId: o.toolCallId ?? null,
          recoverable,
          // Tombstone semantics: undo removes the target rather than copying.
          undoable: recoverable || o.op === 'create' || (o.op === 'write' && !o.backup),
        };
      });
  }

  #log(entry) {
    appendFileSync(this.opsLog, `${JSON.stringify({ ...entry, at: Date.now() })}\n`);
    if (this.onCheckpoint && entry.receiptId && entry.op !== 'purge') {
      try {
        this.onCheckpoint({ op: entry.op, target: entry.target, receiptId: entry.receiptId, toolCallId: entry.toolCallId ?? null });
      } catch { /* hook failures must never break the mutation path */ }
    }
  }
}
