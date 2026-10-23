import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * Resolve desktop startup options with deterministic precedence:
 *   1. CLI options (--ui <mode>, --modern, --classic, --instance <path>, --workdir <path>)
 *   2. Environment variables (PAI_UI, PAI_INSTANCE, PAI_WORKDIR)
 *   3. instanceRoot app-config.json (ui, workdir)
 *   4. Safe defaults (classic UI, ~/.personal-ai/instance or userData, defaultWorkdir)
 */
export function resolveStartupOptions({
  argv = process.argv,
  env = process.env,
  userDataPath = null,
  defaultWorkdir = null,
} = {}) {
  const args = Array.isArray(argv) ? argv : [];
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const hasFlag = (name) => args.includes(`--${name}`);

  let ui = opt('ui');
  if (!ui && hasFlag('modern')) ui = 'modern';
  if (!ui && hasFlag('classic')) ui = 'classic';

  const defaultHomeInstance = join(homedir(), '.personal-ai', 'instance');
  const instanceRoot = opt('instance')
    ?? env?.PAI_INSTANCE
    ?? (existsSync(defaultHomeInstance) ? defaultHomeInstance : (userDataPath ? join(userDataPath, 'instance') : defaultHomeInstance));

  let configUi = null;
  let configWorkdir = null;
  try {
    const cfgPath = join(instanceRoot, 'app-config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (typeof cfg?.ui === 'string') configUi = cfg.ui;
      if (typeof cfg?.workdir === 'string') configWorkdir = cfg.workdir;
    }
  } catch { /* config read errors are non-fatal */ }

  const workdir = opt('workdir')
    ?? env?.PAI_WORKDIR
    ?? configWorkdir
    ?? defaultWorkdir
    ?? homedir();

  const uiMode = ui ?? env?.PAI_UI ?? configUi ?? 'classic';

  return { uiMode, instanceRoot, workdir };
}
