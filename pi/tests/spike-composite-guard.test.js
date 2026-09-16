/**
 * S0 spike — composite guard against a REAL AgentSession.
 *
 * Verified against @earendil-works/* 0.85.1:
 *  - AgentSession._installAgentToolHooks() assigns agent.beforeToolCall as the
 *    extension tool_call bridge (agent-session.js:224).
 *  - Loop order: prepareArguments → validateToolArguments → beforeToolCall →
 *    execute; the SAME validated args object is passed to the hook and then
 *    executed (agent-loop.js:411-441). Extension mutation via event.input hits
 *    the executed object; Pi does not revalidate after mutation.
 *  - Extension path under test is the REAL one:
 *    DefaultResourceLoader(extensionFactories) → ExtensionRunner → bridge.
 *  - No model/provider is contacted: SessionManager.inMemory() and we invoke
 *    session.agent.beforeToolCall directly with a minimal ctx.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  defineTool,
} from '@earendil-works/pi-coding-agent';
import { installCompositeGuard } from '../src/adapter/session.js';

const stubModel = {
  id: 'stub', name: 'stub', api: 'openai-completions', provider: 'openai',
  baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096,
};

const echoTool = defineTool({
  name: 'echo',
  label: 'Echo',
  description: 'test echo tool',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  async execute(toolCallId, params) {
    return { content: [{ type: 'text', text: String(params.text) }] };
  },
});

function ctx(toolName, args, id = 'tc1') {
  return {
    toolCall: { name: toolName, id, arguments: args },
    args,
    assistantMessage: null,
    context: null,
  };
}

/**
 * Create a real AgentSession whose managed extension mutates event.input.
 * `mutate(event)` runs inside a genuine extension tool_call handler.
 */
async function makeSession(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-s0-'));
  const mutator = (pi) => {
    pi.on('tool_call', (event) => { mutate?.(event); });
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, 'agent'),
    extensionFactories: [{ name: 's0-mutator', factory: mutator }],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: join(dir, 'agent'),
    model: stubModel,
    sessionManager: SessionManager.inMemory(),
    resourceLoader,
    customTools: [echoTool],
  });
  return session;
}

test('S0: extension mutation observed, then revalidate, then final decide', async () => {
  const session = await makeSession((event) => {
    event.input.text = 'MUTATED:' + event.input.text;
  });
  const order = [];
  const guard = installCompositeGuard(session.agent, {
    revalidate: (toolCall, args) => {
      order.push(`revalidate:${args.text}`);
      return { ok: true };
    },
    decide: async (c) => {
      order.push(`decide:${c.args.text}`);
      return undefined;
    },
  });
  assert.ok(guard.sealed());
  const result = await session.agent.beforeToolCall(ctx('echo', { text: 'orig' }));
  assert.equal(result, undefined);
  assert.deepEqual(order, ['revalidate:MUTATED:orig', 'decide:MUTATED:orig']);
});

test('S0: invalid post-mutation args are blocked before decide', async () => {
  const session = await makeSession((event) => {
    delete event.input.text; // extension broke the schema
  });
  const calls = { decide: 0 };
  installCompositeGuard(session.agent, {
    revalidate: (toolCall, args) => (
      args.text === undefined
        ? { ok: false, reason: 'missing required: text' }
        : { ok: true }
    ),
    decide: async () => { calls.decide++; return undefined; },
  });
  const result = await session.agent.beforeToolCall(ctx('echo', { text: 'x' }));
  assert.equal(result.block, true);
  assert.match(result.reason, /post-mutation schema violation: missing required: text/);
  assert.equal(calls.decide, 0);
});

test('S0: normalized args are written back onto the executed object', async () => {
  const session = await makeSession((event) => {
    event.input.text = String(event.input.text); // extension coerces to string
    event.input.extra = 'dropped-by-normalization';
  });
  const seen = {};
  installCompositeGuard(session.agent, {
    // simulates validateToolArguments: returns a NEW normalized object
    revalidate: () => ({ ok: true, normalizedArgs: { text: 'normalized' } }),
    decide: async (c) => { seen.args = { ...c.args }; return undefined; },
  });
  const args = { text: 'raw', extra: 'dropped-by-normalization' };
  const c = ctx('echo', args);
  await session.agent.beforeToolCall(c);
  assert.deepEqual(args, { text: 'normalized' }); // executed object was rewritten
  assert.deepEqual(seen.args, { text: 'normalized' });
});

test('S0: decide throwing fails closed', async () => {
  const session = await makeSession(() => {});
  installCompositeGuard(session.agent, {
    revalidate: () => ({ ok: true }),
    decide: async () => { throw new Error('kernel exploded'); },
  });
  const result = await session.agent.beforeToolCall(ctx('echo', { text: 'x' }));
  assert.equal(result.block, true);
  assert.match(result.reason, /final guard error \(fail-closed\): kernel exploded/);
});

test('S0: coverage across builtin, powershell, and custom tool ctx shapes', async () => {
  const session = await makeSession(() => {});
  const seen = [];
  installCompositeGuard(session.agent, {
    revalidate: (toolCall) => { seen.push(toolCall.name); return { ok: true }; },
    decide: async () => undefined,
  });
  await session.agent.beforeToolCall(ctx('powershell', { command: 'Get-Date' }));
  await session.agent.beforeToolCall(ctx('read', { path: 'x.txt' }));
  await session.agent.beforeToolCall(ctx('echo', { text: 'hi' }));
  assert.deepEqual(seen, ['powershell', 'read', 'echo']);
});

test('S0: seal survives reload swap; a NEW session requires reinstall', async () => {
  const session = await makeSession(() => {});
  const guard = installCompositeGuard(session.agent, {
    revalidate: () => ({ ok: true }),
    decide: async () => undefined,
  });
  assert.ok(guard.sealed());
  // simulate extension-runtime replacement: swap then reseal
  session.agent.beforeToolCall = async () => undefined;
  assert.equal(guard.sealed(), false);
  const resealed = installCompositeGuard(session.agent, {
    revalidate: () => ({ ok: true }),
    decide: async () => undefined,
  });
  assert.ok(resealed.sealed());
  // a new session gets a fresh Pi bridge — the old composite does NOT apply
  const session2 = await makeSession(() => {});
  assert.notEqual(session2.agent.beforeToolCall, undefined);
  assert.notEqual(
    session2.agent.beforeToolCall,
    session.agent.beforeToolCall,
    'new session must carry its own bridge; composite must be reinstalled',
  );
});
