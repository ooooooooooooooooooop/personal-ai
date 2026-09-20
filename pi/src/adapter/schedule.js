/**
 * schedule_task — durable scheduled execution (OpenClaw cron analogue).
 *
 * The tool writes to the host-owned ScheduleStore; a pump in the bootstrap
 * fires due entries as durable jobs (they survive restarts, hold their own
 * write lease, bill into the session budget scope). A refused spawn does NOT
 * consume the fire — the entry stays due and retries on the next tick.
 */

/**
 * @param {import('../../../host/src/core/scheduler.js').ScheduleStore} store
 * @param {object} deps
 * @param {import('./jobs.js').JobExecutor} deps.executor
 * @param {string} deps.workdir
 * @param {import('../../../host/src/core/audit.js').AuditWriter} [deps.audit]
 * @param {() => string|null} [deps.getScope]  budget scope for fired jobs
 * @param {number} [deps.intervalMs=30000]
 * @returns {{tick: () => Promise<void>, dispose: () => void}}
 */
export function startSchedulerPump({ store, executor, workdir, audit = null, getScope = null, intervalMs = 30_000 }) {
  let inflight = null;
  // serialized ticks: a tick already in flight absorbs the next call —
  // without it two overlapping ticks both see the same due entry and the
  // schedule double-fires
  const tick = () => inflight ??= (async () => {
    for (const s of store.due()) {
      const r = await executor.spawnCommandJob({
        command: s.command,
        workdir,
        jobType: 'scheduled',
        budgetScope: getScope?.() ?? null,
      });
      if (r.refused) {
        // not consumed — stays due; audit makes the refusal visible
        audit?.write({ kind: 'SCHEDULE_REFUSED', data: { id: s.id, reason: r.reason } });
        continue;
      }
      store.markFired(s.id, r.job_id ?? null);
      audit?.write({ kind: 'SCHEDULE_FIRED', data: { id: s.id, job_id: r.job_id, kind: s.kind } });
    }
  })().catch(() => {}).finally(() => { inflight = null; });
  const timer = setInterval(() => { tick(); }, intervalMs);
  timer.unref?.();
  tick(); // boot catch-up: missed fires collapse to one run
  return { tick, dispose: () => clearInterval(timer) };
}

/**
 * @param {ScheduleStore} store
 */
export function scheduleTool(store) {
  return {
    name: 'schedule_task',
    label: 'Schedule Task',
    description:
      'Schedule a shell command as a durable job — once at a time (run_at ISO ' +
      'timestamp) or repeatedly (every_seconds, min 60). Scheduled jobs survive ' +
      'restarts; a missed run fires once at next boot. Actions: create | list | cancel.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel'] },
        command: { type: 'string', description: 'shell command (create)' },
        run_at: { type: 'string', description: 'ISO timestamp for a one-shot run (create)' },
        every_seconds: { type: 'number', description: 'repeat interval ≥ 60s (create)' },
        label: { type: 'string', description: 'optional human label (create)' },
        id: { type: 'string', description: 'schedule id (cancel)' },
      },
      required: ['action'],
    },
    async execute(_toolCallId, params) {
      const text = (t, details) => ({ content: [{ type: 'text', text: t }], ...(details ? { details } : {}) });
      try {
        switch (params.action) {
          case 'create': {
            if (params.run_at == null && params.every_seconds == null) {
              return { content: [{ type: 'text', text: 'schedule create requires run_at (one-shot) or every_seconds (interval)' }], isError: true };
            }
            const rec = store.add({
              command: params.command,
              run_at: params.run_at,
              every_seconds: params.every_seconds,
              label: params.label,
            });
            return text(
              `scheduled ${rec.id} (${rec.kind}${rec.every_seconds ? ` ${rec.every_seconds}s` : ''}) — next fire ${new Date(rec.nextRunAt).toISOString()}`,
              rec,
            );
          }
          case 'list': {
            const rows = store.list();
            if (!rows.length) return text('no schedules');
            return text(rows.map((s) =>
              `${s.id} ${s.enabled === false ? '[disabled] ' : ''}${s.kind}${s.every_seconds ? ` ${s.every_seconds}s` : ''} next=${new Date(s.nextRunAt).toISOString()} lastFired=${s.lastFiredAt ?? 'never'}${s.lastJobId ? ` job=${s.lastJobId}` : ''} :: ${s.label ?? s.command}`,
            ).join('\n'));
          }
          case 'cancel': {
            const r = store.remove(String(params.id ?? ''));
            return r.ok ? text(`cancelled ${params.id}`) : { content: [{ type: 'text', text: r.error }], isError: true };
          }
          default:
            return { content: [{ type: 'text', text: `unknown action '${params.action}' (create|list|cancel)` }], isError: true };
        }
      } catch (e) {
        return { content: [{ type: 'text', text: `schedule error: ${e.message}` }], isError: true };
      }
    },
  };
}
