/**
 * Post-mutation schema revalidation — the real pi-ai validator wired into the
 * composite guard's `revalidate` hook.
 *
 * Pi's extension bridge lets managed extensions mutate already-validated args
 * in place and does NOT re-validate afterwards (agent-loop.js:410-449). This
 * module re-runs the tool's own TypeBox schema against the mutated args, and
 * returns the validator's normalized object so the composite can write it
 * back onto the executed reference (a coerced value the model produced is the
 * value that must run — not the pre-coercion string).
 *
 * @earendil-works/pi-ai is a direct dependency (R9), imported via its public
 * `./utils/*` export map — never through transitive hoisting.
 */
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation';

/**
 * @param {Map<string, object>|object[]|object} toolsSource
 *        Tool definitions: a name→tool map, a tool array, or a lookup function.
 * @returns {(toolCall, args) => {ok:boolean, reason?:string, normalizedArgs?:object}}
 */
export function createRevalidator(toolsSource) {
  const lookup =
    typeof toolsSource === 'function'
      ? toolsSource
      : Array.isArray(toolsSource)
        ? (name) => toolsSource.find((t) => t?.name === name)
        : (name) => toolsSource?.get?.(name) ?? toolsSource?.[name];

  return (toolCall, args) => {
    const name = toolCall?.name ?? toolCall?.toolName;
    const tool = lookup(name);
    if (!tool) {
      // Unknown to us: fail closed — the composite cannot certify a call
      // whose schema we cannot inspect.
      return { ok: false, reason: `no schema available for tool '${name}'` };
    }
    try {
      const normalized = validateToolArguments(tool, {
        ...(toolCall ?? {}),
        name,
        arguments: args ?? {},
      });
      return { ok: true, normalizedArgs: normalized };
    } catch (err) {
      return { ok: false, reason: err?.message ?? String(err) };
    }
  };
}
