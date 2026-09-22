/**
 * multi_edit — M143 multi-region/multi-file edit (batch edit analogue).
 *
 * One call carries several {path, old_string, new_string, replace_all?}
 * edits spanning one or many files. Semantics are all-or-nothing:
 *
 *  1. PREFLIGHT — every edit is validated before any byte is written:
 *     path must stay inside the workdir, must not be .paiignore-excluded,
 *     must exist, and its old_string must match (uniquely unless
 *     replace_all). A single failure refuses the WHOLE batch — the model
 *     gets the full failure list back, not a half-applied workspace.
 *  2. APPLY — edits are grouped per file and each file is rewritten once
 *     through FileOpsGuard.write(), so every touched file gets its own
 *     byte backup + receipt under the same toolCallId — the batch is
 *     undoable as a unit via fileops undoCall.
 *  3. MID-APPLY FAILURE — already-written files are restored from their
 *     receipts (best effort) and the failure is reported honestly.
 *
 * The decide chain treats this name as file-mutating (write lease + secret
 * scan over edits[].new_string); path-level policy is re-checked here per
 * edit because the kernel only sees the batched args.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
const ok = (text, details) => ({ content: [{ type: 'text', text }], details });

const MAX_EDITS = 64;
const MAX_FIELD = 256 * 1024;

export function multiEditTool({ workdir, fileOps, getIgnored = null }) {
  const root = resolve(workdir);
  const inside = (abs) => abs === root || abs.startsWith(root + sep);
  return {
    name: 'multi_edit',
    label: 'Multi Edit',
    description:
      'Apply several exact-match edits across one or more files atomically. ' +
      'Every edit is preflighted first — if any path is missing, ignored, ' +
      'outside the workdir, or its old_string does not match uniquely, the ' +
      'WHOLE batch is refused and nothing is written. All applied files get ' +
      'a fileops backup receipt under this call (batch-undoable).',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              old_string: { type: 'string' },
              new_string: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['path', 'old_string', 'new_string'],
          },
        },
      },
      required: ['edits'],
    },
    async execute(toolCallId, params) {
      const edits = params?.edits;
      if (!Array.isArray(edits) || edits.length === 0) return err('multi_edit requires a non-empty edits[] array');
      if (edits.length > MAX_EDITS) return err(`multi_edit refuses ${edits.length} edits (cap ${MAX_EDITS}) — split into smaller batches`);

      // --- preflight: validate everything, write nothing ---
      const failures = [];
      const perFile = new Map(); // abs → [{old_string,new_string,replace_all}]
      edits.forEach((e, i) => {
        const tag = `edits[${i}]`;
        if (!e || typeof e !== 'object') { failures.push(`${tag}: not an object`); return; }
        const p = e.path;
        if (typeof p !== 'string' || !p.trim()) { failures.push(`${tag}: missing path`); return; }
        const abs = resolve(root, p);
        if (!inside(abs)) { failures.push(`${tag}: '${p}' resolves outside the workdir`); return; }
        if (getIgnored?.(p)) { failures.push(`${tag}: '${p}' is excluded by .paiignore`); return; }
        if (!existsSync(abs)) { failures.push(`${tag}: '${p}' does not exist`); return; }
        if (typeof e.old_string !== 'string' || e.old_string === '') { failures.push(`${tag}: missing old_string`); return; }
        if (typeof e.new_string !== 'string') { failures.push(`${tag}: missing new_string`); return; }
        if (e.old_string.length > MAX_FIELD || e.new_string.length > MAX_FIELD) {
          failures.push(`${tag}: field exceeds ${MAX_FIELD} chars`); return;
        }
        const current = readFileSync(abs, 'utf-8');
        const hits = current.split(e.old_string).length - 1;
        if (hits === 0) { failures.push(`${tag}: old_string not found in '${p}'`); return; }
        if (hits > 1 && !e.replace_all) {
          failures.push(`${tag}: old_string matches ${hits} locations in '${p}' — pass replace_all:true or make it unique`);
          return;
        }
        if (!perFile.has(abs)) perFile.set(abs, { rel: p, edits: [] });
        perFile.get(abs).edits.push(e);
      });
      if (failures.length) {
        return err(`multi_edit refused — nothing was written:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
      }

      // --- apply: one fileOps.write per file; mid-apply failure rolls back ---
      const receipts = [];
      const results = [];
      for (const [abs, { rel, edits: fileEdits }] of perFile) {
        let content = readFileSync(abs, 'utf-8');
        let count = 0;
        for (const e of fileEdits) {
          const n = content.split(e.old_string).length - 1;
          if (n === 0 || (n > 1 && !e.replace_all)) {
            // preflight passed but bytes moved under us — fail honestly
            return err(`multi_edit: '${rel}' changed between preflight and apply — re-read and retry`);
          }
          content = e.replace_all ? content.split(e.old_string).join(e.new_string) : content.replace(e.old_string, e.new_string);
          count += n;
        }
        try {
          const { receiptId } = await fileOps.write(abs, content, { toolCallId });
          receipts.push(receiptId);
          results.push({ path: rel, edits: fileEdits.length, replacements: count, receiptId });
        } catch (e2) {
          // best-effort rollback of files already written this call
          const rolledBack = [];
          for (const rid of receipts) {
            try { rolledBack.push(fileOps.restore(rid)); } catch { /* report, don't mask the original failure */ }
          }
          return err(`multi_edit failed writing '${rel}': ${e2?.message ?? e2}` +
            (rolledBack.length ? ` — rolled back ${rolledBack.length} earlier file(s)` : ''));
        }
      }
      return ok(
        `multi_edit applied ${edits.length} edit(s) across ${perFile.size} file(s) ` +
        `(receipts ${receipts.join(', ')} — batch-undoable via fileops undo of this call)\n` +
        results.map((r) => `  - ${r.path}: ${r.replacements} replacement(s)`).join('\n'),
        { files: results },
      );
    },
  };
}
