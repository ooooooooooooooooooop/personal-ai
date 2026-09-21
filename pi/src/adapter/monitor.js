/**
 * Event-driven monitor wake (CodeBuddy Monitor / OpenHands ambient analogue):
 * the scheduler polls; a monitor WATCHES — fs.watch on an operator-declared
 * path fires a governed prompt through the same promptSink as goal ticks
 * (budget admission, audit, governance per tool call). Busy sessions refuse
 * and the event is dropped — monitors are notifications, not queues.
 *
 * Registry is in-memory for the process lifetime; entries are operator-owned
 * (channel commands), never model-spawned — an agent must not arm its own
 * wakeup source.
 */
import { watch } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const DEBOUNCE_MS = 1_500;

export class MonitorRegistry {
  /** @param {(msg:string)=>Promise<{ok?:boolean,refused?:string}>} promptSink */
  constructor({ promptSink, audit = null, now = () => Date.now() }) {
    this.promptSink = promptSink;
    this.audit = audit;
    this.now = now;
    this.monitors = new Map(); // id → {id, path, prompt, watcher, lastFired, fires}
    this.seq = 0;
  }

  /** @returns {{id:string}|{error:string}} */
  add({ path, prompt }) {
    const abs = resolve(String(path ?? ''));
    if (!existsSync(abs)) return { error: `watch path not found: ${abs}` };
    if (!String(prompt ?? '').trim()) return { error: 'monitor requires a prompt' };
    const id = `mon-${++this.seq}-${this.now().toString(36)}`;
    const rec = {
      id, path: abs, prompt: String(prompt).trim().slice(0, 2000),
      dir: statSync(abs).isDirectory(),
      watcher: null, lastFired: 0, fires: 0, _timer: null,
    };
    const onEvent = () => {
      clearTimeout(rec._timer);
      rec._timer = setTimeout(async () => {
        rec.lastFired = this.now(); rec.fires += 1;
        this.audit?.write({ kind: 'MONITOR_FIRED', data: { id, path: abs, fires: rec.fires } });
        try {
          const r = await this.promptSink(`[monitor:${id}] watched path changed: ${abs}\n${rec.prompt}`);
          if (r?.refused) this.audit?.write({ kind: 'MONITOR_FIRE_REFUSED', data: { id, reason: r.refused } });
        } catch (e) {
          this.audit?.write({ kind: 'MONITOR_FIRE_ERROR', data: { id, error: String(e?.message ?? e).slice(0, 200) } });
        }
      }, DEBOUNCE_MS);
      rec._timer.unref?.();
    };
    try {
      rec.watcher = rec.dir ? watch(abs, onEvent) : watch(abs, onEvent);
    } catch (e) {
      return { error: `watch failed: ${e.message}` };
    }
    this.monitors.set(id, rec);
    this.audit?.write({ kind: 'MONITOR_ADDED', data: { id, path: abs } });
    return { id };
  }

  remove(id) {
    const rec = this.monitors.get(id);
    if (!rec) return { error: `no monitor '${id}'` };
    clearTimeout(rec._timer);
    rec.watcher?.close();
    this.monitors.delete(id);
    this.audit?.write({ kind: 'MONITOR_REMOVED', data: { id } });
    return { removed: id };
  }

  list() {
    return [...this.monitors.values()].map(({ watcher, _timer, ...r }) => r);
  }

  dispose() {
    for (const id of [...this.monitors.keys()]) this.remove(id);
  }
}
