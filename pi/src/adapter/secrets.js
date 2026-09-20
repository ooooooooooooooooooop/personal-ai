/**
 * Pre-write secret scan (Qwen-style: check credentials BEFORE the bytes land).
 * Credential-looking content in a write/edit is surfaced to the operator via
 * the ask surface — never a silent pass, never a hard deny (test fixtures and
 * .env templates are legitimate writes; the human decides).
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
