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
import { piFacts } from '../../pi/src/bootstrap/facts.js';
import { DshBody } from '../../dsh/adapter/index.js';

function commandOnPath(name) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, [name], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
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
      channel: () => ({
        command: process.execPath,
        args: [
          join(repoRoot, 'pi', 'bin', 'pai-channel.js'),
          '--instance', instanceRoot,
          '--workdir', workdir,
        ],
      }),
    },
    dsh: {
      id: 'dsh',
      label: 'DSH',
      facts: () => new DshBody({ runId: 'app-discovery' }).facts(),
      installed: () => Boolean(env.DSH_CLI && existsSync(env.DSH_CLI)) || Boolean(commandOnPath('dsh')),
      installHint: 'install the dsh CLI (headless profile) or set DSH_CLI',
      // DSH has no session channel yet — it can take handoff/task effects via
      // the adapter, but cannot host a chat session behind the host protocol.
      channel: null,
    },
  };
}
