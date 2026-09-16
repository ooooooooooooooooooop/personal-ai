/**
 * Pi-side channel facade — maps the real AgentSession + host core onto the
 * harness-neutral HostChannel contract. This is where Pi-specific state
 * shapes get translated into plain-data snapshots a UI can consume.
 */
import { HostChannel } from '../../../host/src/core/channel.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {object} deps
 * @param {object} deps.session   real AgentSession
 * @param {object} deps.core      host core ({paths, audit, ...})
 * @param {object} [deps.jobs]    JobStore
 */
export function createChannelHost({ session, core, jobs = null }) {
  const auditPath = join(core.paths.auditDir, 'host-audit.jsonl');
  const sessionFacade = {
    prompt: (message, options) => session.prompt(message, options),
    steer: (message) => session.steer(message),
    abort: async () => { await session.abort?.(); },
    getState: async () => ({
      model: session.model ? { provider: session.model.provider, id: session.model.id } : null,
      streaming: Boolean(session.isStreaming),
      messageCount: session.messages?.length ?? null,
    }),
    subscribe: (listener) => session.subscribe(listener),
  };
  const auditFacade = {
    tail: (n) => {
      if (!existsSync(auditPath)) return [];
      const lines = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).map((l) => JSON.parse(l));
    },
  };
  return new HostChannel({ session: sessionFacade, jobs, audit: auditFacade });
}
