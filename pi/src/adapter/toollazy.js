/**
 * M83 lazy tool surface — deferred loading + on-demand activation.
 *
 * <instance>/defer-tools.json {defer:[names]} hides listed tools from the
 * model's schema surface at session start (ToolSurface.defer — NOT a deny,
 * not persisted). The model discovers them via tool_search and claims them
 * with tool_activate; a guessed call to a deferred tool is refused by the
 * decide chain (rule 'tool_deferred') until activated.
 *
 * Keeps the system prompt small when many tools are configured — Claude's
 * ToolSearch / lazy-tool-catalogue analogue.
 */

const txt = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra });

/** Activate deferred tools by name → they join the visible surface. */
export function toolActivateTool({ getSurface }) {
  return {
    name: 'tool_activate', label: 'Tool Activate',
    description:
      'Activate deferred (lazy) tools by name — the tool\'s full schema becomes ' +
      'available immediately. Use tool_search to discover deferred tools first.',
    parameters: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'deferred tool names to activate' },
      },
      required: ['names'],
    },
    promptSnippet: 'tool_activate(names): claim deferred tools onto the visible surface',
    async execute(_id, params) {
      const surface = getSurface?.();
      if (!surface?.activate) return txt('tool_activate unavailable — no tool surface', { isError: true });
      const names = Array.isArray(params.names) ? params.names.map(String) : [];
      if (!names.length) return txt('tool_activate requires names[]', { isError: true });
      const activated = surface.activate(names);
      const still = names.filter((n) => !activated.includes(n));
      return txt(
        activated.length
          ? `activated: ${activated.join(', ')}` + (still.length ? ` — not deferred/unknown: ${still.join(', ')}` : '')
          : `nothing activated — not deferred or unknown: ${still.join(', ')}`,
      );
    },
  };
}

/** Search the deferred tool catalogue by keyword over name+description. */
export function toolSearchTool({ getSurface, getCatalog }) {
  return {
    name: 'tool_search', label: 'Tool Search',
    description:
      'Search deferred (lazy) tools by keyword — returns matching tool names ' +
      'and descriptions. Activate a hit with tool_activate before calling it.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keyword(s) matched against deferred tool names and descriptions' },
      },
      required: ['query'],
    },
    promptSnippet: 'tool_search(query): discover deferred tools by keyword',
    async execute(_id, params) {
      const surface = getSurface?.();
      if (!surface?.lazyList) return txt('tool_search unavailable — no tool surface', { isError: true });
      const lazy = new Set(surface.lazyList());
      if (!lazy.size) return txt('no deferred tools — everything configured is already visible');
      const q = String(params.query ?? '').toLowerCase().trim();
      const terms = q.split(/\s+/).filter(Boolean);
      const catalog = (getCatalog?.() ?? []).filter((t) => lazy.has(t.name));
      const hits = catalog
        .filter((t) => !terms.length || terms.every((w) => `${t.name} ${t.description ?? ''}`.toLowerCase().includes(w)))
        .slice(0, 20);
      const list = hits.length
        ? hits.map((t) => `${t.name} — ${String(t.description ?? '').split('\n')[0].slice(0, 140)}`).join('\n')
        : '(no matches)';
      return txt(`deferred tools matching '${q}':\n${list}\n\nactivate with tool_activate({names:[...]})`);
    },
  };
}
