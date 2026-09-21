import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolSurface } from '../src/adapter/surface.js';
import { toolActivateTool, toolSearchTool } from '../src/adapter/toollazy.js';
import { makeDecide } from '../src/bootstrap/decide.js';
import { FileOpsGuard } from '../src/adapter/fileops.js';
import { AuditWriter } from '../../host/src/core/audit.js';
import { mkdirSync } from 'node:fs';

const fakeSession = (initial) => {
  let active = [...initial];
  return {
    getActiveToolNames: () => [...active],
    setActiveToolsByName: (n) => { active = [...n]; },
  };
};

test('defer hides without denying; activate restores; restart leaves no deny residue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-lazy-'));
  const session = fakeSession(['bash', 'read', 'browser_nav', 'deploy']);
  const surface = new ToolSurface({ session, denyMemoryPath: join(dir, 'deny.json') });
  surface.defer(['browser_nav', 'deploy']);
  assert.deepEqual(session.getActiveToolNames(), ['bash', 'read']);
  assert.equal(surface.isLazy('deploy'), true);
  assert.equal(surface.isDenied('deploy'), false); // lazy ≠ denied
  const got = surface.activate(['deploy', 'bash']); // bash not deferred → ignored
  assert.deepEqual(got, ['deploy']);
  assert.deepEqual(session.getActiveToolNames().sort(), ['bash', 'deploy', 'read']);
  // deny-memory stays clean of lazy names (file may not even exist yet)
  const { existsSync, readFileSync } = await import('node:fs');
  const persisted = existsSync(join(dir, 'deny.json'))
    ? JSON.parse(readFileSync(join(dir, 'deny.json'), 'utf-8'))
    : [];
  assert.ok(!persisted.includes('deploy'));
});

test('tool_activate / tool_search model surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-lazy2-'));
  const session = fakeSession(['read', 'lsp_hover']);
  const surface = new ToolSurface({ session, denyMemoryPath: join(dir, 'd.json') });
  surface.defer(['lsp_hover']);
  const search = toolSearchTool({ getSurface: () => surface, getCatalog: () => [{ name: 'lsp_hover', description: 'hover docs at cursor' }] });
  const s = await search.execute('t', { query: 'hover' });
  assert.match(s.content[0].text, /lsp_hover/);
  const act = toolActivateTool({ getSurface: () => surface });
  const a = await act.execute('t', { names: ['lsp_hover'] });
  assert.match(a.content[0].text, /activated: lsp_hover/);
  assert.deepEqual(session.getActiveToolNames(), ['read', 'lsp_hover']);
});

test('decide blocks a deferred tool call with an activation hint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-lazy3-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  const audit = new AuditWriter({ auditDir: join(dir, 'audit') });
  const session = fakeSession(['read']);
  const surface = new ToolSurface({ session, denyMemoryPath: join(dir, 'd.json') });
  surface.defer(['deploy']);
  const decide = makeDecide({
    core: { audit, kernel: { decideToolCall: async () => null } },
    executor: null, fileOps: new FileOpsGuard(dir), getSurface: () => surface, workdir: dir,
  });
  const r = await decide({ toolCall: { name: 'deploy' }, args: {} });
  assert.equal(r.block, true);
  assert.equal(r.rule, 'tool_deferred');
  assert.match(r.reason, /tool_activate/);
});
