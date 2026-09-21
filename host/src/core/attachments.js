/**
 * U5 MediaAttachment foundation — the typed, body-neutral representation for
 * things users attach to a prompt that are not the prompt text.
 *
 * Scope is deliberately a FOUNDATION: this module classifies, validates and
 * normalizes attachments into one canonical shape; each body then maps what
 * it can actually carry (pi: images → ImageContent; everything else → a
 * truthful text descriptor). No fake capability: a body that cannot see
 * audio gets a reference block, not a pretend-transcription.
 *
 * Canonical shape:
 *   { kind: 'image'|'audio'|'video'|'file',
 *     name: string, mime: string, bytes: number,
 *     source: { type: 'inline', data: <base64> } | { type: 'path', path } | { type: 'url', url } }
 */
import { readFileSync } from 'node:fs';

const KIND_PREFIX = {
  image: 'image/',
  audio: 'audio/',
  video: 'video/',
};
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // per-attachment ceiling

export function kindOfMime(mime = '') {
  for (const [kind, prefix] of Object.entries(KIND_PREFIX)) {
    if (mime.startsWith(prefix)) return kind;
  }
  return 'file';
}

/**
 * Normalize one caller-supplied attachment into the canonical shape.
 * @param {object} a {name?, mime?, mimeType?, data?, path?, url?, bytes?}
 * @returns {{ok:true, attachment:object}|{ok:false, error:string}}
 */
export function normalizeAttachment(a) {
  if (!a || typeof a !== 'object') return { ok: false, error: 'attachment must be an object' };
  const mime = a.mime ?? a.mimeType ?? 'application/octet-stream';
  let source = null;
  if (typeof a.data === 'string' && a.data.length) source = { type: 'inline', data: a.data };
  else if (typeof a.path === 'string' && a.path.length) source = { type: 'path', path: a.path };
  else if (typeof a.url === 'string' && a.url.length) source = { type: 'url', url: a.url };
  if (!source) return { ok: false, error: 'attachment needs data, path, or url' };
  const bytes = a.bytes ?? (source.type === 'inline' ? Buffer.byteLength(source.data, 'base64') : 0);
  if (bytes > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: `attachment '${a.name ?? '?'}' exceeds ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB` };
  }
  return {
    ok: true,
    attachment: {
      kind: kindOfMime(mime),
      name: String(a.name ?? 'attachment').slice(0, 200),
      mime,
      bytes,
      source,
    },
  };
}

/**
 * Normalize a list; drops invalid entries into `rejected` rather than failing
 * the whole prompt (a bad chip must not eat the message).
 * @returns {{attachments: object[], rejected: string[]}}
 */
export function normalizeAttachments(list = []) {
  const attachments = [];
  const rejected = [];
  for (const a of list ?? []) {
    const r = normalizeAttachment(a);
    if (r.ok) attachments.push(r.attachment);
    else rejected.push(r.error);
  }
  return { attachments, rejected };
}

/**
 * Split normalized attachments into what a body can carry natively vs what
 * must degrade to a text descriptor.
 * @param {object[]} attachments
 * @param {object} caps e.g. {images: true} — pi's native carry set
 * @returns {{native: object[], degraded: object[]}}
 */
export function partitionByCapability(attachments, caps = {}) {
  const native = [];
  const degraded = [];
  for (const a of attachments) {
    (a.kind === 'image' && caps.images ? native : degraded).push(a);
  }
  return { native, degraded };
}

/** Truthful text reference for a degraded attachment — the model sees what it is, not a fake. */
export function describeAttachment(a) {
  return `<attachment kind="${a.kind}" name="${a.name}" mime="${a.mime}" bytes="${a.bytes}"/>`;
}

const TEXT_EXTRACT_MAX = 24 * 1024;
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|toml))/i;

/**
 * Best-effort text extraction for file-kind attachments (ZCode PDF/ipynb
 * analogue — the zero-dependency slice): formats we can read honestly are
 * inlined so the model gets CONTENT, not just a reference tag. Formats that
 * need a real parser (pdf/docx/xlsx) return null and stay descriptors — a
 * descriptor is honest, a half-parse is not.
 * @returns {string|null} extracted text, or null when not extractable
 */
export function extractAttachmentText(a) {
  if (a.kind !== 'file') return null;
  const raw = readSource(a);
  if (raw == null) return null;
  if (/\.ipynb$/i.test(a.name) || a.mime === 'application/x-ipynb+json') {
    return extractIpynb(raw);
  }
  if (TEXT_MIME.test(a.mime) || /\.(md|markdown|txt|py|js|ts|jsx|tsx|json|ya?ml|toml|xml|html?|css|csv|rs|go|java|c|h|cpp|rb|sh|sql|log)$/i.test(a.name)) {
    return raw.slice(0, TEXT_EXTRACT_MAX);
  }
  return null;
}

function readSource(a) {
  try {
    if (a.source.type === 'inline') return Buffer.from(a.source.data, 'base64').toString('utf-8');
    if (a.source.type === 'path') return readFileSync(a.source.path, 'utf-8');
  } catch { /* unreadable source → no extraction */ }
  return null;
}

/** Render notebook cells as readable text — code/markdown + truncated outputs. */
function extractIpynb(raw) {
  try {
    const nb = JSON.parse(raw);
    if (!Array.isArray(nb.cells)) return null;
    let out = '';
    for (const [i, c] of nb.cells.entries()) {
      const src = Array.isArray(c.source) ? c.source.join('') : (c.source ?? '');
      out += `\n### cell ${i} [${c.cell_type ?? '?'}]\n${src}\n`;
      for (const o of c.outputs ?? []) {
        const t = Array.isArray(o.text) ? o.text.join('') : (o.text ?? o.data?.['text/plain']);
        if (t) out += `  out: ${String(Array.isArray(t) ? t.join('') : t).slice(0, 500)}\n`;
      }
      if (out.length >= TEXT_EXTRACT_MAX) return out.slice(0, TEXT_EXTRACT_MAX);
    }
    return out.slice(0, TEXT_EXTRACT_MAX) || null;
  } catch { return null; }
}
