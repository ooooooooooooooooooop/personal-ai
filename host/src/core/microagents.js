/**
 * Triggered knowledge (OpenHands microagents reference) — `.pai/microagents/*.md`
 * files carry frontmatter `triggers:` (comma-separated words/regex); a user
 * prompt matching a trigger injects that file's body as a <knowledge> block
 * for this turn only. Unlike steering (always-on), knowledge activates on
 * topic match — the difference between "always remember" and "when relevant".
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Same visible-truncation contract as steering/pins: an uncapped body would
// inject whole into the prompt (context blowout), and a SILENTLY cut body
// reads as intact guidance. Cap with an explicit marker.
const PER_FILE_MAX = 16 * 1024;

/** Parse `---\ntriggers: a, b\n---\nbody` — missing frontmatter = no triggers. */
export function loadMicroagents(workdir) {
  const dir = join(workdir, '.pai', 'microagents');
  if (!existsSync(dir)) return [];
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); }
  catch { return []; }
  const agents = [];
  for (const f of files) {
    let raw;
    try { raw = readFileSync(join(dir, f), 'utf-8'); } catch { continue; }
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const meta = fm ? fm[1] : '';
    let body = (fm ? raw.slice(fm[0].length) : raw).trim();
    const trigLine = meta.match(/^triggers:\s*(.+)$/m)?.[1] ?? '';
    const triggers = trigLine.split(',').map((t) => t.trim()).filter(Boolean);
    if (!triggers.length || !body) continue;
    if (body.length > PER_FILE_MAX) {
      body = `${body.slice(0, PER_FILE_MAX)}\n[truncated: file exceeds the 16KB per-microagent cap]`;
    }
    agents.push({
      name: f.replace(/\.md$/, ''),
      triggers,
      body,
    });
  }
  return agents;
}

/** Return the microagents whose triggers match the prompt text. */
export function matchMicroagents(agents, promptText) {
  const text = String(promptText ?? '').toLowerCase();
  if (!text) return [];
  return agents.filter((a) => a.triggers.some((t) => {
    try { return new RegExp(t, 'i').test(text); }
    catch { return text.includes(t.toLowerCase()); }
  }));
}

/** Render matched knowledge blocks for prompt injection. */
export function renderKnowledge(matches) {
  return matches
    .map((a) => `<knowledge name="${a.name}">\n${a.body}\n</knowledge>`)
    .join('\n\n');
}
