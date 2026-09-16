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

  /** Restore the most recent backup/recycled copy of a path. */
  restore(receiptId) {
    const ops = this.#ops().filter((o) => o.receiptId === receiptId);
    const op = ops.at(-1);
    if (!op) throw new Error(`no fileops receipt ${receiptId}`);
    const source = op.recycledTo ?? op.backup;
    if (!source || !existsSync(source)) throw new Error(`receipt ${receiptId} has no recoverable artifact`);
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

  #log(entry) {
    appendFileSync(this.opsLog, `${JSON.stringify({ ...entry, at: Date.now() })}\n`);
  }
}
