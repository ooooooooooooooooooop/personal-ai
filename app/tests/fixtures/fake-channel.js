#!/usr/bin/env node
/**
 * Fixture body channel — a real JSONL subprocess speaking the host protocol
 * subset the supervisor drives. It holds a REAL domain lease on the instance
 * (like the pi body's canonical-writer claim) so body switches exercise the
 * actual lease baton, and handoff_export computes real hashes from the real
 * canonical stores — nothing canned.
 *
 * env: FAKE_BODY (body id), FAKE_MSGS (get_state messageCount),
 *      FAKE_LEASE (domain lease name, default 'session-writer'),
 *      FAKE_INSTANCE (instance root, from --instance arg)
 */
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainLeaseStore } from '../../../host/src/core/lease.js';
import { PredictionStore } from '../../../host/src/core/prediction.js';
import { loadPolicy } from '../../../host/src/core/policy.js';

const args = process.argv.slice(2);
const instance = args[args.indexOf('--instance') + 1];
const body = process.env.FAKE_BODY ?? 'fake';
const runId = `fake-run-${body}-${randomUUID().slice(0, 6)}`;
const leaseName = process.env.FAKE_LEASE ?? 'session-writer';
const owner = `${body}:${runId}`;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const leases = new DomainLeaseStore({ root: instance });
let held = null;
try {
  const c = leases.claim({ scope: 'domain', name: leaseName, owner, ttlSeconds: 8 });
  if (c.ok) held = c.lease;
} catch { /* lease contention is reported, not fatal */ }

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let cmd;
  try { cmd = JSON.parse(t); } catch { write({ type: 'response', success: false, error: 'bad json' }); return; }
  const reply = (data) => write({ id: cmd.id, type: 'response', command: cmd.type, success: true, data });
  const fail = (error) => write({ id: cmd.id, type: 'response', command: cmd.type, success: false, error });
  switch (cmd.type) {
    case 'body_info':
      return reply({ body_id: body, runId, sessionId: `sess-${body}` });
    case 'get_state':
      return reply({ model: { provider: 'fake', id: 'fake-1' }, streaming: false, messageCount: Number(process.env.FAKE_MSGS ?? 0) });
    case 'prompt':
      write({ type: 'event', event: { type: 'agent_start' } });
      write({ type: 'event', event: { type: 'message_start', message: { content: [{ type: 'text', text: '' }] } } });
      write({ type: 'event', event: { type: 'message_update', message: { content: [{ type: 'text', text: `echo:${cmd.message}` }] } } });
      write({ type: 'event', event: { type: 'agent_end', messages: [] } });
      return reply({ echoed: cmd.message });
    case 'steer':
    case 'abort':
      return reply({});
    case 'job_status': return fail('no jobs');
    case 'job_list': return reply([]);
    case 'audit_tail': return reply([]);
    case 'handoff_prepare':
      return reply({
        runId, sessionId: `sess-${body}`,
        heldLeases: held ? [{ scope: 'domain', name: leaseName, owner, generation: held.generation }] : [],
      });
    case 'handoff_export': {
      const policy = loadPolicy(join(instance, 'canonical'));
      const predictions = new PredictionStore(join(instance, 'canonical'));
      return reply({
        goalIdentity: `goal:sess-${body}`,
        canonicalCursor: `sha256:${sha256(JSON.stringify(predictions.openPredictions()))}`,
        soulIdentity: 'soul:personal-ai',
        openPredictions: predictions.openPredictions().map((p) => p.id),
        jobCursors: [],
        policyIdentity: `sha256:${policy.checksum}`,
        provenanceChain: [runId],
        source: { body, session: `sess-${body}`, run: runId },
      });
    }
    case 'handoff_release': {
      let released = [];
      if (held) {
        const r = leases.release({ scope: 'domain', name: leaseName, owner, generation: held.generation });
        if (r.ok) released = [leaseName];
        held = null;
      }
      return reply({ released });
    }
    default:
      return fail(`unknown command '${cmd.type}'`);
  }
});
rl.on('close', () => {
  if (held) {
    leases.release({ scope: 'domain', name: leaseName, owner, generation: held.generation });
    held = null;
  }
  leases.close();
  process.exit(0);
});
