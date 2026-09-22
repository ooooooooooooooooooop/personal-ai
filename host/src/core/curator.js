/**
 * M136: autonomous Curator — scores the agent-authored library
 * (.pai/microagents skills + .pai/plans) and emits merge/prune proposals.
 *
 * The curator is ADVISORY: it never deletes or rewrites anything itself.
 * Its proposals are surfaced to the model/operator as data; any destructive
 * step still travels the normal governed tool path (skill_delete → decide
 * chain → operator ask where the policy says so). Autonomy here means the
 * agent can ASK for a cleanup — it can never self-apply one.
 *
 * Scoring is deterministic and explainable — every score carries its
 * reasons so a rejected proposal can be audited against the same numbers.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 86_400_000;
const TOKEN_RE = /[a-z0-9_$]+|[一-鿿]+/g;

const tokens = (s) => new Set(String(s ?? '').toLowerCase().match(TOKEN_RE) ?? []);
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
};

/** Frontmatter `triggers:` list for microagents (comma/space separated). */
export function parseTriggers(text) {
  const m = String(text).match(/^---\n([\s\S]*?)\n---/);
  if (!m) return [];
  const t = m[1].match(/^triggers:\s*(.+)$/m);
  if (!t) return [];
  return t[1].split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Score one library entry 0–100 with reasons.
 * @param {{name:string, kind:'microagents'|'plans', bytes:number, mtimeMs:number, triggers:string[], firstLine:string}} e
 */
export function scoreEntry(e, now = Date.now()) {
  let score = 60;
  const reasons = [];
  const ageDays = (now - e.mtimeMs) / DAY_MS;
  if (ageDays > 90) { score -= 25; reasons.push(`stale ${Math.round(ageDays)}d`); }
  else if (ageDays > 30) { score -= 10; reasons.push(`aging ${Math.round(ageDays)}d`); }
  if (e.bytes < 100) { score -= 20; reasons.push('thin (<100 chars)'); }
  if (e.bytes > 28 * 1024) { score -= 10; reasons.push('bloated (>28k)'); }
  if (e.kind === 'microagents') {
    if (!e.triggers.length) { score -= 15; reasons.push('no triggers — never fires'); }
    else if (e.triggers.length > 8) { score -= 5; reasons.push('over-broad triggers'); }
  }
  return { score: Math.max(0, Math.min(100, score)), ageDays: Math.round(ageDays), reasons };
}

/** Enumerate the library with stats. Pure read. */
export function scanLibrary(workdir) {
  const entries = [];
  for (const kind of ['microagents', 'plans']) {
    const d = join(workdir, '.pai', kind);
    if (!existsSync(d)) continue;
    let files = [];
    try { files = readdirSync(d).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const p = join(d, f);
      try {
        const st = statSync(p);
        const text = readFileSync(p, 'utf-8');
        entries.push({
          name: f.replace(/\.md$/, ''),
          kind,
          path: p,
          bytes: st.size,
          mtimeMs: st.mtimeMs,
          triggers: kind === 'microagents' ? parseTriggers(text) : [],
          firstLine: text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('---') && !/^triggers:/.test(l)) ?? '',
        });
      } catch { /* vanished mid-scan */ }
    }
  }
  return entries;
}

/**
 * Score everything and emit proposals.
 *  - merge: two microagents whose name+trigger token sets overlap ≥0.5 —
 *    keep the newer one, fold the stale twin's unique triggers into it.
 *  - prune: score < 25 (stale+thin or dead-on-arrival).
 *  - keep: everything else.
 * @returns {{entries:object[], proposals:object[]}}
 */
export function curateLibrary(workdir, { now = Date.now(), overlapThreshold = 0.5, pruneBelow = 25 } = {}) {
  const entries = scanLibrary(workdir).map((e) => ({ ...e, ...scoreEntry(e, now) }));
  const proposals = [];
  const merged = new Set();

  // signature = what the skill IS FOR: name + trigger surface. Body/first-line
  // text is deliberately excluded — shared vocabulary ('steps', 'deploy')
  // would drown the trigger signal and merge unrelated skills.
  const sig = (e) => tokens([e.name.replaceAll(/[-_]/g, ' '), e.triggers.join(' ')].join(' '));
  const agents = entries.filter((e) => e.kind === 'microagents');
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const [a, b] = [agents[i], agents[j]];
      if (merged.has(a.name) || merged.has(b.name)) continue;
      const overlap = jaccard(sig(a), sig(b));
      if (overlap >= overlapThreshold) {
        const [keep, drop] = a.mtimeMs >= b.mtimeMs ? [a, b] : [b, a];
        merged.add(drop.name);
        proposals.push({
          kind: 'merge',
          keep: keep.name,
          drop: drop.name,
          overlap: Number(overlap.toFixed(2)),
          reason: `'${drop.name}' overlaps '${keep.name}' (${Math.round(overlap * 100)}% shared tokens) — fold its unique triggers into the survivor`,
        });
      }
    }
  }

  for (const e of entries) {
    if (merged.has(e.name)) continue;
    if (e.score < pruneBelow) {
      proposals.push({
        kind: 'prune',
        target: e.name,
        kindDir: e.kind,
        score: e.score,
        reason: `score ${e.score}: ${e.reasons.join('; ') || 'below threshold'} — delete via skill_delete (operator-approved)`,
      });
    } else {
      proposals.push({ kind: 'keep', target: e.name, kindDir: e.kind, score: e.score });
    }
  }
  return { entries, proposals };
}
