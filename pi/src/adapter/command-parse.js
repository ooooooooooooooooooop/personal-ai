/**
 * Shell command parsing — real syntax analysis via tree-sitter-bash.
 *
 * Dependency decision (impl-plan M2): web-tree-sitter wasm path was probed and
 * rejected — tree-sitter-wasms@0.1.13 ships pre-dylink.0 ABI wasm that
 * web-tree-sitter@0.27 refuses to load. node-tree-sitter native bindings
 * (tree-sitter@0.25.1 + tree-sitter-bash@0.25.1, prebuilt via node-gyp-build,
 * no local compile) are the sanctioned fallback.
 *
 * Output feeds the governance kernel's static command classification:
 * every executable unit is extracted, including commands hidden inside
 * $(...) substitutions, subshells, pipelines, &&/|| lists, and loop bodies —
 * the exact blind spots a regex-based scanner misses.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let parserPromise = null;

async function getParser() {
  parserPromise ??= (async () => {
    const Parser = require('tree-sitter');
    const Bash = require('tree-sitter-bash');
    const parser = new Parser();
    parser.setLanguage(Bash);
    return parser;
  })();
  return parserPromise;
}

/** Coarse static risk classes — governance maps these onto policy. */
export const COMMAND_RISK = Object.freeze({
  BENIGN: 'benign',           // reads/prints/navigation
  MUTATING: 'mutating',       // writes/copies/moves within worktree
  DESTRUCTIVE: 'destructive', // deletes, force-overwrites, mass mutation
  NETWORK: 'network',         // arbitrary egress
  PRIVILEGE: 'privilege',     // sudo/runas/elevation
  EXEC: 'exec',               // spawns another interpreter/eval surface
  UNKNOWN: 'unknown',         // unparseable / dynamically resolved
});

const NAME_RISK = new Map(Object.entries({
  sudo: COMMAND_RISK.PRIVILEGE, runas: COMMAND_RISK.PRIVILEGE,
  doas: COMMAND_RISK.PRIVILEGE, su: COMMAND_RISK.PRIVILEGE,
  rm: COMMAND_RISK.DESTRUCTIVE, rmdir: COMMAND_RISK.DESTRUCTIVE,
  shred: COMMAND_RISK.DESTRUCTIVE, mkfs: COMMAND_RISK.DESTRUCTIVE,
  dd: COMMAND_RISK.DESTRUCTIVE, format: COMMAND_RISK.DESTRUCTIVE,
  'remove-item': COMMAND_RISK.DESTRUCTIVE, del: COMMAND_RISK.DESTRUCTIVE,
  curl: COMMAND_RISK.NETWORK, wget: COMMAND_RISK.NETWORK,
  'invoke-webrequest': COMMAND_RISK.NETWORK, 'invoke-restmethod': COMMAND_RISK.NETWORK,
  nc: COMMAND_RISK.NETWORK, ncat: COMMAND_RISK.NETWORK, ssh: COMMAND_RISK.NETWORK,
  scp: COMMAND_RISK.NETWORK, rsync: COMMAND_RISK.NETWORK, ftp: COMMAND_RISK.NETWORK,
  bash: COMMAND_RISK.EXEC, sh: COMMAND_RISK.EXEC, zsh: COMMAND_RISK.EXEC,
  pwsh: COMMAND_RISK.EXEC, powershell: COMMAND_RISK.EXEC, cmd: COMMAND_RISK.EXEC,
  python: COMMAND_RISK.EXEC, python3: COMMAND_RISK.EXEC, node: COMMAND_RISK.EXEC,
  perl: COMMAND_RISK.EXEC, ruby: COMMAND_RISK.EXEC, eval: COMMAND_RISK.EXEC,
  source: COMMAND_RISK.EXEC, '.': COMMAND_RISK.EXEC, exec: COMMAND_RISK.EXEC,
  mv: COMMAND_RISK.MUTATING, cp: COMMAND_RISK.MUTATING, mkdir: COMMAND_RISK.MUTATING,
  touch: COMMAND_RISK.MUTATING, tee: COMMAND_RISK.MUTATING, ln: COMMAND_RISK.MUTATING,
  chmod: COMMAND_RISK.MUTATING, chown: COMMAND_RISK.MUTATING,
  git: COMMAND_RISK.MUTATING, npm: COMMAND_RISK.MUTATING, pip: COMMAND_RISK.MUTATING,
  'set-content': COMMAND_RISK.MUTATING, 'out-file': COMMAND_RISK.MUTATING,
  'move-item': COMMAND_RISK.MUTATING, 'copy-item': COMMAND_RISK.MUTATING,
  'new-item': COMMAND_RISK.MUTATING, 'rename-item': COMMAND_RISK.MUTATING,
}));

const DESTRUCTIVE_FLAG = /^-[a-zA-Z]*(r|f|F)[a-zA-Z]*$/; // -rf -fr -f etc.

function baseName(word) {
  return word.replace(/^['"]|['"]$/g, '').split(/[\\/]/).pop().replace(/\.(exe|bat|cmd|ps1)$/i, '').toLowerCase();
}

/**
 * Commands whose positional args are write targets (file overwrite/mutation
 * surfaces that are NOT shell redirections). Last positional arg is the
 * destination for cp/mv/install/ln/rsync/patch; tee writes every arg.
 * sed -i / perl -i edit their file args in place. dd writes of=<path>.
 * Only instruction-path hits are escalated — reads stay reads.
 */
const LAST_ARG_WRITES = new Set(['cp', 'mv', 'install', 'ln', 'rsync', 'patch']);
const INPLACE_EDITS = new Set(['sed', 'perl', 'gsed']);
const ALL_ARG_WRITES = new Set(['tee']);

const REDIRECT_WRITE_RE = /^\d*(?:>>?|&>>?|<>|>\|)/;

/** Depth-first collect every `command` node with its nesting context. */
function collectCommands(node, units, redirects, context) {
  const type = node.type;
  if (type === 'command') {
    const nameNode = node.childForFieldName('name');
    const name = nameNode ? nameNode.text : '';
    const args = [];
    let hasExpansion = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c === nameNode || c.type === 'variable_assignment' || c.type === 'file_redirect') continue;
      if (/expansion|substitution|heredoc/.test(c.type)) hasExpansion = true;
      args.push(c.text);
    }
    units.push({
      name: baseName(name),
      rawName: name,
      args,
      raw: node.text,
      context, // 'top' | 'substitution' | 'subshell'
      hasExpansion,
    });
    // a command's own substitution/expansion children still contain commands
    context = context === 'top' ? 'substitution' : context;
  } else if (type === 'file_redirect') {
    // redirects sit beside the command inside redirected_statement — the
    // destination is the `destination` field (or the last word child).
    const dest = node.childForFieldName('destination') ?? node.lastNamedChild;
    const op = node.text.slice(0, node.text.length - (dest ? dest.text.length : 0));
    if (dest && REDIRECT_WRITE_RE.test(op.trim()) && !/^&\d/.test(dest.text.trim())) {
      redirects.push(dest.text.trim());
    }
  } else if (type === 'subshell') {
    context = 'subshell';
  } else if (type === 'command_substitution') {
    context = 'substitution';
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    collectCommands(node.namedChild(i), units, redirects, context);
  }
}

/** Positional args that are file write targets for a command unit. */
function writeTargetArgs(unit) {
  const name = unit.name;
  if (ALL_ARG_WRITES.has(name)) return unit.args.filter((a) => !a.startsWith('-'));
  if (LAST_ARG_WRITES.has(name)) {
    const pos = unit.args.filter((a) => !a.startsWith('-'));
    return pos.length ? [pos[pos.length - 1]] : [];
  }
  if (INPLACE_EDITS.has(name) && unit.args.some((a) => /^-[a-zA-Z]*i/.test(a))) {
    return unit.args.filter((a) => !a.startsWith('-'));
  }
  if (name === 'dd') {
    return unit.args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
  }
  return [];
}

/**
 * Parse a shell command string into executable units.
 * @param {string} source
 * @returns {Promise<{units: Array, parseError: string|null, risk: string, hasUnknown: boolean}>}
 */
export async function parseShellCommand(source) {
  const parser = await getParser();
  const tree = parser.parse(source);
  const units = [];
  const redirects = [];
  collectCommands(tree.rootNode, units, redirects, 'top');
  const parseError = tree.rootNode.hasError ? 'parse produced ERROR nodes' : null;
  let hasUnknown = false;
  const risk = units.reduce((worst, u) => {
    const r = NAME_RISK.get(u.name) ?? COMMAND_RISK.UNKNOWN;
    if (r === COMMAND_RISK.UNKNOWN || u.hasExpansion || !u.name) hasUnknown = true;
    // an unknown sibling must not mask a KNOWN destructive unit
    return r !== COMMAND_RISK.UNKNOWN && rank(r) > rank(worst) ? r : worst;
  }, COMMAND_RISK.BENIGN);
  // every filesystem write surface in this command: redirect destinations
  // (echo > AGENTS.md) plus write-target args (tee/cp/mv/sed -i/dd of=).
  const writeTargets = [...redirects];
  for (const u of units) writeTargets.push(...writeTargetArgs(u));
  return { units, parseError, risk, hasUnknown, writeTargets };
}

const ORDER = [
  COMMAND_RISK.BENIGN, COMMAND_RISK.MUTATING, COMMAND_RISK.EXEC,
  COMMAND_RISK.NETWORK, COMMAND_RISK.DESTRUCTIVE, COMMAND_RISK.PRIVILEGE,
  COMMAND_RISK.UNKNOWN,
];
const rank = (r) => ORDER.indexOf(r);

/** Classify one command name without a parse (fast path for single tools). */
export function classifyCommandName(name) {
  return NAME_RISK.get(baseName(name)) ?? COMMAND_RISK.UNKNOWN;
}
