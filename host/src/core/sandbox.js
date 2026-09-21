/**
 * SandboxProvider — command-execution containment for spawned work.
 *
 * The provider answers a spawn spec ({file, args, shell:false}) rather than
 * a rewritten command string: wrapping bash inside cmd.exe quoting is how
 * injection bugs are born — a spec keeps the user's command as a single
 * argv element under the sandbox's own interpreter.
 *
 * v1 backends (remote-execution gradient, WSL→Docker→SSH):
 *   none — passthrough; the command runs on the host shell as today.
 *   wsl  — WSL2: `wsl.exe [-d distro] --cd <workdir> bash -lc <command>`.
 *          A real kernel boundary (separate OS, separate fs view via /mnt,
 *          separate process space) — not a Windows Job Object, which alone
 *          is resource accounting, not filesystem/network containment.
 *   docker — disposable container: `docker run --rm --name pai-job-<id>
 *          -v <workdir>:/work -w /work <image> bash -lc <command>`. The
 *          workspace mounts read-write (jobs are supposed to produce); the
 *          container is destroyed on exit and can be force-removed by name
 *          on timeout (spec.containerName).
 *   ssh  — remote host: `ssh -T -o BatchMode=yes user@host -- bash -lc
 *          '<remote>'`. The user command travels base64-encoded inside a
 *          generated remote script — no quoting can smuggle it into the
 *          REMOTE shell either. `dir` is the remote working directory.
 *          Honest limits: no workspace sync (the remote dir must exist and
 *          already contain whatever the command needs), killing the local
 *          ssh client orphans the remote process (audited by the caller).
 *
 * Selection: env PAI_SANDBOX=none|wsl|docker|ssh (default none — opt-in until
 * a containment story covers the foreground tool path too), or per-job via
 * JobExecutor's `sandbox` option. An unavailable backend fails closed:
 * spawnSpec throws before the process exists.
 */
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export class SandboxUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SANDBOX_UNAVAILABLE';
  }
}

/** Cached backend probe — docker/ssh binaries probed once per provider instance. */
const probeCache = new Map();
function probeBinary(file, args = ['--version']) {
  if (probeCache.has(file)) return probeCache.get(file);
  let ok = false;
  try {
    const r = spawnSync(file, args, { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    ok = r.status === 0;
  } catch { ok = false; }
  probeCache.set(file, ok);
  return ok;
}

export class SandboxProvider {
  /** @param {'none'|'wsl'|'docker'|'ssh'} kind @param {{distro?:string,image?:string,target?:string,dir?:string,key?:string}} [opts] */
  constructor(kind = 'none', { distro = null, image = null, target = null, dir = null, key = null } = {}) {
    this.kind = kind;
    this.distro = distro;
    this.image = image;
    this.target = target;
    this.dir = dir;
    this.key = key;
  }

  /**
   * @param {string} command  the user's shell command (opaque to us)
   * @param {string} workdir  Windows-side working directory (remote dir for ssh comes from opts.dir)
   * @returns {{file:string, args:string[], shell:boolean, cwd:string, containerName?:string, remote?:boolean}}
   */
  spawnSpec(command, workdir) {
    if (this.kind === 'none') {
      // shell:true preserved — same semantics as the pre-sandbox path
      return { file: command, args: [], shell: true, cwd: workdir };
    }
    if (this.kind === 'wsl') {
      if (process.platform !== 'win32') {
        throw new SandboxUnavailableError('wsl backend requires Windows host');
      }
      // wsl --cd accepts Windows paths and translates them itself.
      const args = [
        ...(this.distro ? ['-d', this.distro] : []),
        '--cd', workdir,
        'bash', '-lc', command,
      ];
      return { file: 'wsl.exe', args, shell: false, cwd: workdir };
    }
    if (this.kind === 'docker') {
      if (!probeBinary('docker')) {
        throw new SandboxUnavailableError('docker backend unavailable — `docker` not on PATH or daemon not running');
      }
      const name = `pai-job-${randomBytes(6).toString('hex')}`;
      const args = [
        'run', '--rm', '--name', name,
        '-v', `${workdir}:/work`, '-w', '/work',
        this.image ?? 'debian:bookworm-slim',
        'bash', '-lc', command,
      ];
      return { file: 'docker', args, shell: false, cwd: workdir, containerName: name };
    }
    if (this.kind === 'ssh') {
      if (!this.target) throw new SandboxUnavailableError('ssh backend requires a target (user@host[:port])');
      if (!probeBinary('ssh', ['-V'])) {
        throw new SandboxUnavailableError('ssh backend unavailable — `ssh` not on PATH');
      }
      const m = /^([^@]+)@([^:]+)(?::(\d+))?$/.exec(this.target);
      if (!m) throw new SandboxUnavailableError(`ssh target '${this.target}' must be user@host[:port]`);
      const [, user, host, port] = m;
      const remoteDir = this.dir ?? '~';
      // The command crosses as base64 inside a remote-generated script: the
      // remote shell never re-parses user text, so no quoting can smuggle it.
      const b64 = Buffer.from(command, 'utf-8').toString('base64');
      const remote = `cd ${remoteDir} && printf '%s' '${b64}' | base64 -d | bash`;
      const args = [
        '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        ...(port ? ['-p', port] : []),
        ...(this.key ? ['-i', this.key] : []),
        `${user}@${host}`, '--', 'bash', '-lc', remote,
      ];
      return { file: 'ssh', args, shell: false, cwd: workdir, remote: true };
    }
    throw new SandboxUnavailableError(`unknown sandbox backend '${this.kind}'`);
  }

  static fromEnv(env = process.env) {
    const kind = env.PAI_SANDBOX ?? 'none';
    return new SandboxProvider(kind, {
      distro: env.PAI_SANDBOX_DISTRO ?? null,
      image: env.PAI_SANDBOX_IMAGE ?? null,
      target: env.PAI_SANDBOX_SSH_TARGET ?? null,
      dir: env.PAI_SANDBOX_SSH_DIR ?? null,
      key: env.PAI_SANDBOX_SSH_KEY ?? null,
    });
  }
}
