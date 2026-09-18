import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { installCompositeGuard } from './session.js';
import { createRevalidator } from './revalidate.js';
import { loopGovernanceExtension } from './loop.js';
import { withRenderedReason } from './errors.js';
import { hashOf } from '../../../host/src/core/audit.js';
import { renderContext, renderInstruction } from '../../../host/src/core/envelopes.js';
import { unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Create a Pi-backed engine session owned by the Host.
 *
 * All @earendil-works imports live in this package; host/ sees only plain
 * contracts. Direction is pi → host, never host → pi.
 *
 * Managed mode: `noExtensions: true` kills auto-discovery; only
 * manifest-verified extension paths + host-owned inline factories load.
 */

/** Host-owned inline extension: provider-request audit probe (redacted). */
function providerAuditExtension(audit) {
  return {
    name: 'pai-provider-audit',
    factory: (pi) => {
      let requestCount = 0;
      let systemPrefixHash = null; // prefix-cache invariant: must stay constant
      pi.on('before_provider_request', (event) => {
        requestCount += 1;
        const messages = event.payload?.messages;
        const sys = Array.isArray(messages) && messages[0]?.role === 'system'
          ? messages[0] : null;
        const sysHash = sys ? hashOf(sys) : null;
        let prefixBreak = false;
        if (systemPrefixHash === null) systemPrefixHash = sysHash;
        else if (sysHash !== systemPrefixHash) prefixBreak = true; // cache invariant violated
        audit.write({
          kind: prefixBreak ? 'PREFIX_CACHE_BREAK' : 'PROVIDER_REQUEST',
          data: { seq: requestCount, payloadHash: hashOf(event.payload), systemPrefixHash: sysHash },
        });
      });
      pi.on('before_provider_headers', (event) => {
        audit.write({
          kind: 'PROVIDER_HEADERS',
          data: { headers: event.headers }, // AuditWriter redacts auth keys
        });
      });
      pi.on('after_provider_response', (event) => {
        audit.write({
          kind: 'PROVIDER_RESPONSE',
          data: { seq: requestCount, status: event.status },
        });
      });
      // usage lives on assistant messages, not the provider event
      pi.on('message_end', (event) => {
        const u = event.message?.usage;
        if (event.message?.role !== 'assistant' || !u) return;
        audit.write({
          kind: 'TURN_ACCOUNTING',
          data: {
            seq: requestCount,
            input: u.input ?? null,
            output: u.output ?? null,
            cacheRead: u.cacheRead ?? null,
            totalTokens: u.totalTokens ?? null,
            cost: u.cost ?? null,
          },
        });
      });
    },
  };
}

/** Host-owned inline extension: ContextEnvelope → context seam per turn. */
export function contextEnvelopeExtension(contextEnvelope) {
  return {
    name: 'pai-context-envelope',
    factory: (pi) => {
      pi.on('context', (event) => {
        // a provider fn re-reads live state each turn (post-compaction too);
        // a plain envelope object renders as a fixed snapshot.
        const env = typeof contextEnvelope === 'function' ? contextEnvelope() : contextEnvelope;
        const briefing = renderContext(env);
        if (!briefing) return undefined;
        return {
          messages: [
            ...event.messages,
            { role: 'user', content: [{ type: 'text', text: briefing }] },
          ],
        };
      });
    },
  };
}

/** Persisted-session lifecycle — the only @earendil-works seam bootstrap needs. */
export const sessionManagers = {
  create: (cwd, sessionDir) => SessionManager.create(cwd, sessionDir),
  open: (path, sessionDir) => SessionManager.open(path, sessionDir),
  list: (cwd, sessionDir) => SessionManager.list(cwd, sessionDir),
  forkFrom: (sourcePath, cwd, sessionDir) => SessionManager.forkFrom(sourcePath, cwd, sessionDir),
  // Delete = unlink the session file — contained to sessionDir so a crafted
  // path cannot reach outside the session store.
  remove: (path, sessionDir) => {
    const abs = resolve(path);
    if (!abs.startsWith(resolve(sessionDir) + sep)) throw new Error('session path outside sessionDir');
    unlinkSync(abs);
    return { removed: abs };
  },
};

export async function createPiSession({
  sessionOptions = {},
  workdir,
  managedExtensions = [],
  instructionEnvelope = null,
  contextEnvelope = null,
  audit = null,
  revalidate,
  decide,
  writeLease = null, // workspace write mutex — fg mutating calls hold it through execution
  loopGovernance = null, // {continuation, predictions} — M3 evidence-gated loop
  customTools = [], // host-owned tools (job_status, delegate_task) — go through the same composite chain
  excludeTools = [], // policy-derived initial suppression — model never sees them
}) {
  const resourceLoader = new DefaultResourceLoader({
    cwd: workdir,
    agentDir: sessionOptions.agentDir,
    noExtensions: true, // zero-discovery: only manifest-verified + inline load
    additionalExtensionPaths: managedExtensions.map((e) => e.path),
    extensionFactories: [
      ...(audit ? [providerAuditExtension(audit)] : []),
      ...(contextEnvelope ? [contextEnvelopeExtension(contextEnvelope)] : []),
      ...(audit && loopGovernance
        ? [loopGovernanceExtension({ ...loopGovernance, contextEnvelope, audit })]
        : []),
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    ...(instructionEnvelope
      ? { appendSystemPrompt: [renderInstruction(instructionEnvelope)] }
      : {}),
  });
  await resourceLoader.reload();

  const { session, extensionsResult } = await createAgentSession({
    cwd: workdir,
    sessionManager: SessionManager.inMemory(),
    ...sessionOptions,
    customTools: [...customTools, ...(sessionOptions.customTools ?? [])],
    excludeTools: [...excludeTools, ...(sessionOptions.excludeTools ?? [])],
    resourceLoader,
  });
  // M2: real revalidation against the session's own tool registry —
  // the schema the loop used pre-mutation is the schema we re-apply post-mutation.
  const effectiveRevalidate =
    revalidate ?? createRevalidator((name) => session.getToolDefinition(name));
  const effectiveDecide = decide
    ? async (ctx, signal) => withRenderedReason(await decide(ctx, signal), ctx)
    : decide;
  const guard = installCompositeGuard(session.agent, {
    revalidate: effectiveRevalidate,
    decide: effectiveDecide,
    writeLease,
  });
  return { session, guard, extensionsResult };
}
