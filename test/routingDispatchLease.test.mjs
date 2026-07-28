import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { cleanup, makeEmptyDir } from './helpers.mjs';
import {
  ROUTING_PROFILE_VERSION,
  commitRoutingProfilePair,
  readComposedRoutingProfile,
} from '../src/lib/routingProfile.mjs';
import { deriveRoutingPolicy } from '../src/lib/routingProfilePolicy.mjs';
import { sealAccessGraph } from '../src/lib/routingAccessGraph.mjs';
import { writeAccessGraphDocument } from '../src/lib/routingAccessGraphStore.mjs';
import { dispatchResolvedRoute } from '../src/lib/routeDispatcher.mjs';
import {
  DEFAULT_DISPATCH_LEASE_TTL_MS,
  DISPATCH_LEASE_VERSION,
  awaitWriteTurn,
  createDispatchLeaseRegistry,
  createPersistedRoutingSnapshot,
  openDispatchLease,
} from '../src/lib/routingDispatchLease.mjs';

const IDENTITY = Object.freeze({
  key: 'c4f0a1d2-3b4c-4d5e-8f90-1a2b3c4d5e6f',
  value: 'c4f0a1d2-3b4c-4d5e-8f90-1a2b3c4d5e6f',
  source: 'git-marker',
  confidence: 'stable',
  markerPath: null,
});

/** A pinned inventory fixture: the roster reconciles against a known pair set. */
const INVENTORY = Object.freeze({
  revision: 'sha256-inventory-lease-1',
  pairs: Object.freeze([
    Object.freeze({
      surface: 'claude-code', provider: 'anthropic', modelId: 'claude-opus-5', effort: 'high',
    }),
  ]),
});

const globalProfile = (overrides = {}) => ({
  schemaVersion: ROUTING_PROFILE_VERSION,
  registryRevision: 1,
  selectedSurfaces: ['claude-code'],
  consideredSurfaces: ['claude-code'],
  authorizedTransports: [{ surface: 'claude-code', transport: 'native' }],
  switching: 'ask',
  roster: [{ model: 'claude-opus-5', effort: 'high', state: 'admitted' }],
  inventoryRevision: INVENTORY.revision,
  standardRoutes: {
    mechanical: null,
    development: { model: 'claude-opus-5', effort: 'high', state: 'configured' },
    judgment: null,
  },
  advanced: null,
  ...overrides,
});

const ACCESS_PATH = Object.freeze({
  id: 'claude-native-opus-high',
  surfaceId: 'claude-code',
  providerId: 'anthropic',
  modelId: 'claude-opus-5',
  effort: 'high',
  transportId: 'native',
  availability: 'available',
  enforcement: { model: 'named-agent', effort: 'named-agent' },
  capabilityEvidence: {
    revision: 'capability-1',
    observedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
  },
  attestation: {
    result: 'available',
    failureKind: null,
    probeId: 'capability-probe:minimal',
    authorizationId: 'probe-authorization-1',
    observedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
  },
});

const catalogDocument = (revision) => ({
  schemaVersion: 1,
  revision,
  models: [{ providerId: 'anthropic', modelId: 'claude-opus-5' }],
  observations: [{
    id: 'observation-1',
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    effort: 'high',
    workload: 'development',
    harness: { id: 'fixture', version: '1' },
    score: 0.9,
    source: {
      owner: 'fixture', id: 'fixture', url: 'https://example.invalid/evidence',
      benchmark: 'fixture', version: '1', snapshotHash: 'hash-1',
    },
    uncertainty: { kind: 'interval', value: 0.1 },
    freshness: {
      observedAt: '2026-07-01T00:00:00.000Z',
      expiresAt: '2026-08-01T00:00:00.000Z',
    },
    cost: { amount: 1, currency: 'USD', unit: 'task' },
  }],
});

const preparedRoute = (requestedRoute, dispatch) => ({
  appliedRoute: requestedRoute,
  enforcement: { model: 'named-agent', effort: 'named-agent' },
  precedence: {
    model: 'agent-definition-over-environment',
    effort: 'agent-definition-over-environment',
  },
  dispatch,
});

/**
 * A real user-local routing store on disk: two committed profile generations, a
 * stored Access graph and an Evidence catalog the caller can move underneath a
 * running dispatch. The resolver input is derived from exactly those bytes, so a
 * dispatcher that re-reads them sees the same revisions it decided against.
 */
async function makeRoutingStore() {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const accessGraphFile = join(consumer, '.test-user-state', 'access-graph.json');
  const catalog = { current: catalogDocument('catalog-lease-1') };
  await commitRoutingProfilePair({
    profileRoot, identity: IDENTITY, global: globalProfile(), inventory: INVENTORY,
  });
  const graph = sealAccessGraph([ACCESS_PATH]);
  await writeAccessGraphDocument(accessGraphFile, graph, { expectedRevision: null });

  const snapshot = createPersistedRoutingSnapshot({
    profileRoot,
    identity: IDENTITY,
    inventory: INVENTORY,
    accessGraphFile,
    readCatalog: async () => catalog.current,
  });

  const resolverInput = async (overrides = {}) => {
    const profile = await readComposedRoutingProfile({
      profileRoot, identity: IDENTITY, inventory: INVENTORY,
    });
    const policy = deriveRoutingPolicy({
      composed: profile.composed,
      globalGeneration: profile.global.generation,
      projectGeneration: profile.project?.generation ?? null,
    });
    return {
      intent: { version: 1, workload: 'development', reasoning: 'deep' },
      catalog: catalog.current,
      accessGraph: graph,
      policy,
      activeSurface: 'claude-code',
      knownTransports: ['native'],
      now: '2026-07-23T12:00:00.000Z',
      ...overrides,
    };
  };

  const commitExternalNarrowing = () => commitRoutingProfilePair({
    profileRoot,
    identity: IDENTITY,
    global: globalProfile({ switching: 'current-surface-only' }),
    inventory: INVENTORY,
  });

  return {
    consumer, profileRoot, accessGraphFile, snapshot, catalog, resolverInput,
    commitExternalNarrowing,
  };
}

test('a store-backed dispatch lease binds the recomputed policy and dispatches once', async () => {
  const store = await makeRoutingStore();
  try {
    const registry = createDispatchLeaseRegistry();
    let invoked = 0;
    const result = await dispatchResolvedRoute({
      executionId: 'execution-lease-ok',
      afk: true,
      resolverInput: await store.resolverInput(),
      adapter: {
        prepare: async (requestedRoute) => preparedRoute(requestedRoute, async () => {
          invoked += 1;
          return { taskId: 'lease-task-1' };
        }),
      },
      lease: { registry, key: IDENTITY.key, snapshot: store.snapshot },
      dispatchedAt: '2026-07-23T12:00:01.000Z',
    });

    assert.equal(result.receipt.status, 'dispatched');
    assert.equal(result.dispatchResult.taskId, 'lease-task-1');
    assert.equal(invoked, 1);
    assert.equal(registry.inspect(IDENTITY.key).held, false, 'the lease is released after dispatch');
  } finally {
    await cleanup(store.consumer);
  }
});

test('an external profile mutation between reread and spawn fails the lease', async () => {
  const store = await makeRoutingStore();
  try {
    const registry = createDispatchLeaseRegistry();
    let invoked = 0;
    const result = await dispatchResolvedRoute({
      executionId: 'execution-lease-mutated',
      afk: true,
      resolverInput: await store.resolverInput(),
      adapter: {
        prepare: async (requestedRoute) => {
          // An uncoordinated writer — another process — commits mid-handoff.
          await store.commitExternalNarrowing();
          return preparedRoute(requestedRoute, async () => {
            invoked += 1;
            return { taskId: 'must-not-run' };
          });
        },
      },
      lease: { registry, key: IDENTITY.key, snapshot: store.snapshot },
      dispatchedAt: '2026-07-23T12:00:01.000Z',
    });

    assert.equal(result.receipt.status, 'blocked');
    assert.equal(result.receipt.reason, 'concurrent routing profile mutation');
    assert.equal(invoked, 0);
    assert.equal(registry.inspect(IDENTITY.key).held, false);
  } finally {
    await cleanup(store.consumer);
  }
});

test('an external evidence catalog refresh between reread and spawn fails the lease', async () => {
  const store = await makeRoutingStore();
  try {
    const registry = createDispatchLeaseRegistry();
    let invoked = 0;
    const result = await dispatchResolvedRoute({
      executionId: 'execution-lease-catalog',
      afk: true,
      resolverInput: await store.resolverInput(),
      adapter: {
        prepare: async (requestedRoute) => {
          store.catalog.current = catalogDocument('catalog-lease-2');
          return preparedRoute(requestedRoute, async () => {
            invoked += 1;
            return { taskId: 'must-not-run' };
          });
        },
      },
      lease: { registry, key: IDENTITY.key, snapshot: store.snapshot },
      dispatchedAt: '2026-07-23T12:00:01.000Z',
    });

    assert.equal(result.receipt.status, 'blocked');
    assert.equal(result.receipt.reason, 'concurrent evidence catalog mutation');
    assert.equal(invoked, 0);
  } finally {
    await cleanup(store.consumer);
  }
});

test('a policy revision the store cannot recompute never reaches the spawn handoff', async () => {
  const store = await makeRoutingStore();
  try {
    const registry = createDispatchLeaseRegistry();
    const resolverInput = await store.resolverInput();
    let prepared = 0;
    const result = await dispatchResolvedRoute({
      executionId: 'execution-lease-unrecomputable',
      afk: true,
      resolverInput: {
        ...resolverInput,
        policy: { ...resolverInput.policy, revision: 'policy-asserted-by-caller' },
      },
      adapter: {
        prepare: async (requestedRoute) => {
          prepared += 1;
          return preparedRoute(requestedRoute, async () => ({ taskId: 'must-not-run' }));
        },
      },
      lease: { registry, key: IDENTITY.key, snapshot: store.snapshot },
      dispatchedAt: '2026-07-23T12:00:01.000Z',
    });

    assert.equal(result.receipt.status, 'blocked');
    assert.equal(result.receipt.reason, 'concurrent routing profile mutation');
    assert.equal(prepared, 0, 'the store binding is checked before the adapter prepares');
  } finally {
    await cleanup(store.consumer);
  }
});

test('a lease that expires during the spawn handoff blocks the dispatch', async () => {
  const store = await makeRoutingStore();
  try {
    const clock = { value: 1_000 };
    const registry = createDispatchLeaseRegistry({ now: () => clock.value });
    let invoked = 0;
    const result = await dispatchResolvedRoute({
      executionId: 'execution-lease-expired',
      afk: true,
      resolverInput: await store.resolverInput(),
      adapter: {
        prepare: async (requestedRoute) => {
          clock.value += 5_000;
          return preparedRoute(requestedRoute, async () => {
            invoked += 1;
            return { taskId: 'must-not-run' };
          });
        },
      },
      lease: { registry, key: IDENTITY.key, snapshot: store.snapshot, ttlMs: 1_000 },
      dispatchedAt: '2026-07-23T12:00:01.000Z',
    });

    assert.equal(result.receipt.status, 'blocked');
    assert.equal(result.receipt.reason, 'dispatch lease expired');
    assert.equal(invoked, 0);
  } finally {
    await cleanup(store.consumer);
  }
});

test('a second dispatch cannot take a held lease and never prepares its route', async () => {
  const store = await makeRoutingStore();
  try {
    const registry = createDispatchLeaseRegistry();
    const resolverInput = await store.resolverInput();
    const held = registry.acquire({ key: IDENTITY.key, holder: 'execution-first' });
    assert.equal(held.fencingToken, 1);

    const result = await dispatchResolvedRoute({
      executionId: 'execution-second',
      afk: true,
      resolverInput,
      adapter: { prepare: async () => { throw new Error('must not prepare'); } },
      lease: { registry, key: IDENTITY.key, snapshot: store.snapshot },
      dispatchedAt: '2026-07-23T12:00:01.000Z',
    });

    assert.equal(result.receipt.status, 'blocked');
    assert.equal(result.receipt.reason, 'dispatch lease is held');
    registry.release(held);
    assert.equal(registry.inspect(IDENTITY.key).held, false);
  } finally {
    await cleanup(store.consumer);
  }
});

test('an abandoned lease expires, is recovered by the next acquirer, and fences its holder', () => {
  const clock = { value: 10_000 };
  const registry = createDispatchLeaseRegistry({ now: () => clock.value, ttlMs: 2_000 });
  const abandoned = registry.acquire({ key: 'scope-b', holder: 'execution-abandoned' });
  assert.equal(abandoned.schemaVersion, DISPATCH_LEASE_VERSION);
  assert.equal(abandoned.expiresAt, 12_000);
  assert.equal(registry.assertHeld(abandoned), true);
  assert.throws(
    () => registry.acquire({ key: 'scope-b', holder: 'execution-blocked' }),
    /dispatch lease is held: scope-b/,
  );

  clock.value = 12_000;
  assert.throws(() => registry.assertHeld(abandoned), /dispatch lease expired: scope-b/);

  const recovered = registry.acquire({ key: 'scope-b', holder: 'execution-recovered' });
  assert.equal(recovered.fencingToken, abandoned.fencingToken + 1);
  assert.throws(() => registry.assertHeld(abandoned), /dispatch lease superseded: scope-b/);
  registry.release(abandoned);
  assert.equal(registry.inspect('scope-b').held, true, 'a fenced holder cannot release its successor');
  registry.release(recovered);
  assert.equal(registry.inspect('scope-b').held, false);
});

test('a queued writer blocks new acquisitions, keeps FIFO order, and fences on its turn', async () => {
  const clock = { value: 0 };
  const registry = createDispatchLeaseRegistry({ now: () => clock.value, ttlMs: 5_000 });
  const holder = registry.acquire({ key: 'scope-c', holder: 'execution-holder' });

  const first = registry.requestWriterTurn({ key: 'scope-c', writerId: 'writer-1' });
  const second = registry.requestWriterTurn({ key: 'scope-c', writerId: 'writer-2' });
  assert.equal(registry.inspect('scope-c').writers, 2);
  assert.throws(
    () => registry.acquire({ key: 'scope-c', holder: 'execution-barging' }),
    /dispatch lease is reserved for a writer: scope-c/,
  );
  assert.deepEqual(registry.tryBeginWrite(second), { granted: false, reason: 'writer-not-next' });
  assert.deepEqual(registry.tryBeginWrite(first), { granted: false, reason: 'dispatch-lease-held' });
  await assert.rejects(
    awaitWriteTurn(registry, first, { timeoutMs: 20, pollMs: 1 }),
    /dispatch lease writer timed out: scope-c/,
  );

  registry.release(holder);
  const granted = await awaitWriteTurn(registry, first, { timeoutMs: 20, pollMs: 1 });
  assert.equal(granted.granted, true);
  assert.equal(granted.fencingToken, holder.fencingToken + 1);
  assert.throws(() => registry.assertHeld(holder), /dispatch lease superseded: scope-c/);

  registry.endWrite(first);
  assert.deepEqual(registry.tryBeginWrite(second), { granted: true, fencingToken: 3 });
  registry.endWrite(second);
  assert.equal(registry.inspect('scope-c').writers, 0);
  const after = registry.acquire({ key: 'scope-c', holder: 'execution-after' });
  assert.equal(after.fencingToken, 4);
  assert.equal(DEFAULT_DISPATCH_LEASE_TTL_MS > 0, true);
});

test('a cooperating writer waits for the in-flight dispatch instead of racing it', async () => {
  const store = await makeRoutingStore();
  try {
    const registry = createDispatchLeaseRegistry();
    const resolverInput = await store.resolverInput();
    const order = [];
    let ticket = null;
    const result = await dispatchResolvedRoute({
      executionId: 'execution-cooperating',
      afk: true,
      resolverInput,
      adapter: {
        prepare: async (requestedRoute) => {
          ticket = registry.requestWriterTurn({ key: IDENTITY.key, writerId: 'writer-profile' });
          assert.equal(registry.tryBeginWrite(ticket).granted, false);
          order.push('writer-waits');
          return preparedRoute(requestedRoute, async () => {
            order.push('dispatched');
            return { taskId: 'cooperating-task' };
          });
        },
      },
      lease: { registry, key: IDENTITY.key, snapshot: store.snapshot },
      dispatchedAt: '2026-07-23T12:00:01.000Z',
    });

    assert.equal(result.receipt.status, 'dispatched');
    const granted = await awaitWriteTurn(registry, ticket, { timeoutMs: 50, pollMs: 1 });
    order.push('writer-granted');
    registry.endWrite(ticket);
    assert.equal(granted.granted, true);
    assert.deepEqual(order, ['writer-waits', 'dispatched', 'writer-granted']);
  } finally {
    await cleanup(store.consumer);
  }
});

test('a dispatch without a lease keeps the in-memory guard and its public contract', async () => {
  const store = await makeRoutingStore();
  try {
    const resolverInput = await store.resolverInput();
    let invoked = 0;
    const result = await dispatchResolvedRoute({
      executionId: 'execution-no-lease',
      afk: true,
      resolverInput,
      adapter: {
        prepare: async (requestedRoute) => preparedRoute(requestedRoute, async () => {
          invoked += 1;
          return { taskId: 'no-lease-task' };
        }),
      },
      dispatchedAt: '2026-07-23T12:00:01.000Z',
    });

    assert.equal(result.receipt.status, 'dispatched');
    assert.equal(invoked, 1);
  } finally {
    await cleanup(store.consumer);
  }
});

test('an open lease is released when the snapshot source itself fails', async () => {
  const registry = createDispatchLeaseRegistry();
  await assert.rejects(openDispatchLease({
    registry,
    key: 'scope-d',
    holder: 'execution-broken',
    snapshot: { read: async () => { throw new Error('store unreadable'); } },
  }), /store unreadable/);
  assert.equal(registry.inspect('scope-d').held, false);
});
