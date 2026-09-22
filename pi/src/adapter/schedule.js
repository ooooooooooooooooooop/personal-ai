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
 * @param {(msg: string) => Promise<{ok?: boolean, refused?: string}>} [deps.promptSink]
 *   governed prompt path for prompt-target entries (coordinator tick)
 * @param {import('../../../host/src/core/goals.js').GoalStore} [deps.goals]
 * @param {import('../../../host/src/core/tasks.js').TaskStore} [deps.tasks]
 * @param {import('../../../host/src/core/jobs.js').JobStore} [deps.jobStore]
 * @param {number} [deps.intervalMs=30000]
 * @returns {{tick: () => Promise<void>, dispose: () => void}}
 */
export function startSchedulerPump({ store, executor, workdir, audit = null, getScope = null, intervalMs = 30_000, promptSink = null, goals = null, tasks = null, jobStore = null, missedWindowMs = 4 * 60 * 60 * 1000 }) {
  let inflight = null;

  // Monitor-skip fingerprint: scratchpad bytes + bound task/job states.
  // An unchanged world means the tick would re-read the same state — skip
  // the LLM call entirely (Hermes cron "no change → skip" analogue).
  const fingerprint = (goal) => {
    const parts = [goals.scratchpadStat(goal.goal_id)];
    for (const tid of goal.task_ids ?? []) {
      const t = tasks?.get(tid);
      parts.push(`${tid}:${t?.state ?? 'missing'}`);
      for (const jid of t?.job_ids ?? (t?.job_id ? [t.job_id] : [])) {
        parts.push(`${jid}:${jobStore?.getJob(jid)?.job_state ?? 'missing'}`);
      }
    }
    return parts.join('|');
  };

  const tickPrompt = (goal) => {
    const bound = (goal.task_ids ?? []).map((tid) => {
      const t = tasks?.get(tid);
      const jobs = (t?.job_ids ?? (t?.job_id ? [t.job_id] : []))
        .map((jid) => `${jid}:${jobStore?.getJob(jid)?.job_state ?? '?'}`).join(',');
      return `- ${tid} [${t?.state ?? 'missing'}] ${t?.label ?? ''}${jobs ? ` jobs:${jobs}` : ''}`;
    }).join('\n');
    const pad = goals.scratchpadTail(goal.goal_id, 1500);
    return [
      `[scheduled goal tick — ${goal.goal_id}]`,
      `Goal: ${goal.statement}`,
      `Last tick: ${goal.last_tick_at ?? 'never'}`,
      bound ? `Bound tasks:\n${bound}` : 'Bound tasks: none yet',
      `Scratchpad:\n${pad || '(empty)'}`,
      'Decide the next action toward the goal: spawn or repair work ' +
      '(delegate_task / schedule_task), bind new tasks with goal_coordinator ' +
      'bind_task, update the scratchpad via goal_coordinator note, and mark ' +
      'the goal done when it is met. If nothing is actionable, say so briefly.',
    ].join('\n');
  };

  // serialized ticks: a tick already in flight absorbs the next call —
  // without it two overlapping ticks both see the same due entry and the
  // schedule double-fires
  const tick = () => inflight ??= (async () => {
    const now = store.now?.() ?? Date.now();
    for (const s of store.due()) {
      // skipMissedJobs analogue: an entry overdue beyond the window (machine
      // was off) is skipped once, not fired — a 3-day-old "check email at
      // 9am" must not fire at 9pm. Skips advance the slot exactly like a
      // fire; lastSkippedAt + audit keep the miss visible.
      if (Number.isFinite(s.nextRunAt) && now - s.nextRunAt > missedWindowMs) {
        store.markSkipped(s.id);
        audit?.write({ kind: 'SCHEDULE_MISSED_SKIP', data: { id: s.id, overdue_ms: now - s.nextRunAt } });
        continue;
      }
      if (s.target === 'prompt') {
        const goal = s.goal_id ? goals?.get(s.goal_id) : null;
        if (s.goal_id && !goal) {
          store.markFired(s.id, null);
          audit?.write({ kind: 'GOAL_TICK_SKIPPED', data: { id: s.id, goal_id: s.goal_id, reason: 'goal_missing' } });
          continue;
        }
        if (goal && goal.state !== 'open') {
          store.markFired(s.id, null);
          audit?.write({ kind: 'GOAL_TICK_SKIPPED', data: { id: s.id, goal_id: goal.goal_id, reason: goal.state } });
          continue;
        }
        const fp = goal ? fingerprint(goal) : null;
        if (goal && fp === goal.fingerprint && goal.last_tick_at) {
          // M135 adaptive rate: quiet tick stretches an adaptive entry's
          // effective interval toward max_seconds; static entries stay put.
          if (s.min_seconds != null) store.markQuiet(s.id);
          else store.markFired(s.id, null);
          audit?.write({ kind: 'GOAL_TICK_UNCHANGED', data: { id: s.id, goal_id: goal.goal_id, quietStreak: s.quietStreak ?? 0 } });
          continue;
        }
        if (!promptSink) {
          store.markFired(s.id, null);
          audit?.write({ kind: 'GOAL_TICK_UNDELIVERED', data: { id: s.id, goal_id: s.goal_id } });
          continue;
        }
        const msg = goal ? tickPrompt(goal) : (s.prompt ?? '');
        const r = await promptSink(msg);
        if (r?.refused) {
          audit?.write({ kind: 'GOAL_TICK_REFUSED', data: { id: s.id, goal_id: s.goal_id, reason: r.refused } });
          continue; // stays due — retry next tick
        }
        store.markFired(s.id, null);
        if (goal) goals.touchTick(goal.goal_id, fp);
        audit?.write({ kind: 'GOAL_TICK_FIRED', data: { id: s.id, goal_id: s.goal_id } });
        continue;
      }
      // M90-R2 parity with job restart: a persisted schedule fires under
      // TODAY'S hard policy, not the policy that admitted it at create time —
      // policy may have tightened while the entry sat in the store. A policy
      // refusal CONSUMES the fire (markFired + loud audit): the denial is
      // stable until policy changes, and leaving the entry due would retry
      // the same denied command every tick forever.
      const gate = await executor.preflightCommand?.({
        command: s.command, workdir, job_type: 'scheduled', budget_scope: getScope?.() ?? null,
      });
      if (gate?.block) {
        store.markFired(s.id, null);
        audit?.write({ kind: 'SCHEDULE_REFUSED_POLICY', data: { id: s.id, rule: gate.rule, reason: gate.reason } });
        continue;
      }
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
      'restarts; a missed run fires once at next boot. Actions: create | list | cancel | pause | resume | edit.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel', 'pause', 'resume', 'edit'] },
        command: { type: 'string', description: 'shell command (create/edit)' },
        prompt: { type: 'string', description: 'prompt text (edit on a prompt-target entry)' },
        run_at: { type: 'string', description: 'ISO timestamp for a one-shot run (create/edit)' },
        every_seconds: { type: 'number', description: 'repeat interval ≥ 60s (create/edit)' },
        min_seconds: { type: 'number', description: 'adaptive rate floor — quiet ticks stretch the interval from every_seconds toward max_seconds (create, requires max_seconds)' },
        max_seconds: { type: 'number', description: 'adaptive rate ceiling (create, requires min_seconds)' },
        label: { type: 'string', description: 'optional human label (create/edit)' },
        id: { type: 'string', description: 'schedule id (cancel/pause/resume/edit)' },
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
              min_seconds: params.min_seconds,
              max_seconds: params.max_seconds,
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
              `${s.id} ${s.enabled === false ? '[disabled] ' : ''}${s.kind}${s.every_seconds ? ` ${s.current_seconds ?? s.every_seconds}s` : ''}${s.min_seconds != null ? `[adapt ${s.min_seconds}–${s.max_seconds}s quiet=${s.quietStreak ?? 0}]` : ''}${s.target === 'prompt' ? '→goal' : ''} next=${new Date(s.nextRunAt).toISOString()} lastFired=${s.lastFiredAt ?? 'never'}${s.lastJobId ? ` job=${s.lastJobId}` : ''} :: ${s.label ?? s.command ?? s.prompt}`,
            ).join('\n'));
          }
          case 'cancel': {
            const r = store.remove(String(params.id ?? ''));
            return r.ok ? text(`cancelled ${params.id}`) : { content: [{ type: 'text', text: r.error }], isError: true };
          }
          case 'pause':
          case 'resume': {
            const r = store.setEnabled(String(params.id ?? ''), params.action === 'resume');
            return r.ok
              ? text(`${params.action === 'resume' ? 'resumed' : 'paused'} ${params.id}`)
              : { content: [{ type: 'text', text: r.error }], isError: true };
          }
          case 'edit': {
            const r = store.edit(String(params.id ?? ''), {
              command: params.command, prompt: params.prompt,
              every_seconds: params.every_seconds, run_at: params.run_at,
              label: params.label,
            });
            return r.ok
              ? text(`edited ${params.id} — next fire ${new Date(r.rec.nextRunAt).toISOString()}`, r.rec)
              : { content: [{ type: 'text', text: r.error }], isError: true };
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
