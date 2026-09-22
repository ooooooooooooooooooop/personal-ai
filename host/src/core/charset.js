/**
 * charset.js — M144 output charset tier (unicode_mode: auto | unicode | ascii)
 *
 * The body emits box-drawing rules, arrows, bullets, spinners and status
 * glyphs that assume a unicode-capable consumer. On a dumb terminal or a
 * downstream that mangles them, an operator-set degrade tier transliterates
 * the SYMBOL layer to ASCII. Language text (CJK, accented Latin, …) is never
 * stripped — "ascii fallback" in harness practice degrades chrome, not
 * content; destroying meaning would be worse than a mis-drawn border.
 *
 * `auto` resolves once from the environment: an explicit dumb-terminal
 * marker degrades, everything else stays unicode (the browser UI and modern
 * terminals are unicode-safe).
 */

const SYMBOL_MAP = new Map(Object.entries({
  // box drawing
  '─': '-', '━': '-', '│': '|', '┃': '|', '┌': '+', '┍': '+', '┎': '+', '┏': '+',
  '┐': '+', '┑': '+', '┒': '+', '┓': '+', '└': '+', '┕': '+', '┖': '+', '┗': '+',
  '┘': '+', '┙': '+', '┚': '+', '┛': '+', '├': '+', '┝': '+', '┞': '+', '┟': '+',
  '┠': '+', '┡': '+', '┢': '+', '┣': '+', '┤': '+', '┥': '+', '┦': '+', '┧': '+',
  '┨': '+', '┩': '+', '┪': '+', '┫': '+', '┬': '+', '┭': '+', '┮': '+', '┯': '+',
  '┰': '+', '┱': '+', '┲': '+', '┳': '+', '┴': '+', '┵': '+', '┶': '+', '┷': '+',
  '┸': '+', '┹': '+', '┺': '+', '┻': '+', '┼': '+', '╌': '-', '╍': '-', '╎': '|',
  '═': '=', '║': '|', '╔': '+', '╗': '+', '╚': '+', '╝': '+', '╠': '+', '╣': '+',
  '╦': '+', '╩': '+', '╬': '+', '╭': '+', '╮': '+', '╯': '+', '╰': '+',
  // block + shade
  '█': '#', '▉': '#', '▊': '#', '▋': '#', '▌': '#', '▍': '#', '▎': '#', '▏': '#',
  '▐': '#', '░': '.', '▒': ':', '▓': '#', '■': '#', '□': '-', '▪': '*', '▫': '-',
  // arrows
  '→': '->', '←': '<-', '↑': '^', '↓': 'v', '↔': '<->', '⇒': '=>', '⇐': '<=',
  '↗': '/^', '↘': '\\v', '↙': '\\v', '↖': '/^', '⟶': '->', '⟵': '<-',
  // bullets / markers / status glyphs
  '•': '*', '◦': '-', '‣': '*', '◉': 'o', '○': 'o', '●': 'o', '◆': '*',
  '◇': '-', '✓': 'ok', '✔': 'ok', '✗': 'x', '✘': 'x', '✖': 'x', '⚠': '!',
  '✱': '*', '★': '*', '☆': '*', '▶': '>', '▸': '>', '►': '>', '◀': '<',
  '◂': '<', '◄': '<', '…': '...', '⋯': '...', '⋮': '...',
  // quotes & dashes & spaces
  '‘': "'", '’': "'", '‚': ',', '“': '"', '”': '"', '„': '"', '«': '<<',
  '»': '>>', '–': '-', '—': '--', '―': '-', '−': '-', ' ': ' ',
  // misc operators common in tool output
  '×': 'x', '÷': '/', '±': '+/-', '≈': '~', '≠': '!=', '≤': '<=', '≥': '>=',
  '∞': 'inf', '∴': '=>', '√': 'sqrt',
}));

const VALID_MODES = new Set(['auto', 'unicode', 'ascii']);

/**
 * Resolve the effective charset for a mode against the environment.
 * auto → 'ascii' only when the env clearly says dumb terminal; else 'unicode'.
 * @param {string} mode  auto | unicode | ascii
 * @param {object} [env]
 * @returns {'unicode'|'ascii'}
 */
export function resolveCharset(mode, env = process.env) {
  if (mode === 'ascii' || mode === 'unicode') return mode;
  const term = String(env.TERM ?? '');
  if (term === 'dumb' || term === 'cons25') return 'ascii';
  if (env.PAI_ASCII === '1' || env.NO_UNICODE === '1') return 'ascii';
  return 'unicode';
}

/**
 * Transliterate the symbol layer of `text` toward ASCII. No-op (identity,
 * same reference) when `charset` resolves to unicode — zero per-call cost
 * on the common path.
 * @param {string} text
 * @param {string} mode  unicode_mode setting (auto resolves via env)
 * @param {object} [env]
 */
export function toCharset(text, mode, env = process.env) {
  if (typeof text !== 'string' || resolveCharset(mode, env) !== 'ascii') return text;
  let out = '';
  for (const ch of text) out += SYMBOL_MAP.get(ch) ?? ch;
  return out;
}

/** Validate a unicode_mode value; returns null when invalid. */
export function normalizeUnicodeMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return VALID_MODES.has(v) ? v : null;
}
