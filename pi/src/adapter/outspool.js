/**
 * M38 large-output externalization — when a tool result text block exceeds
 * the byte threshold, the full output is spooled to <instance>/spool/ and the
 * model sees a placeholder with a stable id instead of a wall of bytes.
 * Retrieval is a first-class tool (output_read) so the model can page back
 * the slices it actually needs — Cline/Aider "output too large, here's the
 * handle" analogue, not a silent truncation.
 *
 * Two surfaces:
 *  - OutputSpool        — bounded FIFO store (cap files, oldest evicted)
 *  - outputSpoolExtension — tool_result seam that swaps oversized text blocks
 *                           for placeholders (returns ToolResultEventResult)
 *  - outputReadTool     — model-facing slice reader
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_THRESHOLD = 64 * 1024; // bytes — above this a text block externalizes
const SPOOL_CAP = 50;                // retained files; oldest evicted first
const HEAD_BYTES = 2048;             // preview kept inline in the placeholder
const READ_CAP = 32 * 1024;          // max bytes per output_read slice

export class OutputSpool {
  constructor(dir, { cap = SPOOL_CAP } = {}) {
    this.dir = dir;
    this.cap = cap;
    mkdirSync(dir, { recursive: true });
  }

  /** Persist a full output blob; returns {id, bytes, path}. */
  store(text, { toolName = 'unknown', toolCallId = null } = {}) {
    const id = `out-${randomUUID().slice(0, 12)}`;
    const file = join(this.dir, `${id}.txt`);
    const header = `# tool=${toolName} call=${toolCallId ?? '-'} at=${new Date().toISOString()}\n`;
    writeFileSync(file, header + text);
    this.#evict();
    return { id, bytes: Buffer.byteLength(text), file };
  }

  /** Byte-windowed read — offset/limit in characters of the stored payload. */
  read(id, { offset = 0, limit = READ_CAP } = {}) {
    const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
    const file = join(this.dir, `${safe}.txt`);
    if (!existsSync(file)) throw new Error(`no spooled output '${safe}' — it may have been evicted (cap ${this.cap})`);
    const raw = readFileSync(file, 'utf-8');
    const payload = raw.slice(raw.indexOf('\n') + 1); // strip the metadata header line
    const start = Math.max(0, Number(offset) || 0);
    const len = Math.min(Math.max(1, Number(limit) || READ_CAP), READ_CAP);
    return {
      id: safe,
      offset: start,
      totalChars: payload.length,
      text: payload.slice(start, start + len),
      remaining: Math.max(0, payload.length - (start + len)),
    };
  }

  list() {
    return readdirSync(this.dir).filter((f) => f.endsWith('.txt'))
      .map((f) => ({ id: f.slice(0, -4), bytes: statSync(join(this.dir, f)).size }))
      .sort((a, b) => b.bytes - a.bytes);
  }

  #evict() {
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.txt'))
      .map((f) => join(this.dir, f))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
    for (const f of files.slice(0, Math.max(0, files.length - this.cap))) {
      try { unlinkSync(f); } catch { /* eviction best-effort */ }
    }
  }
}

/** tool_result seam: oversized text blocks → spool + placeholder swap. */
export function outputSpoolExtension({ spool, audit = null, thresholdBytes = DEFAULT_THRESHOLD }) {
  return {
    name: 'pai-output-spool',
    factory: (pi) => {
      pi.on('tool_result', (event) => {
        const content = event?.content;
        if (!Array.isArray(content)) return undefined;
        let changed = false;
        const next = content.map((c) => {
          if (c?.type !== 'text' || typeof c.text !== 'string' || Buffer.byteLength(c.text) <= thresholdBytes) return c;
          const rec = spool.store(c.text, { toolName: event.toolName, toolCallId: event.toolCallId });
          changed = true;
          audit?.write({ kind: 'OUTPUT_SPOOL', toolName: event.toolName ?? null, data: { id: rec.id, bytes: rec.bytes } });
          return {
            type: 'text',
            text: `[large output externalized — ${rec.bytes} bytes exceeded the ${thresholdBytes}-byte inline cap]\n` +
              `handle: ${rec.id} (tool: ${event.toolName ?? 'unknown'})\n` +
              `retrieve with output_read(id="${rec.id}", offset, limit) — the full text is on disk, not lost.\n` +
              `--- head ---\n${c.text.slice(0, HEAD_BYTES)}`,
          };
        });
        return changed ? { content: next } : undefined;
      });
    },
  };
}

/** Model-facing paged reader for spooled outputs. */
export function outputReadTool(spool) {
  return {
    name: 'output_read', label: 'Output Read',
    description:
      'Read a slice of a tool output that was externalized for size (the result ' +
      'placeholder carries its `handle`). Params: id, offset (char index), ' +
      'limit (chars, max 32768).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'spool handle from the externalized-output placeholder' },
        offset: { type: 'number', description: 'char offset into the stored output (default 0)' },
        limit: { type: 'number', description: 'chars to return (default/max 32768)' },
      },
      required: ['id'],
    },
    promptSnippet: 'output_read(id, offset, limit): page back an externalized tool output',
    async execute(_id, params) {
      try {
        const r = spool.read(String(params.id ?? ''), { offset: params.offset, limit: params.limit });
        return {
          content: [{ type: 'text', text: `${r.text}\n\n[${r.offset + r.text.length}/${r.totalChars} chars — ${r.remaining} remaining]` }],
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `output_read failed: ${e.message}` }], isError: true };
      }
    },
  };
}
