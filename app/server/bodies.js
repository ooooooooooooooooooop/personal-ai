/**
 * Body catalog — the app layer is the multi-body composition root: it may
 * know every concrete body (host/ still knows none). Each entry declares how
 * to measure facts, whether the body is installed, and how to spawn its
 * host-channel process. A body without a channel entry can still appear in
 * the panel (facts are real), but body_select fails closed on it.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { piFacts } from '../../pi/src/bootstrap/facts.js';
import { DshBody } from '../../dsh/adapter/index.js';

function commandOnPath(name) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, [name], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

/**
 * Resolve the dsh CLI bin.js. Discovery order: explicit DSH_CLI → PATH → the
 * managed composition's profile-level install
 * (<DSH_HOME|~/.dsh>/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js).
 * Returns null when no runtime exists — callers must not pretend it does.
 */
export function resolveDshBin(env = process.env) {
  const home = env.DSH_HOME ?? join(homedir(), '.dsh');
  return [
    env.DSH_CLI,
    commandOnPath('dsh'),
    join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ].find((c) => c && existsSync(c)) ?? null;
}

export function bodyCatalog({ repoRoot, instanceRoot, workdir, env = process.env }) {
  return {
    pi: {
      id: 'pi',
      label: 'Pi',
      facts: () => piFacts(),
      installed: () =>
        existsSync(join(repoRoot, 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent')),
      installHint: 'npm --prefix pi install',
      channel: (opts = {}) => ({
        command: process.execPath,
        args: [
          join(repoRoot, 'pi', 'bin', 'pai-channel.js'),
          '--instance', instanceRoot,
          '--workdir', opts.workdir ?? workdir,
        ],
        // Under Electron process.execPath is electron.exe; this env makes the
        // child run as plain Node so the channel script executes normally.
        env: process.versions?.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
      }),
    },
    dsh: {
      id: 'dsh',
      label: 'DSH',
      facts: () => new DshBody({ runId: 'app-discovery', dshCli: resolveDshBin(env) }).facts(),
      installed: () => Boolean(resolveDshBin(env)),
      installHint: 'install the dsh CLI (headless profile) or set DSH_CLI',
      // The channel spawns `dsh --profile web` and bridges its Typert /api
      // behind the host protocol. No runtime = fail closed (null).
      channel: (opts = {}) => {
        const bin = resolveDshBin(env);
        if (!bin) return null;
        return {
          command: process.execPath,
          args: [
            join(repoRoot, 'dsh', 'bin', 'dsh-channel.js'),
            '--instance', instanceRoot,
            '--workdir', opts.workdir ?? workdir,
            '--dsh-bin', bin,
          ],
          env: process.versions?.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
        };
      },
    },
  };
}
