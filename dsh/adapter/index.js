/**
 * DSH body adapter — the L4 side of the host contract.
 *
 * Direction is dsh → host (this file may import host contracts; host/ never
 * imports dsh/). The adapter supplies what the host contract needs from a
 * second body:
 *
 *  - facts()                  measured BodyFacts for the registry — DSH's real
 *                             capability coverage, including honest gaps
 *  - claim/writeEffect        writer-lease discipline (fencing before effects)
 *  - exportContinuity         host-owned state → PortableContinuityEnvelope
 *  - importContinuity         envelope → DSH-consumable projection (adapter-side
 *                             context translation is the body's job, per design)
 *  - runTask                  drives the REAL dsh CLI headless profile as a
 *                             subprocess when one is installed; reports the
 *                             capability honestly when it is not
 *
 * What this adapter does NOT do: pretend DSH has a post-extension composite
 * guard (it doesn't — that gap is why the migration exists). Tasks that
 * require final_post_extension_guard non-negotiably fail-closed on dsh.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePortableContinuityEnvelope } from '../../host/src/core/handoff.js';

/** Measured capability facts — evidence: M5 inventory + dsh/DISPOSITION.md. */
export const DSH_CAPABILITIES = {
  agent_loop: 'supported', // dsh-agent-loop + goal-round-driver
  tool_surface: 'supported', // dsh-tool-* family
  durable_jobs: 'supported', // dsh-jobs / dsh-jobs-local
  compaction_governance: 'partial', // dsh-compaction* exists; no host-grade hooks
  web_ui: 'supported', // dsh-web-* product surface
  channels: 'supported', // dsh-client-connection wire protocol
  mcp_native: 'supported', // dsh-mcp-client
  loop_observability: 'supported', // session telemetry/otel plugins
  provider_request_audit: 'partial', // telemetry exists; no unified audit seam
  canonical_prediction_binding: 'supported', // dsh/world-model plugin writes canonical
  final_post_extension_guard: 'unsupported', // no post-extension guard — migration's reason
};

/** Governance surfaces DSH actually enforces — mostly partial/parallel paths. */
export const DSH_GOVERNANCE_COVERAGE = {
  tool_decide: 'partial', // dsh-authorization/permission-presets — not the composite chain
  schema_revalidation: 'unsupported',
  deny_hide: 'unsupported',
  fileops_guard: 'partial', // dsh-tool-fs exists; no recycle/backup contract
  audit: 'partial',
  compaction_hooks: 'partial',
  continuation_steer: 'supported', // goal-round-driver
  usage_accounting: 'supported', // telemetry + token-meter
};

/** Cold-handoff phases a DSH body can honor (same host-owned machine). */
export const DSH_HANDOFF_CAPABILITIES = {
  quiesce: 'supported',
  checkpoint: 'supported',
  release: 'supported',
  acquire: 'supported',
  resume: 'supported',
  verify: 'supported',
};

export class DshBody {
  /**
   * @param {object} deps
   * @param {string} deps.runId        this run's identity (provenance actor)
   * @param {string} [deps.dshCli]     absolute path to the real dsh bin.js
   * @param {string} [deps.dshProfile] profile to boot for runTask (default 'headless')
   */
  constructor({ runId, dshCli = null, dshProfile = 'headless' }) {
    this.body_id = 'dsh';
    this.runId = runId;
    this.dshCli = dshCli;
    this.dshProfile = dshProfile;
    this.held = [];
  }

  /** Registry facts — declared coverage, not selection state. */
  facts() {
    return {
      body_id: this.body_id,
      adapter_version: '0.1.1-rc.2',
      verified_capabilities: DSH_CAPABILITIES,
      governance_coverage: DSH_GOVERNANCE_COVERAGE,
      handoff_capabilities: DSH_HANDOFF_CAPABILITIES,
      supported_effect_domains: ['tools', 'filesystem', 'shell', 'network', 'web'],
      known_limitations: {
        final_post_extension_guard:
          'no post-extension composite guard; tasks requiring it fail-closed on this body',
      },
    };
  }

  /** Writer-lease discipline — same store, owner carries this body's run id. */
  claim(leases, scope, name, ttlSeconds = 30) {
    const r = leases.claim({ scope, name, owner: `dsh:${this.runId}`, ttlSeconds });
    if (r.ok) this.held.push({ scope, name, generation: r.lease.generation });
    return r;
  }

  /** Fencing check before every governed effect — revived stale owners fail. */
  writeEffect(leases, scope, name) {
    const lease = this.held.find((l) => l.scope === scope && l.name === name);
    return leases.assertHeld({
      scope, name, owner: `dsh:${this.runId}`, generation: lease?.generation,
    });
  }

  /**
   * Export PAI-owned continuity from a source body's host state. Only
   * PAI-owned state crosses — never harness-internal session blobs.
   */
  exportContinuity({ goalIdentity, canonicalCursor, soulIdentity, predictions, jobs, policyIdentity, provenanceChain, source }) {
    return makePortableContinuityEnvelope({
      goalIdentity,
      canonicalCursor,
      soulIdentity,
      openPredictions: predictions.map((p) => p.id),
      jobCursors: jobs.map((j) => ({
        job_id: j.job_id,
        attempt: j.current_attempt ?? 1,
        checkpoint_ref: j.checkpoint_ref ?? null,
      })),
      policyIdentity,
      provenanceChain,
      source,
    });
  }

  /**
   * Import a continuity envelope into a DSH-consumable projection — the
   * adapter-side context translation. Materializes a markdown projection a
   * dsh headless run can be fed (instructions + world-model + job cursors);
   * returns the projection path and a resume summary for verify().
   */
  importContinuity(envelope, { dir, briefing = '' }) {
    if (envelope?.kind !== 'PortableContinuityEnvelope') {
      throw new Error('importContinuity expects a PortableContinuityEnvelope');
    }
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'dsh-continuity-projection.md');
    const lines = [
      '# Personal AI continuity projection (cross-body resume)',
      '',
      `goal: ${envelope.goalIdentity}`,
      `soul: ${envelope.soulIdentity}`,
      `canonical cursor: ${envelope.canonicalCursor}`,
      `provenance: ${(envelope.provenanceChain ?? []).join(' -> ')}`,
      '',
      '## briefing',
      briefing,
      '',
      '## open predictions',
      ...(envelope.openPredictions ?? []).map((p) => `- ${typeof p === 'string' ? p : `${p.id}: ${p.claim ?? ''}`}`),
      '',
      '## job cursors',
      ...(envelope.jobCursors ?? []).map((j) => `- ${j.job_id} @ attempt ${j.attempt} (checkpoint ${j.checkpoint_ref ?? 'none'})`),
      '',
    ];
    writeFileSync(path, lines.join('\n'));
    return {
      projectionPath: path,
      resumed: {
        predictions: (envelope.openPredictions ?? []).length,
        jobCursors: (envelope.jobCursors ?? []).length,
      },
    };
  }

  /**
   * Execute a task on this body. Two real paths, both honestly labelled:
   *  - `via: 'dsh-cli'`        — the real dsh CLI headless profile, when a bin
   *                              is installed/declared
   *  - `via: 'direct-effect'`  — a concrete shell command run as a direct
   *                              governed effect (shell is a declared
   *                              supported_effect_domain of this body)
   * A missing CLI with no concrete command is reported unavailable, never
   * faked as a successful run.
   */
  async runTask(task, { command = null, workdir = process.cwd(), timeoutMs = 120_000 } = {}) {
    if (this.dshCli && existsSync(this.dshCli)) {
      return this.#spawn([process.execPath, this.dshCli, '--profile', this.dshProfile, task], {
        workdir, timeoutMs, via: 'dsh-cli',
      });
    }
    if (command) {
      return this.#spawn(command, { workdir, timeoutMs, via: 'direct-effect', shell: true });
    }
    return { ok: false, reason: 'dsh cli not installed/declared and no direct command given', unavailable: true };
  }

  #spawn(cmd, { workdir, timeoutMs, via, shell = false }) {
    return new Promise((resolve) => {
      const child = Array.isArray(cmd)
        ? spawn(cmd[0], cmd.slice(1), { cwd: workdir, windowsHide: true })
        : spawn(cmd, { cwd: workdir, windowsHide: true, shell });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const timer = setTimeout(() => { child.kill(); resolve({ ok: false, reason: 'timeout', output: out, via }); }, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, exitCode: code, output: out, via });
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: e.message, via });
      });
    });
  }
}
