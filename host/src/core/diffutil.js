/**
 * Minimal unified line diff — zero deps, O(n·m) LCS with a row cap.
 * Used by the /diff aggregation surface: FileOpsGuard backups vs live files.
 * Large files degrade to a bounded hunk count rather than blowing memory —
 * this is a display aid, not a merge engine.
 */
const MAX_LINES = 4000;
const MAX_HUNKS = 50;
const CONTEXT = 3;

function lcsDiff(aLines, bLines) {
  const n = aLines.length, m = bLines.length;
  // dp[i][j] = LCS length of a[i:] vs b[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { ops.push({ t: ' ', a: aLines[i++] }); j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', a: aLines[i++] });
    else ops.push({ t: '+', a: bLines[j++] });
  }
  while (i < n) ops.push({ t: '-', a: aLines[i++] });
  while (j < m) ops.push({ t: '+', a: bLines[j++] });
  return ops;
}

/**
 * Unified-ish diff of `before` → `after`.
 * @returns {string} diff text; '' when identical; a truncation note when capped.
 */
export function unifiedDiff(before, after, { path = 'file' } = {}) {
  const aLines = String(before ?? '').split('\n');
  const bLines = String(after ?? '').split('\n');
  if (aLines.length + bLines.length > MAX_LINES) {
    return `--- a/${path}\n+++ b/${path}\n@@ diff too large (${aLines.length}+${bLines.length} lines) — see backup/current files @@\n`;
  }
  const ops = lcsDiff(aLines, bLines);
  if (ops.every((o) => o.t === ' ')) return '';

  // Group into hunks around changed ops with CONTEXT lines.
  const changedIdx = ops.map((o, i) => (o.t !== ' ' ? i : -1)).filter((i) => i >= 0);
  const hunks = [];
  let s = Math.max(0, changedIdx[0] - CONTEXT);
  for (let k = 1; k < changedIdx.length; k++) {
    if (changedIdx[k] - changedIdx[k - 1] > CONTEXT * 2 + 1) {
      hunks.push([s, changedIdx[k - 1] + CONTEXT]);
      s = Math.max(0, changedIdx[k] - CONTEXT);
    }
  }
  hunks.push([s, Math.min(ops.length - 1, changedIdx[changedIdx.length - 1] + CONTEXT)]);

  let out = `--- a/${path}\n+++ b/${path}\n`;
  for (const [h0, h1] of hunks.slice(0, MAX_HUNKS)) {
    const del = ops.slice(h0, h1 + 1).filter((o) => o.t !== '+').length;
    const add = ops.slice(h0, h1 + 1).filter((o) => o.t !== '-').length;
    out += `@@ -${del} +${add} @@\n`;
    for (let i = h0; i <= h1; i++) out += `${ops[i].t}${ops[i].a}\n`;
  }
  if (hunks.length > MAX_HUNKS) out += `@@ … ${hunks.length - MAX_HUNKS} more hunks @@\n`;
  return out;
}
