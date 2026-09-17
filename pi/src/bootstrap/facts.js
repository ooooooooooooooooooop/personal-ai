/**
 * Pi body facts — the single source both the composition root (host.js) and
 * out-of-process consumers (app supervisor body discovery) read. Declared
 * coverage, not selection state.
 */

/** Pi body's declared capability coverage — facts, not status. */
export const PI_CAPABILITIES = {
  final_post_extension_guard: 'supported',
  canonical_prediction_binding: 'supported', // M2: kernel binds mutations to open predictions
  loop_observability: 'supported',
  provider_request_audit: 'supported',
  compaction_governance: 'supported', // M3: session_before_compact governance + context-seam preservation
  durable_jobs: 'supported', // M4: JobStore + executor + kill recovery
  mcp_native: 'unsupported', // bridged via RPC/customTools at M4
};

/** Which governance surfaces the Pi body actually enforces (M8-verified). */
export const PI_GOVERNANCE_COVERAGE = {
  tool_decide: 'supported',
  schema_revalidation: 'supported',
  deny_hide: 'supported',
  fileops_guard: 'supported',
  audit: 'supported',
  compaction_hooks: 'supported',
  continuation_steer: 'supported',
  usage_accounting: 'supported',
};

/** Cold-handoff phase support — the full seven-state machine is implemented. */
export const PI_HANDOFF_CAPABILITIES = {
  quiesce: 'supported',
  checkpoint: 'supported',
  release: 'supported',
  acquire: 'supported',
  resume: 'supported',
  verify: 'supported',
};

/**
 * Production session's non-negotiable body requirements — the task profile
 * the selector is measured against. "Pi is the default body" means: pi is
 * the body selectBody() returns for THIS profile, re-evaluated every boot.
 */
export const REQUIRED_BODY_CAPABILITIES = [
  { capability: 'final_post_extension_guard', negotiable: false },
  { capability: 'durable_jobs', negotiable: false },
  { capability: 'provider_request_audit', negotiable: false },
];

/** Registry-ready BodyFacts for the pi body. */
export function piFacts() {
  return {
    body_id: 'pi',
    adapter_version: '0.85.1',
    verified_capabilities: PI_CAPABILITIES,
    governance_coverage: PI_GOVERNANCE_COVERAGE,
    handoff_capabilities: PI_HANDOFF_CAPABILITIES,
    supported_effect_domains: ['tools', 'filesystem', 'shell', 'network'],
    known_limitations: { mcp: 'no native MCP; bridged at M4' },
  };
}
