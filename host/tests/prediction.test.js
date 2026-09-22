import { mkdtempSync, appendFileSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PredictionStore } from '../src/core/prediction.js';

function store() {
  const canonical = join(mkdtempSync(join(tmpdir(), 'pai-pred-')), 'canonical');
  return { canonical, predictions: new PredictionStore(canonical) };
}

test('open/close lifecycle: terminal states immutable, closed bind rejected', () => {
  const { predictions } = store();
  const p = predictions.open({ claim: 'edit lands', actor: 'pi' });
  predictions.bindMutation(p.id, { kind: 'file_change', path: 'a.js' });
  predictions.close(p.id, 'confirmed by test run');
  assert.throws(() => predictions.bindMutation(p.id, { kind: 'x' }), /closed prediction/);
  const again = predictions.close(p.id, 'refuted?');
  assert.equal(again.outcome, 'confirmed by test run'); // terminal is immutable
});

test('persist is atomic — no torn index after many writes, no leftover tmp', () => {
  const { canonical, predictions } = store();
  for (let i = 0; i < 20; i++) predictions.open({ claim: `claim-${i}` });
  const dir = join(canonical, 'predictions');
  assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')));
  const reopened = new PredictionStore(canonical);
  assert.equal(reopened.list().length, 20);
});

test('bindings() tolerates a torn tail row instead of hiding the ledger', () => {
  const { canonical, predictions } = store();
  const p = predictions.open({ claim: 'c' });
  predictions.bindMutation(p.id, { kind: 'file_change' });
  appendFileSync(join(canonical, 'predictions', 'bindings.jsonl'), '{"bindingId":"bind-torn","pred');
  const rows = predictions.bindings();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].predictionId, p.id);
});

test('a truncated index fails loud at construction (canonical state, never guessed)', () => {
  const { canonical, predictions } = store();
  predictions.open({ claim: 'seed' }); // index.json only exists after the first persist
  const idx = join(canonical, 'predictions', 'index.json');
  writeFileSync(idx, readFileSync(idx, 'utf-8').slice(0, 5) + '###'); // corrupt
  assert.throws(() => new PredictionStore(canonical));
});

test('M5 parity: claim + outcome are secret-scrubbed; persist leaves no tmp debris', () => {
  const { canonical, predictions } = store();
  const key = `sk-${'a'.repeat(24)}`;
  const p = predictions.open({ claim: `deploy with ${key} stays up` });
  assert.match(p.claim, /\[REDACTED:openai_key\]/);
  predictions.close(p.id, `shipped; rotated ${key}`);
  const raw = readFileSync(join(canonical, 'predictions', 'index.json'), 'utf-8');
  assert.ok(!raw.includes(key), 'secret-shaped span must not reach disk');
  const dirFiles = readdirSync(join(canonical, 'predictions'));
  assert.ok(!dirFiles.some((f) => f.includes('.tmp')), `tmp debris: ${dirFiles}`);
});
