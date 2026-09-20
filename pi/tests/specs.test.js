import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { specTools } from '../src/adapter/specs.js';

const rig = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pai-spec-'));
  return { dir, tools: specTools({ getWorkdir: () => dir }) };
};
const named = (tools, n) => tools.find((t) => t.name === n);

test('spec_init scaffolds the triple; duplicate refused; bad name refused', async () => {
  const { dir, tools } = rig();
  try {
    const init = named(tools, 'spec_init');
    const r = await init.execute('t1', { name: 'search-redesign' });
    assert.match(r.content[0].text, /initialized/);
    for (const f of ['spec.md', 'design.md', 'tasks.md']) {
      assert.ok(existsSync(join(dir, '.pai', 'specs', 'search-redesign', f)), f);
    }
    const dup = await init.execute('t2', { name: 'search-redesign' });
    assert.equal(dup.isError, true);
    const bad = await init.execute('t3', { name: '../escape' });
    assert.equal(bad.isError, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('spec_status reports phase progression from artifact state, not claims', async () => {
  const { dir, tools } = rig();
  try {
    const init = named(tools, 'spec_init');
    const status = named(tools, 'spec_status');
    await init.execute('t1', { name: 's1' });
    let r = await status.execute('t2', { name: 's1' });
    assert.equal(r.details.phase, 'requirements'); // scaffold only — nothing written yet

    // write real requirements → phase advances to design
    const specPath = join(dir, '.pai', 'specs', 's1', 'spec.md');
    writeFileSync(specPath, '# s1\n## Requirements\n- [ ] R1: The system shall persist sessions across restarts with an append-only journal and resumable checkpoints.\n');
    r = await status.execute('t3', { name: 's1' });
    assert.equal(r.details.phase, 'design');

    // design + tasks done → complete
    writeFileSync(join(dir, '.pai', 'specs', 's1', 'design.md'), '# design\n## Approach\nJournal per session, fsync on turn boundaries, replay on boot.');
    writeFileSync(join(dir, '.pai', 'specs', 's1', 'tasks.md'), '- [x] T1: journal writer\n- [x] T2: boot replay\n');
    r = await status.execute('t4', { name: 's1' });
    assert.equal(r.details.phase, 'complete');
    assert.deepEqual(r.details.tasks, { total: 2, done: 2 });

    // list all
    r = await status.execute('t5', {});
    assert.match(r.content[0].text, /s1: complete 2\/2 tasks/);
    const missing = await status.execute('t6', { name: 'nope' });
    assert.equal(missing.isError, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
