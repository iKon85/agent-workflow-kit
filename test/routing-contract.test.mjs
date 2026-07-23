import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ROUTING_INTENT_VERSION,
  validateRoutingIntent,
} from '../src/lib/routingIntent.mjs';
import {
  EVIDENCE_CATALOG_VERSION,
  validateEvidenceCatalog,
} from '../src/lib/routingCatalog.mjs';
import {
  ACCESS_GRAPH_VERSION,
  validateAccessGraph,
} from '../src/lib/routingAccessGraph.mjs';
import {
  ROUTING_POLICY_VERSION,
  validateRoutingPolicy,
} from '../src/lib/routingPolicy.mjs';
import {
  ROUTE_DECISION_VERSION,
  resolveRoute,
} from '../src/lib/routingResolver.mjs';
import {
  ROUTING_EVIDENCE_CACHE_VERSION,
  assertRoutingProfileUnchanged,
  captureRoutingProfileSnapshot,
  commitRoutingEvidenceCache,
  validateRoutingEvidenceCache,
} from '../src/lib/routingEvidenceCache.mjs';
import {
  DISPATCH_RECEIPT_VERSION,
  createDispatchReceipt,
} from '../src/lib/dispatchReceipt.mjs';
import { classifyFrontendWorkload } from '../src/lib/frontendWorkloads.mjs';
import { codeArenaSource } from '../src/lib/routingSources/codeArena.mjs';
import { openHandsFrontendSource } from '../src/lib/routingSources/openhandsFrontend.mjs';

test('durable routing intent describes work without persisting a provider route', () => {
  const result = validateRoutingIntent({
    version: ROUTING_INTENT_VERSION,
    workload: 'development',
    reasoning: 'balanced',
  });

  assert.deepEqual(result, {
    version: 1,
    workload: 'development',
    reasoning: 'balanced',
  });
  assert.throws(
    () => validateRoutingIntent({
      version: ROUTING_INTENT_VERSION,
      workload: 'development',
      reasoning: 'balanced',
      model: 'volatile-model-id',
    }),
    /unknown routing intent field: model/,
  );
});

const observation = (overrides = {}) => ({
  id: 'owner-benchmark:model-a:high',
  providerId: 'provider-a',
  modelId: 'model-a',
  effort: 'high',
  workload: 'development',
  harness: { id: 'agent-harness', version: '2.1' },
  score: 0.87,
  source: {
    id: 'owner-benchmark',
    owner: 'benchmark-owner',
    url: 'https://example.invalid/benchmark',
    benchmark: 'coding-benchmark',
    version: '2026-07',
    snapshotHash: 'sha256:owner-benchmark-r7',
  },
  uncertainty: { kind: 'confidence-interval', value: 0.03 },
  freshness: {
    observedAt: '2026-07-20T00:00:00.000Z',
    expiresAt: '2026-08-20T00:00:00.000Z',
  },
  cost: { amount: 2.5, currency: 'USD', unit: 'run' },
  ...overrides,
});

test('evidence catalog preserves complete execution identity independent of access', () => {
  const catalog = validateEvidenceCatalog({
    schemaVersion: EVIDENCE_CATALOG_VERSION,
    revision: 'catalog-r7',
    models: [
      { providerId: 'provider-a', modelId: 'model-a' },
      { providerId: 'provider-b', modelId: 'model-unavailable-here' },
    ],
    observations: [observation()],
  });

  assert.equal(catalog.models[1].modelId, 'model-unavailable-here');
  assert.deepEqual(
    Object.keys(catalog.observations[0]).sort(),
    [
      'cost',
      'effort',
      'freshness',
      'harness',
      'id',
      'modelId',
      'providerId',
      'score',
      'source',
      'uncertainty',
      'workload',
    ],
  );
  assert.ok(Object.isFrozen(catalog.observations[0]));
});

test('evidence catalog rejects duplicate observations and incomplete identities', () => {
  const base = {
    schemaVersion: EVIDENCE_CATALOG_VERSION,
    revision: 'catalog-r7',
    models: [{ providerId: 'provider-a', modelId: 'model-a' }],
  };

  assert.throws(
    () => validateEvidenceCatalog({
      ...base,
      observations: [observation(), observation()],
    }),
    /duplicate evidence observation/,
  );
  const missingSourceId = observation();
  delete missingSourceId.source.id;
  assert.throws(
    () => validateEvidenceCatalog({ ...base, observations: [missingSourceId] }),
    /source.id/,
  );
  const missingSnapshotHash = observation();
  delete missingSnapshotHash.source.snapshotHash;
  assert.throws(
    () => validateEvidenceCatalog({ ...base, observations: [missingSnapshotHash] }),
    /source.snapshotHash/,
  );
  const incomplete = observation();
  delete incomplete.harness;
  assert.throws(
    () => validateEvidenceCatalog({ ...base, observations: [incomplete] }),
    /observations\[0\]\.harness/,
  );
});

const accessPath = (overrides = {}) => ({
  id: 'codex:native:model-a',
  surfaceId: 'codex',
  providerId: 'provider-a',
  modelId: 'model-a',
  transportId: 'native',
  availability: 'available',
  enforcement: { model: 'per-spawn', effort: 'per-spawn' },
  capabilityEvidence: {
    revision: 'capability-r3',
    observedAt: '2026-07-22T00:00:00.000Z',
    expiresAt: '2026-07-24T00:00:00.000Z',
  },
  ...overrides,
});

test('access graph represents several native or cross-provider paths to one model', () => {
  const graph = validateAccessGraph({
    schemaVersion: ACCESS_GRAPH_VERSION,
    revision: 'access-r4',
    paths: [
      accessPath(),
      accessPath({
        id: 'claude:plugin:model-a',
        surfaceId: 'claude',
        transportId: 'approved-plugin',
      }),
    ],
  });

  assert.equal(graph.paths.length, 2);
  assert.equal(new Set(graph.paths.map(({ modelId }) => modelId)).size, 1);
  assert.ok(Object.isFrozen(graph.paths[0].capabilityEvidence));
});

test('access graph rejects credentials and duplicate path identities', () => {
  const duplicate = accessPath();
  assert.throws(
    () => validateAccessGraph({
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'access-r4',
      paths: [duplicate, duplicate],
    }),
    /duplicate access path/,
  );
  assert.throws(
    () => validateAccessGraph({
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'access-r4',
      paths: [{ ...accessPath(), credential: 'must-not-be-stored' }],
    }),
    /unknown access path field: credential/,
  );
});

const routingPolicy = (overrides = {}) => ({
  schemaVersion: ROUTING_POLICY_VERSION,
  revision: 'policy-r5',
  allowedSurfaces: ['codex', 'claude'],
  allowedTransports: ['native', 'approved-plugin'],
  switching: 'automatic',
  optimization: 'quality',
  unreachable: 'block',
  missingInfrastructure: 'inherit',
  ...overrides,
});

test('routing policy is personal, separately versioned, and requires an explicit fallback', () => {
  const policy = validateRoutingPolicy(routingPolicy());

  assert.equal(policy.revision, 'policy-r5');
  assert.equal(policy.missingInfrastructure, 'inherit');
  const missingFallback = routingPolicy();
  delete missingFallback.missingInfrastructure;
  assert.throws(
    () => validateRoutingPolicy(missingFallback),
    /missingInfrastructure/,
  );
});

test('routing policy rejects embedded credentials', () => {
  assert.throws(
    () => validateRoutingPolicy(routingPolicy({ apiKey: 'not-package-data' })),
    /unknown routing policy field: apiKey/,
  );
});

const resolverFixture = (overrides = {}) => ({
  intent: {
    version: ROUTING_INTENT_VERSION,
    workload: 'development',
    reasoning: 'balanced',
  },
  catalog: {
    schemaVersion: EVIDENCE_CATALOG_VERSION,
    revision: 'catalog-r7',
    models: [
      { providerId: 'provider-a', modelId: 'model-a' },
      { providerId: 'provider-b', modelId: 'model-b' },
    ],
    observations: [
      observation(),
      observation({
        id: 'owner-benchmark:model-b:high',
        providerId: 'provider-b',
        modelId: 'model-b',
        score: 0.98,
      }),
    ],
  },
  accessGraph: {
    schemaVersion: ACCESS_GRAPH_VERSION,
    revision: 'access-r4',
    paths: [accessPath()],
  },
  policy: routingPolicy(),
  activeSurface: 'codex',
  knownTransports: ['native', 'approved-plugin'],
  now: '2026-07-23T00:00:00.000Z',
  ...overrides,
});

test('route decision reports best overall separately from best currently executable', () => {
  const fixture = resolverFixture();
  const before = structuredClone(fixture.catalog);
  const decision = resolveRoute(fixture);

  assert.equal(decision.schemaVersion, ROUTE_DECISION_VERSION);
  assert.equal(decision.status, 'ready');
  assert.equal(decision.bestOverall.modelId, 'model-b');
  assert.equal(decision.bestExecutable.modelId, 'model-a');
  assert.equal(decision.bestExecutable.transportId, 'native');
  assert.deepEqual(fixture.catalog, before, 'personal policy must not mutate catalog evidence');
});

test('frontend evidence selection intersects the requested workload and axis without changing task shape', async () => {
  const loadFixture = async (name) => JSON.parse(await readFile(
    new URL(`./fixtures/routing/${name}.json`, import.meta.url),
    'utf8',
  ));
  const sourceContext = {
    snapshotHash: 'sha256:frontend-routing',
    observedAt: '2026-07-22T00:00:00.000Z',
    expiresAt: '2026-08-22T00:00:00.000Z',
  };
  const arena = codeArenaSource.ingest({
    payload: await loadFixture('code-arena'),
    ...sourceContext,
  });
  const openHands = openHandsFrontendSource.ingest({
    payload: await loadFixture('openhands-frontend'),
    ...sourceContext,
  });
  const wrongAxis = {
    ...arena.observations[0],
    id: 'wrong-axis:accessibility',
    score: 9999,
    workload: 'frontend-greenfield:marketing:accessibility',
  };
  const models = [...arena.models, ...openHands.models];
  const catalog = {
    schemaVersion: EVIDENCE_CATALOG_VERSION,
    revision: 'frontend-catalog-r1',
    models,
    observations: [...arena.observations, ...openHands.observations, wrongAxis],
  };
  const paths = models.map(({ providerId, modelId }, index) => accessPath({
    id: `codex:native:${providerId}:${modelId}`,
    providerId,
    modelId,
    capabilityEvidence: {
      revision: `frontend-capability-${index}`,
      observedAt: '2026-07-22T00:00:00.000Z',
      expiresAt: '2026-07-24T00:00:00.000Z',
    },
  }));

  const greenfieldSelection = classifyFrontendWorkload({
    lifecycle: 'greenfield',
    repositoryContext: 'isolated',
    qualityAxes: ['visual-preference', 'accessibility'],
    frontendDomain: 'marketing',
  }).evidenceSelection;
  const greenfield = resolveRoute(resolverFixture({
    intent: {
      version: ROUTING_INTENT_VERSION,
      workload: 'development',
      reasoning: 'balanced',
      evidenceSelection: greenfieldSelection,
    },
    catalog,
    accessGraph: {
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'frontend-access-r1',
      paths,
    },
  }));
  assert.equal(greenfield.intent.workload, 'development');
  assert.equal(greenfield.status, 'ready');
  assert.ok(greenfield.bestOverall);
  assert.match(greenfield.bestOverall.workload, /visual-preference$/);
  assert.match(greenfield.bestOverall.reason, /frontend-greenfield:marketing:visual-preference/);
  assert.notEqual(greenfield.bestOverall.observationId, wrongAxis.id);

  const repairSelection = classifyFrontendWorkload({
    lifecycle: 'repair',
    repositoryContext: 'existing-repository',
    qualityAxes: ['functional', 'visual-preference'],
  }).evidenceSelection;
  const repair = resolveRoute(resolverFixture({
    intent: {
      version: ROUTING_INTENT_VERSION,
      workload: 'development',
      reasoning: 'balanced',
      evidenceSelection: repairSelection,
    },
    catalog,
    accessGraph: {
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'frontend-access-r1',
      paths,
    },
  }));
  assert.equal(repair.status, 'ready');
  assert.ok(repair.bestOverall);
  assert.match(repair.bestOverall.workload, /frontend-repository-repair:general:functional/);
  assert.match(repair.bestOverall.reason, /frontend-repository-repair:general:functional/);
  assert.equal(repair.bestOverall.source.id, openHandsFrontendSource.sourceId);
});

test('routing intent keeps evidence selection provider-neutral and rejects unknown nested fields', () => {
  const evidenceSelection = classifyFrontendWorkload({
    lifecycle: 'greenfield',
    repositoryContext: 'isolated',
    qualityAxes: ['visual-preference'],
  }).evidenceSelection;
  assert.deepEqual(validateRoutingIntent({
    version: ROUTING_INTENT_VERSION,
    workload: 'judgment',
    reasoning: 'deep',
    evidenceSelection,
  }), {
    version: ROUTING_INTENT_VERSION,
    workload: 'judgment',
    reasoning: 'deep',
    evidenceSelection,
  });
  assert.throws(
    () => validateRoutingIntent({
      version: ROUTING_INTENT_VERSION,
      workload: 'judgment',
      reasoning: 'deep',
      evidenceSelection: { ...evidenceSelection, modelId: 'volatile-model' },
    }),
    /unknown evidence selection field: modelId/,
  );
});

test('unknown transports and stale capability evidence fail closed', () => {
  const unknownTransport = resolverFixture({
    accessGraph: {
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'access-r4',
      paths: [accessPath({ transportId: 'unregistered-bridge' })],
    },
  });
  const unknownDecision = resolveRoute(unknownTransport);
  assert.equal(unknownDecision.status, 'blocked');
  assert.equal(unknownDecision.bestExecutable, null);
  assert.ok(unknownDecision.blockers.includes('unknown-transport:unregistered-bridge'));

  const staleCapability = resolverFixture({
    accessGraph: {
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'access-r4',
      paths: [accessPath({
        capabilityEvidence: {
          revision: 'capability-old',
          observedAt: '2026-07-01T00:00:00.000Z',
          expiresAt: '2026-07-02T00:00:00.000Z',
        },
      })],
    },
  });
  const staleDecision = resolveRoute(staleCapability);
  assert.equal(staleDecision.status, 'blocked');
  assert.ok(staleDecision.blockers.includes('stale-capability-evidence:codex:native:model-a'));
});

test('ask-before-switching requires approval for a cross-surface route', () => {
  const policy = routingPolicy({ switching: 'ask' });
  const foreignSurface = resolveRoute(resolverFixture({
    accessGraph: {
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'access-r4',
      paths: [accessPath({
        id: 'claude:plugin:model-a',
        surfaceId: 'claude',
        transportId: 'approved-plugin',
      })],
    },
    policy,
  }));

  assert.equal(foreignSurface.status, 'blocked');
  assert.equal(foreignSurface.bestExecutable, null);
  assert.ok(foreignSurface.blockers.includes('surface-switch-approval-required:claude'));

  const sameSurface = resolveRoute(resolverFixture({ policy }));
  assert.equal(sameSurface.status, 'ready');
  assert.equal(sameSurface.bestExecutable.surfaceId, 'codex');
});

test('missing routing infrastructure inherits only when explicitly requested', () => {
  const fixture = resolverFixture({ accessGraph: undefined });

  const blocked = resolveRoute(fixture);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'routing-infrastructure-missing');

  const inherited = resolveRoute({ ...fixture, missingInfrastructure: 'inherit' });
  assert.equal(inherited.status, 'inherit');
  assert.equal(inherited.reason, 'routing-infrastructure-missing');
});

test('evidence cache uses compare-and-swap and rejects stale snapshots', () => {
  const fixture = resolverFixture();
  const cache = {
    schemaVersion: ROUTING_EVIDENCE_CACHE_VERSION,
    revision: 4,
    refreshedAt: '2026-07-22T00:00:00.000Z',
    expiresAt: '2026-07-24T00:00:00.000Z',
    catalog: fixture.catalog,
  };
  const refreshed = commitRoutingEvidenceCache({
    current: cache,
    expectedRevision: 4,
    nextCatalog: { ...fixture.catalog, revision: 'catalog-r8' },
    refreshedAt: '2026-07-23T00:00:00.000Z',
    expiresAt: '2026-07-25T00:00:00.000Z',
  });
  assert.equal(refreshed.revision, 5);
  assert.equal(refreshed.catalog.revision, 'catalog-r8');
  const recoveredFromStale = commitRoutingEvidenceCache({
    current: cache,
    expectedRevision: 4,
    nextCatalog: { ...fixture.catalog, revision: 'catalog-r8' },
    refreshedAt: '2026-07-25T00:00:00.000Z',
    expiresAt: '2026-07-26T00:00:00.000Z',
  });
  assert.equal(recoveredFromStale.revision, 5);
  assert.throws(
    () => commitRoutingEvidenceCache({
      current: refreshed,
      expectedRevision: 4,
      nextCatalog: fixture.catalog,
      refreshedAt: '2026-07-23T00:00:00.000Z',
      expiresAt: '2026-07-25T00:00:00.000Z',
    }),
    /concurrent evidence cache mutation/,
  );
  assert.throws(
    () => validateRoutingEvidenceCache(cache, { now: '2026-07-25T00:00:00.000Z' }),
    /stale routing evidence cache/,
  );
});

test('concurrent user-local profile mutation blocks dispatch', () => {
  const fixture = resolverFixture();
  const snapshot = captureRoutingProfileSnapshot({
    accessGraph: fixture.accessGraph,
    policy: fixture.policy,
  });

  assert.throws(
    () => assertRoutingProfileUnchanged(snapshot, {
      accessGraph: fixture.accessGraph,
      policy: { ...fixture.policy, revision: 'policy-r6' },
    }),
    /concurrent routing profile mutation: policy/,
  );
});

const dispatchedRoute = (overrides = {}) => ({
  providerId: 'provider-a',
  modelId: 'model-a',
  effort: 'high',
  surfaceId: 'codex',
  transportId: 'native',
  ...overrides,
});

test('dispatch receipt proves requested and applied AFK enforcement for one execution', () => {
  const receipt = createDispatchReceipt({
    executionId: 'run-123',
    status: 'dispatched',
    afk: true,
    requestedRoute: dispatchedRoute(),
    appliedRoute: dispatchedRoute(),
    enforcement: { model: 'per-spawn', effort: 'per-spawn' },
    revisions: {
      catalog: 'catalog-r7',
      accessGraph: 'access-r4',
      policy: 'policy-r5',
    },
    dispatchedAt: '2026-07-23T00:01:00.000Z',
  });

  assert.equal(receipt.schemaVersion, DISPATCH_RECEIPT_VERSION);
  assert.equal(receipt.executionId, 'run-123');
  assert.ok(Object.isFrozen(receipt.appliedRoute));
});

test('dispatch receipt rejects silent degradation and unenforced AFK routes', () => {
  const base = {
    executionId: 'run-123',
    status: 'dispatched',
    afk: true,
    requestedRoute: dispatchedRoute(),
    appliedRoute: dispatchedRoute(),
    enforcement: { model: 'per-spawn', effort: 'per-spawn' },
    revisions: {
      catalog: 'catalog-r7',
      accessGraph: 'access-r4',
      policy: 'policy-r5',
    },
    dispatchedAt: '2026-07-23T00:01:00.000Z',
  };
  assert.throws(
    () => createDispatchReceipt({
      ...base,
      appliedRoute: dispatchedRoute({ modelId: 'silent-substitute' }),
    }),
    /applied route differs from requested route: modelId/,
  );
  assert.throws(
    () => createDispatchReceipt({
      ...base,
      enforcement: { model: 'session-default', effort: 'none' },
    }),
    /AFK dispatch requires enforced model and effort selection/,
  );
});
