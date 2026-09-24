import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { installCompositeGuard } from './session.js';
import { createRevalidator } from './revalidate.js';
import { loopGovernanceExtension } from './loop.js';
import { outputSpoolExtension } from './outspool.js';
import { injectionHygieneExtension } from './injectionhygiene.js';
import { withRenderedReason } from './errors.js';
import { hashOf } from '../../../host/src/core/audit.js';
import { renderContext, renderInstruction } from '../../../host/src/core/envelopes.js';
import { realpathSync, unlinkSync } from 'node:fs';
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
export function providerAuditExtension(audit, getHooks = null) {
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
        // dedup-h #1698 — llm_input observational hook: the assembled
        // provider payload pre-send. Bounded preview + hash + byte count —
        // a request can be hundreds of KB; the hash pins full content.
        try {
          const json = JSON.stringify(event.payload ?? null);
          getHooks?.()?.fire('llm_input', {
            seq: requestCount,
            model: event.payload?.model ?? null,
            messages: Array.isArray(messages) ? messages.length : null,
            payloadHash: hashOf(event.payload),
            bytes: json.length,
            preview: json.slice(0, 16384),
          });
        } catch { /* observational — never blocks the request path */ }
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
        // dedup-h #1698 — llm_output observational hook: the response line
        // post-receive (status + headers; the body streams after this event,
        // so the honest payload is the response envelope, not content).
        try {
          getHooks?.()?.fire('llm_output', {
            seq: requestCount,
            status: event.status,
            headers: event.headers ?? null,
          });
        } catch { /* observational — never blocks the response path */ }
      });
      // usage lives on assistant messages, not the provider event.
      // model rides along so usage history can break down by model, not
      // just by day — without it per-model cost attribution is impossible.
      pi.on('message_end', (event) => {
        const u = event.message?.usage;
        if (event.message?.role !== 'assistant' || !u) return;
        audit.write({
          kind: 'TURN_ACCOUNTING',
          data: {
            seq: requestCount,
            model: event.message?.model ?? null,
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
        // a plain envelope object renders as a fixed snapshot. The latest
        // user text is handed over as a relevance hint (typed-memory
        // per-turn injection analogue) — providers may ignore it.
        const lastUser = [...(event.messages ?? [])].reverse().find((m) => m?.role === 'user');
        const hint = (lastUser?.content ?? [])
          .map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join(' ').slice(0, 400);
        const env = typeof contextEnvelope === 'function' ? contextEnvelope(hint) : contextEnvelope;
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
// A1 parity: confinement must hold on the REAL path. A junction/symlink
// inside sessionDir passes a lexical startsWith yet makes an outside file
// the live session store (open) or the unlink target (remove). realpath
// failure fails closed — open/remove only ever touch existing files.
const confinedSessionPath = (path, sessionDir) => {
  const abs = resolve(path);
  if (!abs.startsWith(resolve(sessionDir) + sep)) throw new Error('session path outside sessionDir');
  let realAbs;
  try { realAbs = realpathSync(abs); } catch { throw new Error('session path unresolvable'); }
  let realDir;
  try { realDir = realpathSync(sessionDir); } catch { realDir = resolve(sessionDir); }
  if (realAbs !== realDir && !realAbs.startsWith(realDir + sep)) {
    throw new Error('session path outside sessionDir (via symlink)');
  }
  return abs;
};

export const sessionManagers = {
  create: (cwd, sessionDir, options) => SessionManager.create(cwd, sessionDir, options),
  // M71: in-memory session — never touches sessionDir; nothing to purge
  inMemory: (cwd) => SessionManager.inMemory(cwd),
  // Open = adopt the file as the live session — future turns APPEND to it.
  // Same confinement as remove: a crafted path ('../../etc/passwd') must not
  // become the session store, or the next prompt writes JSONL anywhere.
  open: (path, sessionDir) => SessionManager.open(confinedSessionPath(path, sessionDir), sessionDir),
  list: (cwd, sessionDir) => SessionManager.list(cwd, sessionDir),
  forkFrom: (sourcePath, cwd, sessionDir) => SessionManager.forkFrom(sourcePath, cwd, sessionDir),
  // Delete = unlink the session file — contained to sessionDir so a crafted
  // path cannot reach outside the session store.
  remove: (path, sessionDir) => {
    const abs = confinedSessionPath(path, sessionDir);
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
  outputSpool = null, // M38 — tool_result seam externalizes oversized outputs
  customTools = [], // host-owned tools (job_status, delegate_task) — go through the same composite chain
  excludeTools = [], // policy-derived initial suppression — model never sees them
  extraExtensions = [], // additional inline extension factories (e.g. the world-model shim)
  getHooks = null, // dedup-h #1698 — lazy HookRunner accessor for llm_input/llm_output
}) {
  const resourceLoader = new DefaultResourceLoader({
    cwd: workdir,
    agentDir: sessionOptions.agentDir,
    noExtensions: true, // zero-discovery: only manifest-verified + inline load
    additionalExtensionPaths: managedExtensions.map((e) => e.path),
    extensionFactories: [
      ...(audit ? [providerAuditExtension(audit, getHooks)] : []),
      ...(contextEnvelope ? [contextEnvelopeExtension(contextEnvelope)] : []),
      ...(audit && loopGovernance
        ? [loopGovernanceExtension({ ...loopGovernance, contextEnvelope, audit, workdir })]
        : []),
      ...(outputSpool ? [outputSpoolExtension({ spool: outputSpool, audit })] : []),
      // Inline factories supplied by the composition root (a body adapter's own
      // extension). Kept generic: createPiSession does not know what they do.
      ...extraExtensions,
      injectionHygieneExtension({ audit }),
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
