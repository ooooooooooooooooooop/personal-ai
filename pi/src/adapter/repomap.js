/**
 * repo_map — model-facing workspace outline (Aider /map analogue): the host
 * builder walks the tree, extracts top-level declarations, honors .paiignore
 * and the token budget. Read-only; subdir narrowing for big repos.
 */
import { buildRepoMap } from '../../../host/src/core/repomap.js';

export function repoMapTool({ workdir, getIgnored }) {
  return {
    name: 'repo_map',
    label: 'Repo Map',
    description:
      'Structural outline of the workspace: source files with their top-level ' +
      'symbols (functions/classes/types). Use at the start of exploration or ' +
      'when the user asks where something lives. Narrow with `subdir` on large ' +
      'repos; .paiignore-excluded paths never appear.',
    parameters: {
      type: 'object',
      properties: {
        subdir: { type: 'string', description: 'optional subdirectory to map (e.g. "src/adapter")' },
        max_chars: { type: 'number', description: 'output budget, default 12000' },
      },
    },
    async execute(_id, p) {
      const subdir = p?.subdir ? String(p.subdir).replace(/^[\\/]+|[\\/]+$/g, '') : null;
      if (subdir && (subdir.includes('..') || /^[A-Za-z]:/.test(subdir) || subdir.startsWith('/'))) {
        return { content: [{ type: 'text', text: 'repo_map: subdir must be a relative path inside the workspace' }], isError: true };
      }
      const maxChars = Number.isFinite(p?.max_chars) ? Math.min(Math.max(1000, p.max_chars), 40000) : 12000;
      const r = buildRepoMap(workdir, { isIgnored: getIgnored?.() ?? null, subdir, maxChars });
      if (r.error) return { content: [{ type: 'text', text: `repo_map: ${r.error}` }], isError: true };
      if (!r.files) return { content: [{ type: 'text', text: 'repo_map: no source files found' }] };
      const head = `<repo_map files="${r.files}" symbols="${r.symbols}"${r.truncated ? ' truncated="true"' : ''}>`;
      return { content: [{ type: 'text', text: `${head}\n${r.text}\n</repo_map>` }] };
    },
  };
}
