/**
 * TEST-M77-01 — task-detail poll lifecycle sentinel (reviewer-flagged
 * coverage debt). Asserts the M77 contract on the REAL app.js functions:
 *
 *   openTask        → exactly one live 1.5s poll
 *   re-open/second  → still exactly one (no interval leak)
 *   task closed     → poll stops inside paintTask
 *   leave 'jobs'    → poll stops
 *   re-enter 'jobs' → poll restarts while a task is open
 *
 * app.js is a zero-build browser script — it runs inside a vm context over
 * a minimal DOM stub; setInterval/clearInterval are fake (spy, never fire)
 * so the test asserts lifecycle intent, not timing luck.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const APP = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'ui', 'app.js');

/* ---------- minimal DOM stub ---------- */
// universal member: callable AND coerces to '' — covers el.value.trim(),
// el.dataset.x, unknown methods alike
const anyStub = new Proxy(function () {}, {
  get(t, k) {
    if (k === Symbol.toPrimitive) return () => '';
    return anyStub;
  },
  apply: () => anyStub,
  set: () => true,
});

function makeEl() {
  const t = {
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: new Proxy({}, {
      get: (o, k) => o[k] ?? (() => undefined),
      set: (o, k, v) => { o[k] = v; return true; },
    }),
    dataset: {},
    value: '', textContent: '', innerHTML: '', id: '',
    disabled: false, checked: false, hidden: false,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, offsetTop: 0, offsetHeight: 0,
    children: [],
    appendChild(c) { t.children.push(c); return c; },
    insertBefore(c) { t.children.push(c); return c; },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    remove() {}, focus() {}, select() {}, click() {},
    scrollIntoView() {}, setPointerCapture() {}, releasePointerCapture() {},
    cloneNode: () => makeEl(),
    closest: () => null, matches: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, height: 100, width: 100 }),
    dispatchEvent: () => true,
  };
  return new Proxy(t, {
    get(o, k) {
      if (k in o) return o[k];
      return anyStub;
    },
    set(o, k, v) { o[k] = v; return true; },
  });
}

function makeHarness() {
  const els = new Map();
  const getEl = (id) => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); };

  // fake interval registry — ids are ours, callbacks never fire
  const intervals = new Map();
  let seq = 0;
  const setIntervalSpy = (fn, ms) => { const id = ++seq; intervals.set(id, { ms, cleared: false }); return id; };
  const clearIntervalSpy = (id) => { const iv = intervals.get(id); if (iv) iv.cleared = true; };
  const livePolls = () => [...intervals.values()].filter((i) => i.ms === 1500 && !i.cleared).length;

  let taskState = 'running'; // mutable: paintTask reads task.state each call
  const fetchStub = async (_url, init) => {
    let type = null;
    try { type = JSON.parse(init?.body ?? '{}').type; } catch { /* opaque */ }
    const data = type === 'task_events'
      ? { task: { state: taskState }, inbox: [], outbox: [], events: [] }
      : [];
    return { json: async () => ({ success: true, data }) };
  };

  const ctx = {
    console,
    setInterval: setIntervalSpy,
    clearInterval: clearIntervalSpy,
    setTimeout: () => 0, clearTimeout() {},
    fetch: fetchStub,
    document: {
      getElementById: getEl,
      createElement: () => makeEl(),
      querySelector: () => makeEl(),
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      body: makeEl(), documentElement: makeEl(),
      hidden: false,
    },
    window: { addEventListener() {}, focus() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    Notification: class { static permission = 'default'; static requestPermission = async () => 'default'; },
    EventSource: class { constructor() {} close() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 0,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    confirm: () => true,
    alert() {},
    location: { href: '', reload() {} },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(APP, 'utf-8'), ctx, { filename: 'app.js' });
  return { ctx, livePolls, setTaskState: (s) => { taskState = s; } };
}

test('M77 lifecycle: open → one poll; close/leave → stop; re-enter → restart; no leaks', async () => {
  const { ctx, livePolls, setTaskState } = makeHarness();
  // let the module-level init IIFE settle against the stubs
  await new Promise((r) => setImmediate(r));

  assert.equal(livePolls(), 0, 'no task poll before a task is opened');

  await ctx.openTask('t-1');
  assert.equal(livePolls(), 1, 'open starts exactly one 1.5s poll');

  await ctx.openTask('t-2');
  assert.equal(livePolls(), 1, 're-opening must not leak a second interval');

  // closed task → paintTask sees state=closed and stops the poll
  setTaskState('closed');
  await ctx.paintTask();
  assert.equal(livePolls(), 0, 'closed task stops polling');

  // reopen a live task, then leave the jobs view → poll stops
  setTaskState('running');
  await ctx.openTask('t-3');
  assert.equal(livePolls(), 1);
  ctx.switchView('audit');
  assert.equal(livePolls(), 0, 'leaving the jobs view stops the poll');

  // re-enter jobs with a task still open → poll restarts
  ctx.switchView('jobs');
  await new Promise((r) => setImmediate(r)); // refreshJobs is fire-and-forget async
  assert.equal(livePolls(), 1, 're-entering jobs restarts the poll for the open task');

  // leave again — clean teardown, no residue
  ctx.switchView('chat');
  assert.equal(livePolls(), 0);
});
