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
import zlib from 'node:zlib';

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
/**
 * Magic-byte sniffing for inline payloads: the declared `mime` is client
 * input, the bytes are ground truth (competitor pit — a clipboard PNG marked
 * image/png carrying MZ/%PDF bytes must not reach the vision surface as an
 * "image"). Only reclassifies when the magic bytes are confidently known;
 * unknown bytes keep the declared mime.
 */
const MAGIC = [
  [Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'],
  [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg'],
  [Buffer.from('GIF8', 'latin1'), 'image/gif'],
  [Buffer.from('BM', 'latin1'), 'image/bmp'],
  [Buffer.from('%PDF', 'latin1'), 'application/pdf'],
  [Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/zip'],
  [Buffer.from('MZ', 'latin1'), 'application/x-msdownload'],
];
export function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  // RIFF container disambiguates at bytes 8-12 (WEBP vs WAVE/AVI)
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF'
      && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  for (const [magic, mime] of MAGIC) {
    if (buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic)) return mime;
  }
  return null;
}

/**
 * Clipboard BMP→PNG normalization (competitor pit: vision providers reject
 * image/bmp; a pasted screenshot arrives as BMP). Uncompressed 24/32-bit
 * BI_RGB only — anything else returns null and stays an honest descriptor.
 */
export function bmpToPng(buf) {
  if (!buf || buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  const dataOff = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  const hRaw = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const comp = buf.readUInt32LE(30);
  if (comp !== 0 || (bpp !== 24 && bpp !== 32) || w <= 0 || hRaw === 0) return null;
  const h = Math.abs(hRaw);
  const topDown = hRaw < 0;
  const srcBpp = bpp / 8;
  const rowStride = Math.ceil((w * srcBpp) / 4) * 4;
  if (dataOff + rowStride * h > buf.length) return null;
  const raw = Buffer.alloc((w * 4 + 1) * h); // RGBA + filter byte per row
  for (let y = 0; y < h; y++) {
    const srcY = topDown ? y : h - 1 - y;
    const so = dataOff + srcY * rowStride;
    const do_ = y * (w * 4 + 1);
    raw[do_] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const s = so + x * srcBpp;
      const d = do_ + 1 + x * 4;
      raw[d] = buf[s + 2]; raw[d + 1] = buf[s + 1]; raw[d + 2] = buf[s]; // BGR(A)→RGBA
      raw[d + 3] = bpp === 32 ? buf[s + 3] : 255;
    }
  }
  const { deflateSync } = zlib;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function normalizeAttachment(a) {
  if (!a || typeof a !== 'object') return { ok: false, error: 'attachment must be an object' };
  let mime = a.mime ?? a.mimeType ?? 'application/octet-stream';
  let source = null;
  if (typeof a.data === 'string' && a.data.length) source = { type: 'inline', data: a.data };
  else if (typeof a.path === 'string' && a.path.length) source = { type: 'path', path: a.path };
  else if (typeof a.url === 'string' && a.url.length) source = { type: 'url', url: a.url };
  if (!source) return { ok: false, error: 'attachment needs data, path, or url' };
  if (source.type === 'inline') {
    // bytes win over the declared mime — a mislabeled clipboard drop must not
    // ride the vision surface under a fake image kind.
    let head = null;
    try { head = Buffer.from(a.data.slice(0, 64), 'base64'); } catch { head = null; }
    const sniffed = head && sniffMime(head);
    if (sniffed && kindOfMime(sniffed) !== kindOfMime(mime)) mime = sniffed;
    // clipboard BMP → PNG: vision providers reject image/bmp outright, so a
    // pasted screenshot must be normalized before it can ride natively.
    if (sniffed === 'image/bmp') {
      const full = Buffer.from(a.data, 'base64');
      const png = bmpToPng(full);
      if (png) { source = { type: 'inline', data: png.toString('base64') }; mime = 'image/png'; }
      else mime = 'image/bmp'; // honest: it stays a descriptor, never a fake
    }
  }
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
 * yield no extractable text return null and stay descriptors — a descriptor
 * is honest, a half-parse is not.
 * @returns {string|null} extracted text, or null when not extractable
 */
export function extractAttachmentText(a) {
  if (a.kind !== 'file') return null;
  const raw = readSource(a);
  if (raw == null) return null;
  if (/\.docx$/i.test(a.name) || a.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return extractDocx(raw);
  }
  if (/\.pdf$/i.test(a.name) || a.mime === 'application/pdf' || raw.subarray(0, 4).toString('latin1') === '%PDF') {
    return extractPdf(raw);
  }
  if (/\.ipynb$/i.test(a.name) || a.mime === 'application/x-ipynb+json') {
    return extractIpynb(raw.toString('utf-8'));
  }
  if (TEXT_MIME.test(a.mime) || /\.(md|markdown|txt|py|js|ts|jsx|tsx|json|ya?ml|toml|xml|html?|css|csv|rs|go|java|c|h|cpp|rb|sh|sql|log)$/i.test(a.name)) {
    return raw.toString('utf-8').slice(0, TEXT_EXTRACT_MAX);
  }
  return null;
}

function readSource(a) {
  try {
    if (a.source.type === 'inline') return Buffer.from(a.source.data, 'base64');
    if (a.source.type === 'path') return readFileSync(a.source.path);
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

const ZIP_INFLATE_CAP = 8 * 1024 * 1024;   // per-entry decompressed cap (zip-bomb fence)
const ZIP_ENTRIES_CAP = 512;
const PDF_STREAM_CAP = 4 * 1024 * 1024;    // per-stream decompressed cap

/**
 * Minimal zip central-directory reader — enough for OOXML (stored/deflate
 * entries only). Returns Map<name, Buffer> of inflated entries, or null when
 * the container is not a readable zip.
 */
function unzipEntries(buf) {
  try {
    // EOCD signature 0x06054b50 — scan the last 64KB (comment cap)
    const tail = Math.max(0, buf.length - 65558);
    let eocd = -1;
    for (let i = buf.length - 22; i >= tail; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = Math.min(buf.readUInt16LE(eocd + 10), ZIP_ENTRIES_CAP);
    let p = buf.readUInt32LE(eocd + 16);
    const out = new Map();
    for (let n = 0; n < count && p + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const uncompSize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const cmtLen = buf.readUInt16LE(p + 32);
      const lho = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf-8');
      p += 46 + nameLen + extraLen + cmtLen;
      if (uncompSize > ZIP_INFLATE_CAP || lho + 30 > buf.length) continue;
      const lhNameLen = buf.readUInt16LE(lho + 26);
      const lhExtraLen = buf.readUInt16LE(lho + 28);
      const dataStart = lho + 30 + lhNameLen + lhExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      let data = null;
      if (method === 0) data = comp;
      else if (method === 8) {
        data = zlib.inflateRawSync(comp, { maxOutputLength: ZIP_INFLATE_CAP });
      }
      if (data && !name.endsWith('/')) out.set(name, data);
    }
    return out;
  } catch { return null; }
}

/** docx = OOXML zip → word/document.xml → paragraph text. Null on failure. */
function extractDocx(buf) {
  const entries = unzipEntries(buf);
  const doc = entries?.get('word/document.xml');
  if (!doc) return null;
  const xml = doc.toString('utf-8');
  const text = xml
    .replace(/<w:tab\s[^>]*\/>/g, '\t')
    .replace(/<w:br\s[^>]*\/>|<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? text.slice(0, TEXT_EXTRACT_MAX) : null;
}

/**
 * Minimal PDF text pull: inflate each FlateDecode stream, collect text-show
 * operators inside BT/ET blocks. Encrypted/image-only/odd-encoding files
 * yield null → the caller keeps the honest descriptor.
 */
function extractPdf(buf) {
  const latin = buf.toString('latin1');
  let out = '';
  let pos = 0;
  while (out.length < TEXT_EXTRACT_MAX) {
    const s = latin.indexOf('stream', pos);
    if (s < 0) break;
    const e = latin.indexOf('endstream', s);
    if (e < 0) break;
    pos = e + 9;
    // stream data starts after EOL following the 'stream' keyword
    let start = s + 6;
    if (latin[start] === '\r' && latin[start + 1] === '\n') start += 2;
    else if (latin[start] === '\n' || latin[start] === '\r') start += 1;
    const raw = buf.subarray(start, e);
    let inflated = null;
    try { inflated = zlib.inflateSync(raw, { maxOutputLength: PDF_STREAM_CAP }); } catch { continue; }
    out += pdfTextOf(inflated);
  }
  const text = out.trim();
  return text ? text.slice(0, TEXT_EXTRACT_MAX) : null;
}

function pdfTextOf(stream) {
  const src = stream.toString('latin1');
  let out = '';
  const btEt = /BT([\s\S]*?)ET/g;
  let m;
  while ((m = btEt.exec(src))) {
    const block = m[1];
    const shown = [];
    // (str) Tj and [(a) 12 (b)] TJ
    const ops = /\((?:\\.|[^\\)])*\)\s*Tj|\[((?:\((?:\\.|[^\\)])*\)|[^\]])*)\]\s*TJ|T\*/g;
    let o;
    while ((o = ops.exec(block))) {
      if (o[0] === 'T*') { shown.push('\n'); continue; }
      const piece = o[1] != null ? o[1].match(/\((?:\\.|[^\\)])*\)/g) : [o[0]];
      for (const lit of piece ?? []) {
        shown.push(pdfUnescape(lit.slice(1, lit.lastIndexOf(')') > 0 ? lit.lastIndexOf(')') : lit.length - 1)));
      }
      shown.push(' ');
    }
    if (shown.length) out += shown.join('') + '\n';
  }
  return out;
}

function pdfUnescape(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => {
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }[c];
    if (simple != null) return simple;
    return String.fromCharCode(parseInt(c, 8) & 0xff);
  });
}
