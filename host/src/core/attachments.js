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
