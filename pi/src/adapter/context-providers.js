/**
 * Named context providers (dedup-h #1937 — `@diagnostics` context form).
 * Managed extensions register a () => string getter; the prompt-path
 * expander pulls it on demand. Module-scoped registry: one host process
 * owns one live session, and a rebuilt session's extension re-registers
 * under the same name — latest wins. Provider failures degrade to null:
 * a broken provider never bricks a prompt.
 */
const providers = new Map();

/** Register a named provider; returns an unregister fn (call on shutdown). */
export function registerContextProvider(name, fn) {
  providers.set(name, fn);
  return () => providers.delete(name);
}

/** Pull a provider's current context; null when absent or when it throws. */
export function collectContext(name) {
  try { return providers.get(name)?.() ?? null; } catch { return null; }
}
