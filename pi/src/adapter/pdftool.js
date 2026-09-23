/**
 * pdf_read — dedup-h #560 first-class pdf tool (OpenClaw Tools/PDF analysis
 * analogue, honest slice): the pinned engine carries text|image content only —
 * no document/PDF content block exists to send bytes provider-natively — so
 * extraction is the universal carrier, not a degraded one. The model invokes
 * this tool on a path-confined PDF; text is pulled by the zero-dependency
 * extractor in host/core/attachments.js.
 *
 * Configurable defaults (agents.defaults.pdf* analogue) live in
 * <instance>/pdf.json:
 *   { "maxBytesMb": 10, "maxPages": 50 }
 * A MALFORMED pdf.json fails closed — the tool refuses rather than running
 * unbounded. Per-call max_bytes_mb/max_pages may only TIGHTEN the caps.
 *
 * pdfModel analogue: feature-models.json "pdf" names the analysis model. When
 * `question` is given and that entry exists, the extracted text is analyzed by
 * the routed model and the answer is returned; without the entry the text is
 * returned for the calling model to analyze — honest fallback, never a fake.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { extractAttachmentText, sniffMime } from '../../../host/src/core/attachments.js';

const DEFAULT_MAX_BYTES_MB = 10;
const DEFAULT_MAX_PAGES = 50;

function loadPdfConfig(instanceRoot) {
  if (!instanceRoot) return { ok: true, config: {} };
  const p = `${instanceRoot}${sep}pdf.json`;
  if (!existsSync(p)) return { ok: true, config: {} };
  try {
    const doc = JSON.parse(readFileSync(p, 'utf-8'));
    if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false };
    return { ok: true, config: doc };
  } catch { return { ok: false }; }
}

/** Count `/Type /Page` objects — heuristic page bound for a zero-dep reader. */
function pdfPageCount(buf) {
  const m = buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 0;
}

export function pdfTool({ workdir, instanceRoot, analyze }) {
  return {
    name: 'pdf_read',
    label: 'Read PDF',
    description:
      'Read a PDF file inside the workdir. Extracts the document text; with `question`, ' +
      'the extracted text is analyzed by the configured pdf feature model when one is ' +
      'set, otherwise returned for you to analyze. Bounds: instance pdf.json ' +
      '{maxBytesMb, maxPages} — oversized or over-long PDFs refuse honestly.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'PDF path, relative to the workdir (or absolute inside it)' },
        question: { type: 'string', description: 'optional analysis question answered over the extracted text' },
        max_pages: { type: 'integer', description: 'tighten the page cap for this call only' },
        max_bytes_mb: { type: 'number', description: 'tighten the size cap for this call only' },
      },
      required: ['path'],
    },
    async execute(_id, p) {
      const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
      const raw = String(p?.path ?? '').trim();
      if (!raw) return err('pdf_read requires a path');
      const abs = isAbsolute(raw) ? resolve(raw) : resolve(workdir, raw);
      const rel = abs.startsWith(workdir + sep) ? abs.slice(workdir.length + 1) : null;
      if (rel == null || rel.startsWith('..')) return err(`pdf_read path must stay inside the workdir: ${raw}`);
      if (!existsSync(abs)) return err(`pdf not found: ${rel}`);
      const cfg = loadPdfConfig(instanceRoot);
      if (!cfg.ok) return err('pdf.json is malformed — refusing rather than running unbounded (fix or remove it)');
      const maxBytesMb = Math.min(cfg.config.maxBytesMb ?? DEFAULT_MAX_BYTES_MB,
        Number.isFinite(p?.max_bytes_mb) ? p.max_bytes_mb : Infinity);
      const maxPages = Math.min(cfg.config.maxPages ?? DEFAULT_MAX_PAGES,
        Number.isInteger(p?.max_pages) ? p.max_pages : Infinity);
      const st = statSync(abs);
      if (st.size > maxBytesMb * 1024 * 1024) {
        return err(`pdf exceeds the size cap: ${(st.size / 1048576).toFixed(1)}MB > ${maxBytesMb}MB`);
      }
      const buf = readFileSync(abs);
      if (sniffMime(buf) !== 'application/pdf' && !/\.pdf$/i.test(abs)) {
        return err(`not a PDF (no %PDF magic, no .pdf extension): ${rel}`);
      }
      const pages = pdfPageCount(buf);
      if (pages > maxPages) return err(`pdf exceeds the page cap: ${pages} pages > ${maxPages}`);
      const text = extractAttachmentText({
        kind: 'file', name: basename(abs), mime: 'application/pdf',
        bytes: st.size, source: { type: 'path', path: abs },
      });
      if (text == null) {
        return err(`no extractable text in ${rel} (encrypted, image-only, or non-standard encoding — try OCR externally)`);
      }
      const q = String(p?.question ?? '').trim();
      if (q && typeof analyze === 'function') {
        const answer = await analyze(
          'You are analyzing a PDF document. Answer the question using ONLY the extracted text. ' +
          'If the text does not contain the answer, say so — never invent content.',
          `<pdf name="${basename(abs)}" pages="${pages}">\n${text}\n</pdf>\n\nQuestion: ${q}`,
        );
        if (answer != null) {
          return { content: [{ type: 'text', text: answer }] };
        }
        // no pdf feature model configured / unreachable → fall through to raw
        // text so the CALLING model analyzes — honest, never a fabricated answer
      }
      const note = q ? '[no pdf feature model configured — analyze this text yourself]\n\n' : '';
      return { content: [{ type: 'text', text: `${note}${text}` }] };
    },
  };
}
