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
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
  [Buffer.from('II*\0', 'latin1'), 'image/tiff'],
  [Buffer.from('MM\0*', 'latin1'), 'image/tiff'],
  [Buffer.from([0x00, 0x00, 0x01, 0x00]), 'image/x-icon'],
];
export function sniffMime(buf) {
  if (!buf || buf.length < 4) return null;
  // RIFF container disambiguates at bytes 8-12 (WEBP vs WAVE/AVI)
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF'
      && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // ISO-BMFF: 'ftyp' at offset 4, brand at 8-12 — HEIC/HEIF/AVIF are
  // vision-surface rejects (dedup-h #1867 codec gate needs them named).
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs'].includes(brand)) return 'image/heic';
  }
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
  const p = a.persistedPath ?? (a.source?.type === 'path' ? a.source.path : null);
  const pathAttr = p ? ` path="${String(p).replace(/"/g, '')}"` : '';
  return `<attachment kind="${a.kind}" name="${a.name}" mime="${a.mime}" bytes="${a.bytes}"${pathAttr}/>`;
}

/**
 * M139: give the model a durable on-disk path for an inline (pasted)
 * attachment — a base64 blob in the transcript is unreferenceable; a spilled
 * file under the instance exports dir can be read/edited by governed tools.
 * Path-source attachments keep their own path (no copy). Returns the
 * persisted absolute path or null on failure (never throws — the attachment
 * itself still carries inline).
 */
export function persistAttachment(a, dir) {
  if (a?.source?.type !== 'inline') return null;
  try {
    mkdirSync(dir, { recursive: true });
    const safe = String(a.name ?? 'attachment').replace(/[^\w.\-]/g, '_').slice(-60);
    const out = join(dir, `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
    writeFileSync(out, Buffer.from(a.source.data, 'base64'));
    return out;
  } catch { return null; }
}

/**
 * M139 fix path: a path-source image must be materialized to bytes before it
 * rides the vision surface — `source.data` is undefined for path sources
 * (previously produced {type:'image', data:undefined} blocks). Returns the
 * base64 payload (BMP still transcodes through bmpToPng) or null unreadable.
 */
export function materializeImageSource(a) {
  if (a?.source?.type === 'inline') return a.source.data;
  if (a?.source?.type !== 'path') return null;
  let raw;
  try { raw = readFileSync(a.source.path); } catch { return null; }
  if (a.mime === 'image/bmp' || sniffMime(raw) === 'image/bmp') {
    const png = bmpToPng(raw);
    if (png) { a.mime = 'image/png'; return png.toString('base64'); }
    return null; // unreadable BMP → honest degrade, never a fake image block
  }
  return raw.toString('base64');
}

/**
 * M137 token-tier image scaling — zero-dependency PNG halving: decode
 * (IHDR+IDAT concat → inflate → unfilter), box-sample 2×2 until the longest
 * edge fits maxEdge, re-encode RGBA8 filter-0. Boundaries stay honest:
 * interlaced PNG, non-8-bit depth, non-RGB/Gray/RGBA color types and every
 * other codec return null — the caller leaves the original bytes untouched
 * rather than shipping a half-decoded fake.
 */
export function pngDownscale(buf, maxEdge) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) return null;
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  let pos = 8; let ihdr = null; const idat = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (data.length !== len) return null;
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr || !idat.length) return null;
  const w0 = ihdr.readUInt32BE(0), h0 = ihdr.readUInt32BE(4);
  const depth = ihdr[8], color = ihdr[9], interlace = ihdr[12];
  const chMap = { 0: 1, 2: 3, 6: 4 }; // gray / rgb / rgba
  const ch = chMap[color];
  if (depth !== 8 || interlace !== 0 || !ch || w0 <= 0 || h0 <= 0) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = w0 * ch + 1;
  if (raw.length < stride * h0) return null;
  // unfilter scanlines (filter types 0-4), then expand to RGBA rows
  const px = Buffer.alloc(w0 * h0 * 4);
  let prev = Buffer.alloc(w0 * ch);
  for (let y = 0; y < h0; y++) {
    const so = y * stride;
    const f = raw[so];
    const line = Buffer.from(raw.subarray(so + 1, so + stride));
    for (let x = 0; x < line.length; x++) {
      const left = x >= ch ? line[x - ch] : 0;
      const up = prev[x];
      const upLeft = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v = (v + left) & 0xff;
      else if (f === 2) v = (v + up) & 0xff;
      else if (f === 3) v = (v + ((left + up) >> 1)) & 0xff;
      else if (f === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        v = (v + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
      } else if (f !== 0) return null;
      line[x] = v;
    }
    prev = line;
    for (let x = 0; x < w0; x++) {
      const d = (y * w0 + x) * 4, s = x * ch;
      if (ch === 4) { px[d] = line[s]; px[d + 1] = line[s + 1]; px[d + 2] = line[s + 2]; px[d + 3] = line[s + 3]; }
      else if (ch === 3) { px[d] = line[s]; px[d + 1] = line[s + 1]; px[d + 2] = line[s + 2]; px[d + 3] = 255; }
      else { px[d] = px[d + 1] = px[d + 2] = line[s]; px[d + 3] = 255; }
    }
  }
  // box-halve until the longest edge fits
  let w = w0, h = h0, cur = px;
  while (Math.max(w, h) > maxEdge && w >= 2 && h >= 2) {
    const nw = w >> 1, nh = h >> 1;
    const next = Buffer.alloc(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const d = (y * nw + x) * 4;
        for (let c = 0; c < 4; c++) {
          next[d + c] = (cur[((2 * y) * w + 2 * x) * 4 + c]
            + cur[((2 * y) * w + 2 * x + 1) * 4 + c]
            + cur[((2 * y + 1) * w + 2 * x) * 4 + c]
            + cur[((2 * y + 1) * w + 2 * x + 1) * 4 + c]) >> 2;
        }
      }
    }
    w = nw; h = nh; cur = next;
  }
  if (w === w0) return null; // nothing to do
  const out = Buffer.alloc((w * 4 + 1) * h); // filter-0 rows
  for (let y = 0; y < h; y++) cur.copy(out, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const nh_ = Buffer.alloc(13);
  nh_.writeUInt32BE(w, 0); nh_.writeUInt32BE(h, 4);
  nh_[8] = 8; nh_[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', nh_),
    chunk('IDAT', zlib.deflateSync(out)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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
