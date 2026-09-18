import { isLongRunningCommand } from '../adapter/jobs.js';
import { hashOf } from '../../../host/src/core/audit.js';

const FILE_MUTATION_TOOLS = new Set(['write', 'edit', 'delete']);
const MUTATING_RISK = new Set(['mutating', 'destructive', 'exec', 'unknown']);

/**
 * The post-kernel decide chain used by the real composite guard. Extracted so
 * tests can drive it directly instead of treating production wiring as
 * untestable internals.
 *
 * Order: kernel deny (terminate → deny→hide) → workspace write-lease mutex
 * (foreground mutation vs held job lease) → FileOpsGuard (backup/recycle)
 * → long-command jobization → admit.
 */
export function makeDecide({ core, executor, fileOps, getSurface, workdir, writeLease = null, classifier = null, getSessionScope = null }) {
  return async (ctx, signal) => {
    const toolName = ctx.toolCall?.name ?? ctx.toolName;
    // signal rides on ctx so the kernel's ask path can abort a pending
    // operator question when the session is interrupted mid-decision
    const decision = await core.kernel.decideToolCall({ ...ctx, toolName, signal });
    if (decision) {
      // terminate-level denial also removes the tool from the visible
      // surface (deny→hide) so the model stops retrying it — persisted.
      if (decision.terminate) getSurface()?.deny(toolName);
      return decision; // kernel denied — done
    }
    // kernel admitted: long-running commands become durable jobs FIRST —
    // the job acquires its own `job:` write lease, so this path must run
    // before the foreground lease is taken (no fg→job lock handoff).
    const command = ctx.args?.command;
    if (typeof command === 'string' && isLongRunningCommand(command)) {
      const r = await executor.spawnCommandJob({
        command,
        workdir,
        jobType: 'shell_command',
        budgetScope: getSessionScope?.(),
      });
      if (r.refused) {
        return { block: true, rule: 'workspace_lease', reason: `durable job refused: ${r.reason}` };
      }
      return {
        block: true,
        reason:
          `long-running command converted to durable job ${r.job_id} ` +
          `(attempt ${r.attempt_id}) — it survives restarts; poll job_status`,
      };
    }
    // kernel admitted — a mutating call must HOLD the workspace write lease
    // through execution (not just check it): acquire is atomic check-and-set,
    // released by the afterToolCall hook on tool_execution_end. File tools are
    // mutating by name; shell commands are re-classified here (the kernel's
    // parse stays internal to its decision, and re-parsing is cheap and
    // deterministic).
    const commandForLease = ctx.args?.command;
    let mutating = FILE_MUTATION_TOOLS.has(toolName);
    if (!mutating && typeof commandForLease === 'string' && classifier) {
      try {
        const parsed = await classifier(commandForLease);
        // Deny provably-mutating commands plus unrecognized commands that carry
        // shell write syntax (redirects) — the residual hole the classifier
        // cannot see. Unknown commands without write syntax are read-capable,
        // matching the trust level the kernel already grants them.
        mutating = MUTATING_RISK.has(parsed.risk)
          || (parsed.hasUnknown === true && />>?/.test(commandForLease));
      } catch { mutating = true; }
    }
    const fgHolder = `fg:${ctx.toolCall?.id ?? 'unknown'}`;
    let fgHeld = false;
    if (mutating && writeLease) {
      const acq = writeLease.acquire(fgHolder, { tool: toolName });
      if (!acq.ok) {
        core.audit.write({
          kind: 'WORKSPACE_LEASE_DENIED', toolName,
          data: { heldBy: acq.heldBy.holder, fg: fgHolder, reason: 'foreground mutation refused while the workspace write lease is held' },
        });
        return {
          block: true,
          rule: 'workspace_lease',
          reason: `workspace is write-locked by '${acq.heldBy.holder}' — wait for it to finish (job_status), or release via the operator`,
          repair: 'poll job_status and retry after the holder exits',
        };
      }
      fgHeld = true;
    }
    // file mutations route through FileOpsGuard — write/edit get a
    // pre-execution byte backup, delete is performed as a recoverable recycle
    // instead of letting the call destroy bytes.
    const filePath = ctx.args?.path ?? ctx.args?.file ?? ctx.args?.target;
    if (typeof filePath === 'string' && FILE_MUTATION_TOOLS.has(toolName)) {
      if (toolName === 'delete') {
        try {
          const { recycled, receiptId } = await fileOps.delete(filePath);
          core.audit.write({ kind: 'FILEOP_RECYCLE', toolName, data: { receiptId, pathHash: hashOf(filePath) } });
          // the mutation already happened synchronously under the lease —
          // release now; there is no real tool execution to cover.
          if (fgHeld) writeLease.release(fgHolder);
          return {
            block: true,
            reason: `moved to recycle instead of destroying: ${recycled} (receipt ${receiptId} — recoverable via fileops restore)`,
          };
        } catch {
          if (fgHeld) { writeLease.release(fgHolder); fgHeld = false; }
          // target already gone — let the tool report it
        }
      } else {
        const { backup, receiptId } = await fileOps.backup(filePath);
        if (backup) {
          core.audit.write({ kind: 'FILEOP_BACKUP', toolName, data: { receiptId, pathHash: hashOf(filePath) } });
        } else if (receiptId) {
          core.audit.write({ kind: 'FILEOP_CREATE_TOMBSTONE', toolName, data: { receiptId, pathHash: hashOf(filePath) } });
        }
      }
    }
    return undefined;
  };
}
