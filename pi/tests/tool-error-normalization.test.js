/**
 * D08 C21-b defect C regression — a tool that REPORTS failure in its result
 * object never reaches the loop as an error.
 *
 * Physical basis (pi-agent-core 0.85.1):
 *  - agent-loop.js:477 returns `{ result, isError: false }` whenever
 *    tool.execute() resolves. A tool that fails by RETURNING
 *    `{ content, isError: true }` (104 such sites across src/) therefore
 *    never sets the loop's isError.
 *  - That value is what emitToolExecutionEnd (:534) puts on the event, what
 *    createToolResultMessage (:538) stores in the transcript, and what
 *    loopwatch/mistake_limit reads.
 *  - afterToolCall is the only seam that can correct it (:512
 *    `isError = afterResult.isError ?? isError`), applied BEFORE both the
 *    event and the message are built.
 *
 * This test drives the REAL loop (createAgentSession + a scripted
 * streamFunction; stub model, no provider contact) so the event under
 * assertion is the one production emits — not a hand-built object. The old
 * channel-level tests fabricated `{type:'tool_execution_end', isError:true}`,
 * a shape the real loop never produces for these tools, which is why the
 * defect shipped green.
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

// Fails the way every first-party PAI tool fails: a returned result object
// with isError:true. It never throws, so the loop would call this "success".
const failingTool = defineTool({
  name: 'boom',
  label: 'Boom',
  description: 'reports failure in its result object without throwing',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() {
    return { content: [{ type: 'text', text: 'boom requires a parameter' }], isError: true };
  },
});

const okTool = defineTool({
  name: 'fine',
  label: 'Fine',
  description: 'succeeds normally',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute() {
    return { content: [{ type: 'text', text: 'ok' }] };
  },
});

const assistantToolCall = (id, name) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: {} }],
  stopReason: 'toolUse',
  timestamp: Date.now(),
});

const assistantText = (text) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason: 'stop',
  timestamp: Date.now(),
});

/** One scripted assistant message per loop turn; no network is contacted. */
function scriptedStream(script) {
  let turn = 0;
  return () => {
    const message = script[Math.min(turn, script.length - 1)];
    turn += 1;
    const response = {
      async result() { return message; },
    };
    response[Symbol.asyncIterator] = async function* iterate() {
      yield { type: 'done' };
    };
    return response;
  };
}

async function makeSession(customTools) {
  const dir = mkdtempSync(join(tmpdir(), 'pai-toolerr-'));
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, 'agent'),
    extensionFactories: [],
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
    customTools,
  });
  return session;
}

/** Run a scripted turn with the composite installed and return the events. */
async function runScript(script, customTools = [failingTool]) {
  const session = await makeSession(customTools);
  session.agent.streamFunction = scriptedStream(script);
  // No writeLease: exercise the unconditional install path. Correctness of the
  // error flag must never depend on whether a lease happens to be in play.
  const guard = installCompositeGuard(session.agent, {
    revalidate: () => ({ ok: true }),
    decide: async () => undefined,
  });
  assert.ok(guard.sealed(), 'composite must be installed without a write lease');

  const ends = [];
  session.agent.subscribe((ev) => {
    if (ev?.type === 'tool_execution_end') ends.push(ev);
  });
  await session.agent.prompt('go');
  const toolResults = session.agent.state.messages.filter((m) => m.role === 'toolResult');
  return { ends, toolResults };
}

test('a tool that returns {isError:true} surfaces as isError:true on tool_execution_end', async () => {
  const { ends, toolResults } = await runScript([
    assistantToolCall('b1', 'boom'),
    assistantToolCall('b2', 'boom'),
    assistantText('done'),
  ]);

  assert.equal(ends.length, 2, `expected 2 tool_execution_end events, got ${ends.length}`);
  assert.deepEqual(ends.map((e) => e.toolName), ['boom', 'boom']);
  for (const end of ends) {
    assert.equal(
      end.isError,
      true,
      'tool_execution_end.isError must be true when the tool result declares isError — '
      + 'this is what mistake_limit and the post_tool hook read',
    );
  }

  // The transcript is the model's own view: a failed call must not be stored
  // as a success, or the model is told its error worked and retries forever.
  assert.equal(toolResults.length, 2);
  for (const r of toolResults) {
    assert.equal(r.isError, true, 'stored toolResult.isError must match the tool result');
  }
});

test('a tool that succeeds without declaring an error stays isError:false', async () => {
  const { ends, toolResults } = await runScript([
    assistantToolCall('f1', 'fine'),
    assistantText('done'),
  ], [okTool]);

  assert.equal(ends.length, 1);
  assert.equal(ends[0].isError, false, 'normalization must not invent errors');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].isError, false);
});
