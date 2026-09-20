/**
 * SandboxProvider — command-execution containment for spawned work.
 *
 * The provider answers a spawn spec ({file, args, shell:false}) rather than
 * a rewritten command string: wrapping bash inside cmd.exe quoting is how
 * injection bugs are born — a spec keeps the user's command as a single
 * argv element under the sandbox's own interpreter.
 *
 * v1 backends:
 *   none — passthrough; the command runs on the host shell as today.
 *   wsl  — WSL2: `wsl.exe [-d distro] --cd <workdir> bash -lc <command>`.
 *          A real kernel boundary (separate OS, separate fs view via /mnt,
 *          separate process space) — not a Windows Job Object, which alone
 *          is resource accounting, not filesystem/network containment.
 *
 * Selection: env PAI_SANDBOX=none|wsl (default none — opt-in until a
 * containment story covers the foreground tool path too), PAI_SANDBOX_DISTRO
 * for the WSL distribution name. An unavailable backend fails closed:
 * spawnSpec throws before the process exists.
 */

export class SandboxUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.code = 'SANDBOX_UNAVAILABLE';
  }
}

export class SandboxProvider {
  /** @param {'none'|'wsl'} kind @param {{distro?:string}} [opts] */
  constructor(kind = 'none', { distro = null } = {}) {
    this.kind = kind;
    this.distro = distro;
  }

  /**
   * @param {string} command  the user's shell command (opaque to us)
   * @param {string} workdir  Windows-side working directory
   * @returns {{file:string, args:string[], shell:false, cwd:string}}
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
    throw new SandboxUnavailableError(`unknown sandbox backend '${this.kind}'`);
  }

  static fromEnv(env = process.env) {
    const kind = env.PAI_SANDBOX ?? 'none';
    return new SandboxProvider(kind, { distro: env.PAI_SANDBOX_DISTRO ?? null });
  }
}
