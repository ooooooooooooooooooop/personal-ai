/**
 * Harness-neutral contract surface for Personal AI Host.
 *
 * Everything in core/ speaks these plain-data shapes. Adapters translate
 * engine-specific objects into them at the boundary. No pi/chord types here.
 *
 * @typedef {Object} ToolCallContext
 * @property {string} toolName
 * @property {string} toolCallId
 * @property {Record<string, unknown>} args      post-extension-mutation arguments
 * @property {unknown} assistantMessage
 * @property {unknown} context
 *
 * @typedef {Object} ToolCallDecision
 * @property {boolean} [block]
 * @property {string}  [reason]                  structured, repair-oriented denial reason
 * @property {boolean} [terminate]               end the tool batch, not just this call
 *
 * @typedef {Object} AuditEvent
 * @property {string} kind                       e.g. TOOL_CALL_DENIED, OP_DENIED, PREDICTION_BOUND
 * @property {string} [actor]
 * @property {string} [runId]
 * @property {string} [toolName]
 * @property {string} [predictionId]
 * @property {Record<string, unknown>} [data]
 *
 * @typedef {Object} ManagedExtensionEntry
 * @property {string} id
 * @property {string} path
 * @property {string} sha256                     integrity pin — extension bytes are TCB
 *
 * @typedef {Object} ManagedManifest
 * @property {number} version
 * @property {ManagedExtensionEntry[]} extensions
 *
 * @typedef {Object} InstancePaths
 * @property {string} root                       fail-closed resolved instance root
 * @property {string} auditDir
 * @property {string} jobsDir
 * @property {string} checkpointsDir
 * @property {string} soulDir
 * @property {string} canonicalDir
 *
 * @typedef {Object} TurnEvidence
 * @property {boolean} sufficient
 * @property {string[]} gaps                     structured missing-evidence list
 *
 * @typedef {Object} DomainLease
 * @property {string} domain                     e.g. 'world-model', 'goals', 'jobs'
 * @property {'dsh'|'pi-host'|'external'} writer single-writer ledger entry
 *
 * @typedef {Object} LeaseRecord
 * @property {string} scope                      'domain'|'capability'|'effect'|'task'
 * @property {string} name
 * @property {string} owner                      writer identity (body_id:run_id)
 * @property {number} generation                 fencing token, monotonic per (scope,name)
 * @property {number} expiresAt                  epoch seconds
 *
 * @typedef {Object} BodyFacts
 * @property {string} body_id
 * @property {string} adapter_version
 * @property {Record<string, 'supported'|'partial'|'unsupported'>} capabilities
 * @property {string[]} [supported_effect_domains]
 * @property {Record<string, unknown>} [known_limitations]
 *
 * @typedef {Object} InstructionEnvelope       — authoritative, policy channel
 * @property {'InstructionEnvelope'} kind
 * @property {Object} soulIdentity             {soul_version, schema_version, theory_version, release_tag, content_commit}
 * @property {string} instructions             rendered instruction text
 * @property {string} [policyChecksum]
 * @property {Object} [provenance]
 *
 * @typedef {Object} ContextEnvelope           — dynamic state, context channel
 * @property {'ContextEnvelope'} kind
 * @property {string} briefing
 * @property {unknown[]} [openPredictions]
 * @property {unknown[]} [observations]
 * @property {string} [memoryDigest]
 *
 * @typedef {Object} PortableContinuityEnvelope
 * @property {'PortableContinuityEnvelope'} kind
 * @property {string} goalIdentity
 * @property {string} canonicalCursor
 * @property {Object} soulIdentity
 * @property {unknown[]} openPredictions
 * @property {unknown[]} jobCursors
 * @property {string} policyIdentity
 * @property {string} provenanceChain
 * @property {unknown} [contextProjection]
 * @property {{body:string, session:string, run:string}} source
 *
 * @typedef {Object} EligibilityResult
 * @property {boolean} eligible
 * @property {string[]} degraded               negotiable gaps — run allowed, audit-annotated
 * @property {{invariant:string, reason:string}[]} failClosed  non-negotiable — refuse
 */
export const CONTRACTS_VERSION = 1;
