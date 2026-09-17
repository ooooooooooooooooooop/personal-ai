import { isLongRunningCommand } from '../adapter/jobs.js';
import { hashOf } from '../../../host/src/core/audit.js';

const FILE_MUTATION_TOOLS = new Set(['write', 'edit', 'delete']);

/**
 * The post-kernel decide chain used by the real composite guard. Extracted so
 * tests can drive it directly instead of treating production wiring as
 * untestable internals.
 *
 * Order: kernel deny (terminate → deny→hide) → FileOpsGuard (backup/recycle)
 * → long-command jobization → admit.
 */
export function makeDecide({ core, executor, fileOps, getSurface, workdir }) {
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
    // kernel admitted: file mutations route through FileOpsGuard —
    // write/edit get a pre-execution byte backup, delete is performed as a
    // recoverable recycle instead of letting the call destroy bytes.
    const filePath = ctx.args?.path ?? ctx.args?.file ?? ctx.args?.target;
    if (typeof filePath === 'string' && FILE_MUTATION_TOOLS.has(toolName)) {
      if (toolName === 'delete') {
        try {
          const { recycled, receiptId } = await fileOps.delete(filePath);
          core.audit.write({ kind: 'FILEOP_RECYCLE', toolName, data: { receiptId, pathHash: hashOf(filePath) } });
          return {
            block: true,
            reason: `moved to recycle instead of destroying: ${recycled} (receipt ${receiptId} — recoverable via fileops restore)`,
          };
        } catch {
          // target already gone — let the tool report it
        }
      } else {
        const { backup, receiptId } = await fileOps.backup(filePath);
        if (backup) {
          core.audit.write({ kind: 'FILEOP_BACKUP', toolName, data: { receiptId, pathHash: hashOf(filePath) } });
        }
      }
    }
    // kernel admitted: long-running commands become durable jobs instead of
    // blocking the session — the sync call is refused with the job id so the
    // model can poll job_status (Devin/Crush background-command pattern)
    const command = ctx.args?.command;
    if (typeof command === 'string' && isLongRunningCommand(command)) {
      const { job_id, attempt_id } = executor.spawnCommandJob({
        command,
        workdir,
        jobType: 'shell_command',
      });
      return {
        block: true,
        reason:
          `long-running command converted to durable job ${job_id} ` +
          `(attempt ${attempt_id}) — it survives restarts; poll job_status`,
      };
    }
    return undefined;
  };
}
