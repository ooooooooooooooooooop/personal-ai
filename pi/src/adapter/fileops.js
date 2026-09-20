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
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { unifiedDiff } from '../../../host/src/core/diffutil.js';
import { createHash, randomUUID } from 'node:crypto';

export class FileOpsGuard {
  /**
   * @param {string} instanceRoot — recycle/ backups/ ops-log live here
   */
  constructor(instanceRoot) {
    this.root = instanceRoot;
    this.recycleDir = join(instanceRoot, 'recycle');
    this.backupDir = join(instanceRoot, 'backups');
    this.opsLog = join(instanceRoot, 'fileops.jsonl');
    for (const d of [this.recycleDir, this.backupDir]) mkdirSync(d, { recursive: true });
  }

  /**
   * Recoverable delete: move the target into the recycle bin.
   * @returns {Promise<{recycled:string, receiptId:string}>}
   */
  async delete(targetPath) {
    const abs = resolve(targetPath);
    return withFileMutationQueue(abs, async () => {
      if (!existsSync(abs)) throw new Error(`delete target missing: ${abs}`);
      const receiptId = `fo-${randomUUID().slice(0, 8)}`;
      const dest = join(this.recycleDir, `${Date.now()}-${basename(abs)}`);
      renameSync(abs, dest);
      this.#log({ receiptId, op: 'delete', target: abs, recycledTo: dest });
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
  async backup(targetPath) {
    const abs = resolve(targetPath);
    return withFileMutationQueue(abs, async () => {
      const receiptId = `fo-${randomUUID().slice(0, 8)}`;
      if (!existsSync(abs)) {
        this.#log({ receiptId, op: 'create', target: abs, backup: null, preSha: null });
        return { backup: null, receiptId };
      }
      const preSha = createHash('sha256').update(readFileSync(abs)).digest('hex');
      const backup = join(this.backupDir, `${Date.now()}-${basename(abs)}`);
      copyFileSync(abs, backup);
      this.#log({ receiptId, op: 'backup', target: abs, backup, preSha });
      return { backup, receiptId };
    });
  }

  /**
   * Backup-then-write: existing targets are byte-copied to backups/ first.
   * @returns {Promise<{backup:string|null, receiptId:string}>}
   */
  async write(targetPath, content) {
    const abs = resolve(targetPath);
    return withFileMutationQueue(abs, async () => {
      const receiptId = `fo-${randomUUID().slice(0, 8)}`;
      let backup = null;
      let preSha = null;
      if (existsSync(abs)) {
        preSha = createHash('sha256').update(readFileSync(abs)).digest('hex');
        backup = join(this.backupDir, `${Date.now()}-${basename(abs)}`);
        copyFileSync(abs, backup);
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      this.#log({ receiptId, op: 'write', target: abs, backup, preSha });
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
        const dest = join(this.recycleDir, `${Date.now()}-${basename(op.target)}`);
        renameSync(op.target, dest);
        this.#log({ receiptId: `fo-${randomUUID().slice(0, 8)}`, op: 'restore', target: op.target, removedTo: dest });
      }
      return op.target;
    }
    if (!existsSync(source)) throw new Error(`receipt ${receiptId} has no recoverable artifact`);
    // ZCode safety-checkpoint semantics: never clobber the current file —
    // if bytes exist at the target now (agent edits or external changes),
    // they are recycled before the overwrite, so a restore is itself
    // recoverable instead of destroying un-receipted work.
    if (existsSync(op.target)) {
      const dest = join(this.recycleDir, `${Date.now()}-${basename(op.target)}`);
      renameSync(op.target, dest);
      this.#log({ receiptId: `fo-${randomUUID().slice(0, 8)}`, op: 'restore-displace', target: op.target, removedTo: dest });
    }
    copyFileSync(source, op.target);
    this.#log({ receiptId: `fo-${randomUUID().slice(0, 8)}`, op: 'restore', target: op.target, from: source });
    return op.target;
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
    return readFileSync(this.opsLog, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
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
          recoverable,
          // Tombstone semantics: undo removes the target rather than copying.
          undoable: recoverable || o.op === 'create' || (o.op === 'write' && !o.backup),
        };
      });
  }

  #log(entry) {
    appendFileSync(this.opsLog, `${JSON.stringify({ ...entry, at: Date.now() })}\n`);
  }
}
