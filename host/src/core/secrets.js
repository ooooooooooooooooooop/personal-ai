/**
 * Pre-write secret scan (Qwen-style: check credentials BEFORE the bytes land).
 * Canonical home is host/ — pi's adapter re-exports this so the pattern set
 * has one source of truth (write-path scan and memory-write scan share it).
 */
const PATTERNS = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['openai_key', /\bsk-[a-zA-Z0-9]{20,}\b/],
  ['github_pat', /\bgh[pso]_[a-zA-Z0-9]{36}\b/],
  ['slack_token', /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];

/**
 * @param {string} content — bytes about to be written
 * @returns {string|null} pattern label of the first hit
 */
export function scanForSecrets(content) {
  if (typeof content !== 'string' || !content) return null;
  for (const [label, re] of PATTERNS) {
    if (re.test(content)) return label;
  }
  return null;
}

/**
 * Scrub secret-looking spans out of content that MUST be persisted (job
 * output tails, logs) — unlike scanForSecrets (refuse-the-write), this
 * keeps the artifact while removing the credential bytes.
 * @param {string} content
 * @returns {string} content with every pattern hit replaced by [REDACTED:label]
 */
export function redactSecrets(content) {
  if (typeof content !== 'string' || !content) return content;
  let out = content;
  for (const [label, re] of PATTERNS) {
    out = out.replace(new RegExp(re.source, 'g'), `[REDACTED:${label}]`);
  }
  return out;
}

/**
 * Recursive variant for JSON-shaped values about to hit a DURABLE store
 * (observation details, job event payloads, prediction outcomes) — every
 * string leaf is span-scrubbed, structure preserved. M5 parity: a durable
 * artifact must never become an unredacted on-disk secret store.
 */
export function scrubSecretsDeep(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(scrubSecretsDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubSecretsDeep(v);
    return out;
  }
  return value;
}
