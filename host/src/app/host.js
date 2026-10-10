import { instancePaths } from '../core/instance.js';
import { AuditWriter } from '../core/audit.js';
import { loadManagedManifest } from '../core/manifest.js';
import { loadCanonicalState, loadSoul } from '../core/loaders.js';
import { GovernanceKernel } from '../core/governance.js';
import { AttestedPolicy } from '../core/policy.js';
import { PredictionStore } from '../core/prediction.js';
import { ObservationStore } from '../core/observation.js';
import { BodyRegistry } from '../core/registry.js';
import { DomainLeaseStore } from '../core/lease.js';
import { HandoffStore } from '../core/handoff.js';
import { writeRuntimeIdentity } from '../core/identity.js';
import {
  buildContextEnvelope,
  buildInstructionEnvelope,
} from '../core/envelopes.js';

/**
 * Harness-neutral host core. This is NOT the composition root — it knows no
 * concrete body. A body package (pi/, a future x/) calls this and injects the
 * engine session. Direction: body → host, never host → body.
 */
export function createHostCore({ instanceRoot, manifestPath, runtime = null, governance = {} }) {
  const paths = instancePaths(instanceRoot); // fail-closed on git worktree
  const audit = new AuditWriter(paths, {
    annotations: {
      runId: runtime?.runId ?? null,
      actor: runtime?.adapter?.id ?? null,
    },
  });
  const manifest = loadManagedManifest(manifestPath);
  const soul = loadSoul(paths);
  const canonical = loadCanonicalState(paths);
  // M2: canonical policy + prediction store are fail-closed requirements —
  // a kernel without them cannot prove invariants #4/#5.
  // policy is a governed canonical artifact (attested); the prediction and
  // observation stores are instance RUNTIME state — they persist across
  // compaction/handoff/body-switch via the instance root, not via canonicalDir
  // (owner-adjudicated boundary 2026-10-10: canonical = governed artifacts only).
  const policy = new AttestedPolicy(paths.canonicalDir, governance.policyFile);
  const predictions = new PredictionStore(paths.worldModelDir);
  const observations = new ObservationStore(paths.worldModelDir);
  const kernel = new GovernanceKernel({
    audit,
    policy,
    predictions,
    commandClassifier: governance.commandClassifier ?? null,
    commandArgs: governance.commandArgs ?? {},
    protectedRoots: governance.protectedRoots ?? [
      paths.auditDir, paths.jobsDir, paths.checkpointsDir,
    ],
    ask: governance.ask ?? null,
    modeProvider: governance.modeProvider ?? null,
    modeOverlay: governance.modeOverlay ?? null,
    mutatingTools: governance.mutatingTools ?? [],
    commandAllowlist: governance.commandAllowlist ?? null,
  });
  const registry = new BodyRegistry(paths);
  const leases = new DomainLeaseStore(paths);
  const handoffs = new HandoffStore(paths);

  // Two-channel envelopes (R9): instruction ≠ dynamic context.
  const instructionEnvelope = buildInstructionEnvelope({
    soulManifest: soul.manifest,
    policyText: canonical.files['instruction/generated.md'] ?? '',
  });
  // Dynamic context provider: open predictions / observations are re-read on
  // EVERY context event, so a post-compaction turn re-receives the live
  // world-model projection instead of a session-start snapshot.
  const contextProvider = () => buildContextEnvelope({
    // The COMPILED briefing, read from the canonical — where its declared
    // compiler writes it (soul/manifest.json: "compiler": "mind/canonical_compile.py",
    // which emits <canonical>/briefing.md). It was being read from the soul dir
    // instead (soul/briefing/briefing.md), which nothing ever writes, so the
    // model received no briefing at all. Compiled artifacts live with the
    // canonical; the soul carries the contract for them, not the output.
    briefing: canonical.files['briefing.md'] ?? '',
    openPredictions: predictions.openPredictions(),
    observations: observations.recent(20),
  });
  const contextEnvelope = contextProvider();

  const identity = runtime
    ? writeRuntimeIdentity(paths, runtime)
    : null;

  return {
    paths, audit, manifest, soul, canonical, kernel,
    policy, predictions, observations,
    registry, leases, handoffs, identity,
    instructionEnvelope, contextEnvelope, contextProvider,
  };
}
