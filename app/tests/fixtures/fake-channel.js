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

const deletedSessions = new Set();
// The body reports the session it actually switched to — get_state mirrors
// the last session_switch, like a real body would.
let currentFile = `${instance}/sessions/s1.jsonl`;
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
      return reply({
        model: { provider: 'fake', id: 'fake-1' }, streaming: false,
        messageCount: Number(process.env.FAKE_MSGS ?? 0),
        session: { file: currentFile, name: 'DOM验收' },
        contextUsage: { tokens: 51200, contextWindow: 200000 },
      });
    case 'prompt': {
      write({ type: 'event', event: { type: 'agent_start' } });
      write({ type: 'event', event: { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } } });
      const imgN = (cmd.options?.images?.length ?? 0)
        + (cmd.options?.attachments ?? []).filter((a) => a.mime?.startsWith('image/')).length;
      write({ type: 'event', event: { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: `echo:${cmd.message}${imgN ? ` | 收到图片 ${imgN}` : ''}` }] } } });
      if (process.env.FAKE_SCENARIO === 'domgate') {
        // Scripted turn for the DOM gate: a real tool card, then a pending
        // ask carrying a real payload — resolved when decision_resolve lands.
        write({ type: 'event', event: { type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'echo domgate' } } });
        write({ type: 'event', event: { type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'domgate-out' }] } } });
        write({ type: 'event', event: { type: 'tool_execution_start', toolCallId: 'tc2', toolName: 'edit', args: { path: 'src/a.js', oldText: 'const x = 1;', newText: 'const x = 2;' } } });
        write({ type: 'event', event: { type: 'tool_execution_end', toolCallId: 'tc2', toolName: 'edit', isError: false, result: { content: [{ type: 'text', text: 'edited' }] } } });
        write({
          type: 'event', event: {
            type: 'governance_ask', ask: {
              id: 'ask-dom-1', toolName: 'bash', riskCategory: 'shell',
              summary: 'bash: rm -rf scratch/', expiresAt: Date.now() + 60000,
              args: { command: 'rm -rf scratch/' },
            },
          },
        });
        return reply({ accepted: true, awaiting: 'decision' });
      }
      write({ type: 'event', event: { type: 'agent_end', messages: [] } });
      return reply({ echoed: cmd.message });
    }
    case 'decision_resolve':
      write({ type: 'event', event: { type: 'governance_resolved', askId: cmd.askId, answer: cmd.answer } });
      write({ type: 'event', event: { type: 'tool_execution_start', toolCallId: 'tc3', toolName: 'bash', args: { command: 'rm -rf scratch/' } } });
      write({ type: 'event', event: { type: 'tool_execution_end', toolCallId: 'tc3', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'removed' }] } } });
      write({ type: 'event', event: { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } });
      write({ type: 'event', event: { type: 'message_end', message: { role: 'assistant', usage: { cost: { total: 0.0042 } } } } });
      write({ type: 'event', event: { type: 'agent_end', messages: [] } });
      return reply({ resolved: cmd.askId });
    case 'steer':
    case 'abort':
      return reply({});
    case 'session_stats':
      return reply({
        sessionId: 'sess-fake', totalMessages: 4, userMessages: 2, assistantMessages: 2,
        tokens: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, total: 1500 },
        cost: 0.0042,
      });
    case 'todos_list':
      return reply([
        { id: 't1', content: '盘点实现缺口', status: 'completed' },
        { id: 't2', content: '写 DOM 门测试', status: 'in_progress', activeForm: '正在写 DOM 门测试' },
      ]);
    case 'pending_list': return reply([]);
    case 'session_list': {
      const rows = [
        { path: `${instance}/sessions/s1.jsonl`, id: 'sess-1', name: 'DOM验收', firstMessage: 'hello', modified: '2026-01-01T00:00:00Z', messageCount: 3 },
      ];
      // #143 dom-gate needs a second, distinct session to prove resume
      // actually switches — other fixtures see the original single row.
      if (process.env.FAKE_SCENARIO === 'domgate') {
        rows.push({ path: `${instance}/sessions/s2.jsonl`, id: 'sess-2', name: 'resume-target', firstMessage: 'second', modified: '2026-01-01T00:01:00Z', messageCount: 1 });
      }
      return reply(rows.filter((s) => !deletedSessions.has(s.path)));
    }
    case 'session_switch':
      currentFile = cmd.path;
      return reply({ id: 'sess-2', file: cmd.path, name: 'resume-target' });
    case 'session_new':
      return reply({ id: 'sess-new', file: `${instance}/sessions/new.jsonl` });
    case 'model_set':
      return reply({ applied: true, model: { provider: cmd.provider ?? 'fake', id: cmd.model ?? cmd.alias ?? 'fake-2' } });
    case 'config_get':
      return reply({ model: { provider: 'fake', id: 'fake-1' }, thinking: 'medium', mode: 'execute' });
    case 'config_set':
      return reply({ applied: true, key: cmd.key, value: cmd.value });
    case 'session_history': return reply([]);
    case 'model_status': return reply({
      current: { provider: 'fake', id: 'fake-1', name: 'fake-1' },
      providers: [{ id: 'fake', hasAuth: true }],
      thinkingLevel: 'medium',
    });
    case 'model_list': return reply([{ provider: 'fake', id: 'fake-1', name: 'fake-1', reasoning: false }]);
    case 'risk_mode': return reply({ mode: 'execute' });
    case 'job_spawn':
      if (!cmd.command) return fail('command required');
      return reply({ ok: true, jobId: 'fake-job-1', worktree: cmd.worktree === true });
    case 'job_status':
      return reply({
        job: { job_id: cmd.job_id, job_type: 'shell', job_state: 'RUNNING', orchestration_state: 'foreground' },
        attempts: 1,
        lease: { writer_id: 'fake-writer' },
        detail: {
          command: 'pytest -q', running: true, exit_code: null,
          output_tail: 'collecting… 12 items',
          events: [{ timestamp: '2026-01-01T00:00:01Z', event_type: 'SPAWN' }],
        },
      });
    case 'job_cancel': return reply({ killed: true });
    case 'bash_run':
      if (!cmd.command) return fail('command required');
      return reply({ output: `domgate-bash-out[${cmd.command}]`, code: 0 });
    case 'job_list':
      return reply([{ job_id: 'job-dom-1', job_type: 'shell', job_state: 'RUNNING', updated_at: '2026-01-01T00:00:00Z' }]);
    case 'audit_tail': return reply([]);
    case 'session_entries': return reply([]);
    case 'session_export': return fail('export unsupported in fixture');
    case 'session_search': return reply([]);
    case 'session_delete': {
      deletedSessions.add(cmd.path);
      return reply({ removed: cmd.path });
    }
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
