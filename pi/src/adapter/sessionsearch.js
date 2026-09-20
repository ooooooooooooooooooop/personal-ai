/**
 * session_search — agent-facing full-text search across persisted session
 * transcripts (Hermes session_search equivalent). The operator's Ctrl+K
 * search already existed; this exposes the same index to the model so it
 * can recall prior work itself instead of asking the human to find it.
 *
 * Returns ranked session hits with text snippets — session files stay on
 * the instance side, the tool never hands the model raw transcript blobs.
 */

/**
 * @param {() => (q:string) => Promise<Array>} getSearch — live sessions.search
 *        facade (late-bound: built after the session exists)
 */
export function sessionSearchTool(getSearch) {
  return {
    name: 'session_search',
    label: 'Session Search',
    description:
      'Full-text search across your past session transcripts in this workspace. ' +
      'Use when the user references earlier work, decisions, or context from a ' +
      'previous conversation — returns session names and matching snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'text to search for in past session messages' },
      },
      required: ['query'],
    },
    async execute(_toolCallId, params) {
      const q = String(params.query ?? '').trim();
      if (!q) {
        return { content: [{ type: 'text', text: 'session_search requires a non-empty query' }], isError: true };
      }
      const search = getSearch?.();
      if (!search) {
        return { content: [{ type: 'text', text: 'session_search unavailable: no session index configured' }], isError: true };
      }
      const hits = await search(q);
      if (!hits?.length) {
        return { content: [{ type: 'text', text: `no past sessions match '${q}'` }] };
      }
      const lines = hits.slice(0, 8).map((h, i) =>
        `${i + 1}. ${h.name ?? h.firstMessage?.slice(0, 60) ?? '(未命名)'} — ${h.modified ?? ''}\n` +
        (h.snippets ?? []).map((s) => `   …${s}…`).join('\n'));
      return { content: [{ type: 'text', text: `${hits.length} session(s) match:\n\n${lines.join('\n\n')}` }] };
    },
  };
}
