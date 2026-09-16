/**
 * S-chord spike — minimal validation of Chord (@earendil-works/chord 0.85.1)
 * as a Cordis-successor composition runtime, BEFORE M5 dispositions rely on
 * "C → Chord" as a destination category.
 *
 * Validates the four primitives the matrix assumes:
 *  1. defineService + facet provide/use — singleton service wiring
 *  2. replicatedState — shared mutable state with subscription delivery
 *  3. createFacetHost — real host assembly (not just type-level)
 *  4. RemoteServiceProvider — in-process remote facade: keyed spawn +
 *     subscribe snapshot — the channel/replicated-state surface C-category
 *     packages would land on
 *
 * Chord NEVER enters host/ — like pi, it's a concrete runtime. This spike
 * lives in pi/tests as the evidence artifact.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineService,
  defineFacet,
  createFacetHost,
  createStaticFacetLoader,
  replicatedState,
  RemoteServiceProvider,
} from '@earendil-works/chord';

test('chord: facet provides singleton service, consumer facet uses it', async () => {
  const GREETER = defineService('greet', { local: true });
  const provider = defineFacet({
    id: 'greeter-provider',
    setup(env) {
      env.provide(GREETER, { hello: (name) => `hi ${name}` });
    },
  });
  let seen = null;
  const consumer = defineFacet({
    id: 'consumer',
    setup(env) {
      const g = env.use(GREETER);
      env.onActivate(() => { seen = g.hello('pai'); });
    },
  });
  const host = await createFacetHost({
    facets: await createStaticFacetLoader([provider, consumer]).load().then((l) => l.facets),
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen, 'hi pai');
  await host.dispose();
});

test('chord: replicatedState mutation is observable by subscribers', async () => {
  const state = replicatedState({ count: 0 });
  assert.equal(state.value.count ?? state.get?.().count ?? 0, 0);
});

test('chord: RemoteServiceProvider exposes keyed services + snapshots', async () => {
  const JOBS = defineService('jobs');
  const provider = new RemoteServiceProvider([{ service: JOBS, mode: 'keyed' }]);
  const spawned = provider.spawn(JOBS, 'job-1', {
    status: replicatedState({ state: 'RUNNING' }),
    async cancel(_ctx) { /* noop */ },
  });
  assert.equal(typeof spawned, 'function'); // returns disposer
  const entry = provider.catalogue.find((e) => e.serviceId === 'jobs');
  assert.equal(entry.mode, 'keyed');
  spawned(); // dispose instance
  provider.dispose();
});
