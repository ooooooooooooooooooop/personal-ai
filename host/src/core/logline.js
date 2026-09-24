/**
 * logline — one diagnostic-log choke for the daemon's unstructured output.
 *
 * dedup-h #3059 — LOG_JSON structured logging analogue: when `LOG_JSON` or
 * `PAI_LOG_JSON` is truthy in the environment, every diagnostic line emitted
 * through logLine() is a single JSON object ({ts, level, component, msg,
 * ...fields}) — machine-parseable for log pipelines. Without the flag the
 * same call sites emit the existing human `[component] msg` text.
 *
 * Only genuine diagnostics route here — protocol stdout stays JSONL always,
 * and audit stays in the audit store; this flag governs the stderr/console
 * channel.
 */
const JSON_ON = /^(1|true|yes)$/i.test(process.env.LOG_JSON ?? '')
  || /^(1|true|yes)$/i.test(process.env.PAI_LOG_JSON ?? '');

/**
 * Emit one diagnostic line. `fields` must be JSON-serializable; a thrown
 * serializer degrades to a plain text line rather than crashing the caller.
 */
export function logLine(component, msg, fields = {}, level = 'info') {
  if (!JSON_ON) {
    process.stderr.write(`[${component}] ${msg}\n`);
    return;
  }
  let line;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), level, component, msg, ...fields });
  } catch {
    line = JSON.stringify({ ts: new Date().toISOString(), level, component, msg: String(msg) });
  }
  process.stderr.write(`${line}\n`);
}

export function logJsonEnabled() { return JSON_ON; }
