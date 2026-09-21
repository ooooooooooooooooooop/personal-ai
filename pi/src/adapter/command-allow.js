/**
 * Operator command-allowlist matcher — pure so the compound-command and
 * instruction-file rules can be tested without booting the host.
 *
 * Rules:
 *  - 'instruction_file' asks are negative-capability, not command-risk: an
 *    `echo` prefix must never auto-approve `echo x > AGENTS.md`.
 *  - units carrying expansions ($()/backticks/heredoc vars) are unverifiable —
 *    the literal text isn't what runs, so they are never prefix-softened.
 *  - compound commands match only when EVERY unit matches a prefix, so
 *    `allowed-tool && rm -rf ~` cannot ride on the first unit's prefix.
 *  - unclassified-but-literal commands stay matchable — that is what a
 *    prefix list is for.
 *
 * @param {string} command   raw command string from the tool args
 * @param {object} meta      {rule, parsed} passed by the governance kernel
 * @param {string[]} prefixes  operator prefixes from command-allow.json
 * @returns {boolean}
 */
export function commandAllowlistMatch(command, meta, prefixes) {
  if (meta?.rule === 'instruction_file') return false;
  if (typeof command !== 'string' || !prefixes?.length) return false;
  const parsed = meta?.parsed;
  if (parsed?.units?.some((u) => u.hasExpansion)) return false;
  if (Array.isArray(parsed?.units) && parsed.units.length) {
    return parsed.units.every((u) => prefixes.some((p) => u.raw.trim().startsWith(p)));
  }
  return prefixes.some((p) => command.trim().startsWith(p));
}
