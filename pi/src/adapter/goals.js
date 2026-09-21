/**
 * goal_coordinator — long-horizon goal tool (orchestrator family).
 *
 * Creating a goal atomically registers a prompt-kind schedule: at each due
 * tick the pump fires a governed prompt carrying the goal statement, bound
 * task states, and the scratchpad tail — the agent wakes, decides the next
 * action, and writes continuity notes back. Command schedules keep running
 * dead commands; goal schedules run *thinking*.
 */

const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra });

/**
 * @param {import('../../../host/src/core/goals.js').GoalStore} goals
 * @param {import('../../../host/src/core/scheduler.js').ScheduleStore} schedules
 */
export function goalCoordinatorTool(goals, schedules) {
  return {
    name: 'goal_coordinator',
    label: 'Goal Coordinator',
    description:
      'Track a long-horizon goal: creates a durable goal record plus a ' +
      'prompt-kind schedule that periodically wakes the agent with goal ' +
      'context (bound tasks, scratchpad notes) to decide the next step. ' +
      'Actions: create | list | note | bind_task | pause | resume | done.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'note', 'bind_task', 'pause', 'resume', 'done'] },
        statement: { type: 'string', description: 'goal statement (create)' },
        run_at: { type: 'string', description: 'ISO timestamp for a one-shot tick (create)' },
        every_seconds: { type: 'number', description: 'repeat tick interval ≥ 60s (create)' },
        id: { type: 'string', description: 'goal id (all actions except create/list)' },
        text: { type: 'string', description: 'scratchpad note line (note)' },
        task_id: { type: 'string', description: 'task to bind (bind_task)' },
      },
      required: ['action'],
    },
    async execute(_toolCallId, params) {
      try {
        switch (params.action) {
          case 'create': {
            if (params.run_at == null && params.every_seconds == null) {
              return { ...text('goal create requires run_at (one-shot tick) or every_seconds (interval tick)'), isError: true };
            }
            const goal = goals.create({ statement: params.statement });
            const rec = schedules.add({
              prompt: goal.statement,
              goal_id: goal.goal_id,
              run_at: params.run_at,
              every_seconds: params.every_seconds,
              label: `goal:${goal.goal_id}`,
            });
            goals.bindSchedule(goal.goal_id, rec.id);
            return text(
              `goal ${goal.goal_id} armed — tick schedule ${rec.id} fires ${new Date(rec.nextRunAt).toISOString()}`,
              { details: { goal, schedule: rec } },
            );
          }
          case 'list': {
            const rows = goals.list();
            if (!rows.length) return text('no goals');
            return text(rows.map((g) =>
              `${g.goal_id} [${g.state}] schedule=${g.schedule_id ?? '—'} tasks=${g.task_ids.length} lastTick=${g.last_tick_at ?? 'never'} :: ${g.statement.slice(0, 80)}`,
            ).join('\n'));
          }
          case 'note': {
            const g = goals.note(String(params.id ?? ''), params.text);
            return g ? text(`noted on ${params.id}`) : { ...text(`no goal '${params.id}'`), isError: true };
          }
          case 'bind_task': {
            const g = goals.bindTask(String(params.id ?? ''), String(params.task_id ?? ''));
            return g ? text(`bound ${params.task_id} to ${params.id}`) : { ...text(`no goal '${params.id}'`), isError: true };
          }
          case 'pause':
          case 'resume':
          case 'done': {
            const state = params.action === 'resume' ? 'open' : params.action;
            const g = goals.setState(String(params.id ?? ''), state);
            if (!g) return { ...text(`no goal '${params.id}'`), isError: true };
            if (g.error) return { ...text(g.error), isError: true };
            return text(`goal ${params.id} → ${g.state}`);
          }
          default:
            return { ...text(`unknown action '${params.action}' (create|list|note|bind_task|pause|resume|done)`), isError: true };
        }
      } catch (e) {
        return { ...text(`goal error: ${e.message}`), isError: true };
      }
    },
  };
}
