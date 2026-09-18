/**
 * update_todos — the agent's live task list (Claude Code TodoWrite analogue).
 *
 * A host-owned custom tool: the model reports its plan as a structured list,
 * we persist it under the instance root keyed by session so a reload or body
 * switch can re-render the same checklist. The tool itself performs no
 * workspace mutation — it writes only the canonical todos file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export function todosPath(instanceRoot, sessionId) {
  return join(instanceRoot, 'todos', `${sessionId ?? 'default'}.json`);
}

export function readTodos(instanceRoot, sessionId) {
  const p = todosPath(instanceRoot, sessionId);
  if (!existsSync(p)) return [];
  try {
    const d = JSON.parse(readFileSync(p, 'utf-8'));
    return Array.isArray(d.todos) ? d.todos : [];
  } catch {
    return [];
  }
}

/**
 * @param {string} instanceRoot
 * @param {() => string|null} getSessionId — current session id at call time
 */
export function updateTodosTool(instanceRoot, getSessionId) {
  return {
    name: 'update_todos',
    label: 'Update Todos',
    description:
      'Report your current task plan as a checklist. Call at the start of any ' +
      'multi-step task, whenever an item is finished (mark it completed), and ' +
      'when the plan changes. The list is visible to the operator in real time. ' +
      'Each item: {content, status: pending|in_progress|completed, activeForm?}.' +
      'Keep exactly one item in_progress.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              activeForm: { type: 'string' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    async execute(_toolCallId, params) {
      const todos = (params.todos ?? []).map((t) => ({
        content: String(t.content ?? ''),
        status: STATUSES.has(t.status) ? t.status : 'pending',
        activeForm: t.activeForm != null ? String(t.activeForm) : null,
      }));
      const sid = getSessionId?.() ?? 'default';
      const p = todosPath(instanceRoot, sid);
      mkdirSync(join(instanceRoot, 'todos'), { recursive: true });
      writeFileSync(p, JSON.stringify({ sessionId: sid, todos, updatedAt: new Date().toISOString() }, null, 2));
      const done = todos.filter((t) => t.status === 'completed').length;
      return {
        content: [{ type: 'text', text: `todo list updated (${done}/${todos.length} completed)` }],
      };
    },
  };
}
