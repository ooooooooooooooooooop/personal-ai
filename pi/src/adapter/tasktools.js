/**
 * AgentTask primitive tools (F-family) — the model-facing state machine:
 * spawn rides delegate_task (task record auto-created); these tools are the
 * send/wait/yield/interrupt/close/list verbs over the TaskStore mailbox.
 * Every call is a normal governed tool call — the mailbox is data, not a
 * governance bypass.
 */
const txt = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra });
const need = (v, name) => (v == null || v === '' ? `task tool requires \`${name}\`` : null);

export function taskTools(store, { interrupt = null } = {}) {
  const resolve = (id) => store.get(String(id ?? ''));
  return [
    {
      name: 'task_list', label: 'Task List',
      description: 'List AgentTask records (delegated work): state, label, job binding, message counts.',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const rows = store.list().map((t) => ({
          task_id: t.task_id, label: t.label, state: t.state, kind: t.kind,
          job_id: t.job_id, created: t.created,
          inbox: t.inbox_count, outbox: t.outbox_count, events: t.events_count,
        }));
        return txt(rows.length ? JSON.stringify(rows) : 'no tasks yet');
      },
    },
    {
      name: 'task_send', label: 'Task Send',
      description: 'Send a message to a delegated task\'s inbox — delivered as steering to the child while it runs.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' }, message: { type: 'string' } },
        required: ['task_id', 'message'],
      },
      async execute(_id, p) {
        const err = need(p.task_id, 'task_id') ?? need(p.message, 'message');
        if (err) return txt(err, { isError: true });
        const t = resolve(p.task_id);
        if (!t) return txt(`task '${p.task_id}' not found`, { isError: true });
        const r = store.postInbox(t.task_id, { from: 'parent', body: p.message });
        if (r?.refused) return txt(`send refused: ${r.refused}`, { isError: true });
        return txt(`delivered to ${t.task_id} inbox (seq ${r.seq}) — the bridge steers it into the running child`);
      },
    },
    {
      name: 'task_wait', label: 'Task Wait',
      description: 'Wait for the next child→parent message on a task. Returns new outbox rows or a timeout.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          timeout_ms: { type: 'number', description: 'max wait, capped at 120s (default 30s)' },
        },
        required: ['task_id'],
      },
      async execute(_id, p) {
        const err = need(p.task_id, 'task_id');
        if (err) return txt(err, { isError: true });
        const t = resolve(p.task_id);
        if (!t) return txt(`task '${p.task_id}' not found`, { isError: true });
        const since = t.acks?.outbox ?? 0;
        const r = await store.waitOutbox(t.task_id, { since, timeoutMs: Number(p.timeout_ms ?? 30_000) });
        if (r.rows.length) {
          const last = r.rows[r.rows.length - 1].seq;
          store.ack(t.task_id, 'outbox', last);
          return txt(JSON.stringify({ messages: r.rows.map((x) => ({ seq: x.seq, from: x.from, body: x.body })) }));
        }
        return txt(JSON.stringify({ messages: [], timedOut: r.timedOut, task_state: r.state }));
      },
    },
    {
      name: 'task_yield', label: 'Task Yield',
      description: 'Post a progress note onto the task\'s shared event stream — visible to the operator task center.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          note: { type: 'string', description: 'short progress note' },
        },
        required: ['task_id', 'note'],
      },
      async execute(_id, p) {
        const err = need(p.task_id, 'task_id') ?? need(p.note, 'note');
        if (err) return txt(err, { isError: true });
        const t = resolve(p.task_id);
        if (!t) return txt(`task '${p.task_id}' not found`, { isError: true });
        const r = store.postEvent(t.task_id, 'parent_note', { note: p.note });
        return txt(`posted event seq ${r.seq} on ${t.task_id}`);
      },
    },
    {
      name: 'task_interrupt', label: 'Task Interrupt',
      description: 'Interrupt a running delegated task — cancels the bound durable job (terminal for the worker).',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
      async execute(_id, p) {
        const err = need(p.task_id, 'task_id');
        if (err) return txt(err, { isError: true });
        const t = resolve(p.task_id);
        if (!t) return txt(`task '${p.task_id}' not found`, { isError: true });
        if (!interrupt) return txt('interrupt unavailable — no job executor bound', { isError: true });
        const r = t.job_id ? await interrupt(t.job_id) : { ok: false, reason: 'task has no bound job' };
        store.postEvent(t.task_id, 'interrupted', { job_id: t.job_id, ok: r?.ok !== false });
        return txt(r?.ok === false ? `interrupt failed: ${r.reason ?? 'unknown'}` : `task ${t.task_id} interrupted (job ${t.job_id} cancelled)`);
      },
    },
    {
      name: 'teammate_msg', label: 'Teammate Message',
      description: 'Message a NAMED teammate by pool name (delegate_task with `name` creates one). Resolves the latest open task carrying that name and delivers to its inbox.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['name', 'message'],
      },
      async execute(_id, p) {
        const err = need(p.name, 'name') ?? need(p.message, 'message');
        if (err) return txt(err, { isError: true });
        const t = store.byName(p.name);
        if (!t) return txt(`no teammate named '${p.name}' — create one via delegate_task(name=...)`, { isError: true });
        const r = store.postInbox(t.task_id, { from: 'parent', body: p.message });
        if (r?.refused) return txt(`send refused: ${r.refused}`, { isError: true });
        return txt(`delivered to teammate '${t.name}' (${t.task_id}) inbox seq ${r.seq}`);
      },
    },
    {
      name: 'task_close', label: 'Task Close',
      description: 'Close a task — no further inbox posts; the event stream stays readable.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
      async execute(_id, p) {
        const err = need(p.task_id, 'task_id');
        if (err) return txt(err, { isError: true });
        const t = store.setState(String(p.task_id), 'closed');
        if (!t) return txt(`task '${p.task_id}' not found`, { isError: true });
        return txt(`task ${t.task_id} closed`);
      },
    },
  ];
}
