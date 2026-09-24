/**
 * pai-channel CLI flags — dedup-h #2124: --output-schema <json>|@<path>
 * fail-loud-at-startup posture (subprocess operators invoke the flag, not
 * raw prompt options). Schema arming/injection reuses the #238 path.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const BIN = new URL('../bin/pai-channel.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dir = () => mkdtempSync(join(tmpdir(), 'pai-cli-'));

const run = (args, { input = '' } = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf-8', timeout: 30000 });

test('#2124 --output-schema: malformed JSON and unreadable @path fail loud at startup', () => {
  const d = dir();
  const bad = run(['--instance', d, '--output-schema', '{not json']);
  assert.equal(bad.status, 2, `expected exit 2, got ${bad.status}: ${bad.stderr}`);
  assert.match(bad.stderr, /--output-schema is not a valid JSON schema object/);

  const missing = run(['--instance', d, '--output-schema', '@/nonexistent/schema.json']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--output-schema .*nonexistent/);

  const notObject = run(['--instance', d, '--output-schema', '[1,2]']);
  assert.equal(notObject.status, 2, 'array is not a schema object');
});

test('#2124 --output-schema: valid spec (inline + @file) boots and serves stdin', () => {
  const d = dir();
  mkdirSync(join(d, 'canonical'), { recursive: true });
  writeFileSync(join(d, 'canonical', 'policy.json'), JSON.stringify({
    version: 1, deny: [], tools: {}, riskActions: { destructive: 'deny', privilege: 'deny' },
  }));
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
  // stdin closes immediately — the channel boots (host assembly proves the
  // flag parsed) then exits cleanly on EOF.
  const inline = run(['--instance', d, '--workdir', d, '--output-schema', JSON.stringify(schema)]);
  assert.notEqual(inline.status, 2, `flag rejected: ${inline.stderr}`);
  assert.doesNotMatch(inline.stderr, /--output-schema/);

  const schemaFile = join(d, 'schema.json');
  writeFileSync(schemaFile, JSON.stringify(schema));
  const atPath = run(['--instance', d, '--workdir', d, '--output-schema', `@${schemaFile}`]);
  assert.notEqual(atPath.status, 2, `@path flag rejected: ${atPath.stderr}`);
});
