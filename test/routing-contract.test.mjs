import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ROUTING_INTENT_LEGACY_VERSION,
  ROUTING_INTENT_MIGRATION_DEFAULTS,
  ROUTING_INTENT_VERSION,
  migrateRoutingIntent,
  parseRoutingIntent,
  serializeRoutingIntent,
  validateRoutingIntent,
} from '../src/lib/routingIntent.mjs';
import {
  EVIDENCE_CATALOG_VERSION,
  validateEvidenceCatalog,
} from '../src/lib/routingCatalog.mjs';
import {
  ACCESS_GRAPH_VERSION,
  accessPathMatchesPair,
  buildAccessGraph,
  resolveAccessRoute,
  selectAccessPaths,
  validateAccessGraph,
} from '../src/lib/routingAccessGraph.mjs';
import {
  PROBE_FAILURE_KINDS,
  classifyProbeFailure,
} from '../src/lib/routingAccessGraphStore.mjs';
import {
  ROUTING_POLICY_LEGACY_VERSION,
  ROUTING_POLICY_VERSION,
  decodeRoutingPolicy,
  validateRoutingPolicy,
} from '../src/lib/routingPolicy.mjs';
import {
  ROUTING_POLICY_REVISION_INPUTS,
  deriveRoutingPolicy,
  routingPolicyRevision,
} from '../src/lib/routingProfilePolicy.mjs';
import {
  ROUTING_PROFILE_VERSION,
  STANDARD_ROUTE_CLASSES,
  composeRoutingProfile,
} from '../src/lib/routingProfile.mjs';
import {
  BEST_OVERALL_STATES,
  ROUTE_DECISION_ORIGINS,
  ROUTE_DECISION_STATES,
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

const routingIntent = (overrides = {}) => ({
  version: ROUTING_INTENT_VERSION,
  workload: 'development',
  reasoning: 'balanced',
  taskShape: 'multi-step',
  risk: 'moderate',
  autonomyRequirement: 'supervised',
  contextNeed: 'repository',
  ...overrides,
});

test('durable routing intent describes work without persisting a provider route', () => {
  const result = validateRoutingIntent(routingIntent());

  assert.deepEqual(result, {
    version: 2,
    workload: 'development',
    reasoning: 'balanced',
    taskShape: 'multi-step',
    risk: 'moderate',
    autonomyRequirement: 'supervised',
    contextNeed: 'repository',
  });
  assert.throws(
    () => validateRoutingIntent(routingIntent({ model: 'volatile-model-id' })),
    /unknown routing intent field: model/,
  );
});

test('routing intent v2 carries every glossary dimension and no optimization goal', () => {
  assert.throws(
    () => validateRoutingIntent(routingIntent({ optimization: 'cost' })),
    /unknown routing intent field: optimization/,
  );
  for (const dimension of ['workload', 'taskShape', 'risk', 'autonomyRequirement', 'contextNeed']) {
    const incomplete = routingIntent();
    delete incomplete[dimension];
    assert.throws(
      () => validateRoutingIntent(incomplete),
      new RegExp(`${dimension} must be one of`),
      `${dimension} must be a required routing intent dimension`,
    );
  }
  assert.throws(
    () => validateRoutingIntent(routingIntent({ risk: 'catastrophic' })),
    /risk must be one of: low, moderate, high/,
  );
});

test('a v1 routing intent migrates deterministically into the v2 dimensions', () => {
  const legacy = {
    version: ROUTING_INTENT_LEGACY_VERSION,
    workload: 'judgment',
    reasoning: 'deep',
  };
  const migrated = migrateRoutingIntent(legacy);

  assert.equal(migrated.fromVersion, ROUTING_INTENT_LEGACY_VERSION);
  assert.deepEqual(migrated.defaulted, [
    'taskShape',
    'risk',
    'autonomyRequirement',
    'contextNeed',
  ]);
  assert.deepEqual(migrated.intent, {
    version: ROUTING_INTENT_VERSION,
    workload: 'judgment',
    reasoning: 'deep',
    ...ROUTING_INTENT_MIGRATION_DEFAULTS,
  });
  assert.equal(
    migrated.intent.autonomyRequirement,
    'supervised',
    'migration must never invent an autonomy claim a v1 intent never made',
  );
  assert.deepEqual(migrateRoutingIntent(legacy).intent, migrated.intent);
  assert.deepEqual(
    validateRoutingIntent(legacy),
    migrated.intent,
    'a v1 intent stays resolvable through the same deterministic migration',
  );
  assert.throws(
    () => migrateRoutingIntent({ ...legacy, optimization: 'cost' }),
    /unknown routing intent field: optimization/,
  );
  assert.throws(
    () => validateRoutingIntent({ ...legacy, version: 3 }),
    /routing intent version must be 1 or 2/,
  );
});

test('routing intent issue serialization round-trips and migrates a v1 block', () => {
  const intent = validateRoutingIntent(routingIntent({ workload: 'mechanical', risk: 'low' }));
  const block = serializeRoutingIntent(intent);

  assert.equal(block, [
    'intent-version: 2',
    'routing-intent: mechanical',
    'reasoning-intent: balanced',
    'task-shape: multi-step',
    'risk: low',
    'autonomy-requirement: supervised',
    'context-need: repository',
  ].join('\n'));
  const parsed = parseRoutingIntent(block);
  assert.deepEqual(parsed.intent, intent);
  assert.equal(parsed.fromVersion, ROUTING_INTENT_VERSION);
  assert.deepEqual(parsed.defaulted, []);

  const embedded = parseRoutingIntent([
    '## What to build',
    '',
    'Add the missing dimensions.',
    'risk: high',
    '',
    ...block.split('\n'),
    '',
    'Outcome: the intent in code matches the intent in the glossary.',
  ].join('\n'));
  assert.deepEqual(
    embedded.intent,
    intent,
    'only the block naming the workload key contributes dimensions',
  );

  const legacyBlock = parseRoutingIntent('routing-intent: judgment\nreasoning-intent: deep');
  assert.equal(legacyBlock.fromVersion, ROUTING_INTENT_LEGACY_VERSION);
  assert.deepEqual(legacyBlock.defaulted, [
    'taskShape',
    'risk',
    'autonomyRequirement',
    'contextNeed',
  ]);
  assert.deepEqual(legacyBlock.intent, {
    version: ROUTING_INTENT_VERSION,
    workload: 'judgment',
    reasoning: 'deep',
    ...ROUTING_INTENT_MIGRATION_DEFAULTS,
  });
});

test('routing intent parsing rejects blocks it cannot round-trip', () => {
  assert.throws(
    () => parseRoutingIntent('reasoning-intent: deep'),
    /routing intent block must name routing-intent/,
  );
  assert.throws(
    () => parseRoutingIntent('routing-intent: judgment\nrouting-intent: development'),
    /duplicate routing intent field: routing-intent/,
  );
  assert.throws(
    () => parseRoutingIntent('routing-intent: judgment\n\nrouting-intent: development'),
    /routing intent block must appear once/,
  );
  assert.throws(
    () => parseRoutingIntent('routing-intent: architecture\nreasoning-intent: deep'),
    /workload must be one of/,
  );
  assert.throws(
    () => parseRoutingIntent('intent-version: 3\nrouting-intent: judgment\nreasoning-intent: deep'),
    /routing intent version must be 1 or 2/,
  );
  assert.throws(() => parseRoutingIntent(42), /routing intent block must be a string/);
});

test('routing intent glossary keeps every dimension and no optimization goal', async () => {
  const context = await readFile(new URL('../CONTEXT.md', import.meta.url), 'utf8');
  const entry = context.split('\n## ').find((section) => section.startsWith('Routing intent\n'));
  assert.ok(entry, 'CONTEXT.md must define the Routing intent');
  for (const dimension of [
    'workload',
    'task shape',
    'risk',
    'autonomy requirement',
    'context need',
  ]) {
    assert.ok(entry.includes(dimension), `Routing intent glossary must name ${dimension}`);
  }
  assert.match(entry, /carries no optimization goal/);
  assert.match(entry, /_Avoid_:.*Optimization goal/);
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

const accessAttestation = (overrides = {}) => ({
  result: 'available',
  failureKind: null,
  probeId: 'capability-probe:minimal',
  authorizationId: 'probe-authorization-1',
  observedAt: '2026-07-22T00:00:00.000Z',
  expiresAt: '2026-07-24T00:00:00.000Z',
  ...overrides,
});

const accessPath = (overrides = {}) => ({
  id: 'codex:native:model-a',
  surfaceId: 'codex',
  providerId: 'provider-a',
  modelId: 'model-a',
  effort: 'high',
  transportId: 'native',
  availability: 'available',
  enforcement: { model: 'per-spawn', effort: 'per-spawn' },
  capabilityEvidence: {
    revision: 'capability-r3',
    observedAt: '2026-07-22T00:00:00.000Z',
    expiresAt: '2026-07-24T00:00:00.000Z',
  },
  attestation: accessAttestation(),
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

const pairGraph = () => validateAccessGraph({
  schemaVersion: ACCESS_GRAPH_VERSION,
  revision: 'access-r4',
  paths: [
    accessPath({ id: 'codex:native:model-a:high', effort: 'high' }),
    accessPath({
      id: 'codex:native:model-a:low',
      effort: 'low',
      availability: 'unknown',
      attestation: null,
    }),
  ],
});

test('an access path identifies model and effort and only an exact pair match resolves', () => {
  const graph = pairGraph();
  const pair = { providerId: 'provider-a', modelId: 'model-a', effort: 'high' };

  assert.deepEqual(
    selectAccessPaths(graph, pair).map(({ id }) => id),
    ['codex:native:model-a:high'],
  );
  assert.equal(accessPathMatchesPair(graph.paths[0], pair), true);
  assert.equal(accessPathMatchesPair(graph.paths[1], pair), false);
  assert.deepEqual(
    selectAccessPaths(graph, { ...pair, effort: 'medium' }),
    [],
    'an effort the path never attested must not resolve',
  );
  assert.deepEqual(
    selectAccessPaths(graph, { ...pair, transportId: 'approved-plugin' }),
    [],
    'an explicit transport narrows the pair match further',
  );

  const withoutEffort = accessPath();
  delete withoutEffort.effort;
  assert.throws(
    () => validateAccessGraph({
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'access-r4',
      paths: [withoutEffort],
    }),
    /paths\[0\]\.effort must be a non-empty string/,
  );
  assert.throws(
    () => validateAccessGraph({
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'access-r4',
      paths: [accessPath(), accessPath({ id: 'codex:native:model-a:duplicate' })],
    }),
    /duplicate access pair/,
  );
});

test('an access path attestation is dated proof and never contradicts its availability', () => {
  const graphOf = (path) => validateAccessGraph({
    schemaVersion: ACCESS_GRAPH_VERSION,
    revision: 'access-r4',
    paths: [path],
  });
  const rejectedAttestation = accessAttestation({
    result: 'unavailable',
    failureKind: 'not-authorized',
  });

  const graph = graphOf(accessPath({
    availability: 'unavailable',
    attestation: rejectedAttestation,
  }));
  assert.equal(graph.paths[0].attestation.failureKind, 'not-authorized');
  assert.ok(Object.isFrozen(graph.paths[0].attestation));

  assert.throws(
    () => graphOf(accessPath({ availability: 'available', attestation: rejectedAttestation })),
    /attestation result must match the recorded availability/,
  );
  assert.throws(
    () => graphOf(accessPath({ availability: 'unknown', attestation: rejectedAttestation })),
    /unknown availability must carry no attestation/,
  );
  for (const availability of ['available', 'unavailable']) {
    assert.throws(
      () => graphOf(accessPath({ availability, attestation: null })),
      /availability requires a dated attestation/,
      availability,
    );
  }
  assert.throws(
    () => graphOf(accessPath({
      attestation: accessAttestation({ expiresAt: '2026-07-21T00:00:00.000Z' }),
    })),
    /attestation\.expiresAt must follow observedAt/,
  );
});

test('only a deterministic unsupported or authorization failure may mutate availability', () => {
  assert.deepEqual(
    Object.entries(PROBE_FAILURE_KINDS)
      .filter(([, determinism]) => determinism === 'deterministic')
      .map(([kind]) => kind)
      .sort(),
    ['not-authorized', 'unsupported-effort', 'unsupported-model'],
  );
  for (const kind of ['timeout', 'rate-limited', 'malformed-response', 'provider-failure']) {
    assert.deepEqual(classifyProbeFailure(kind), {
      kind,
      determinism: 'transient',
      mutatesAvailability: false,
    });
  }
  assert.equal(classifyProbeFailure('not-authorized').mutatesAvailability, true);
  assert.equal(
    classifyProbeFailure('a-kind-nobody-typed').mutatesAvailability,
    false,
    'an unclassified failure must never poison the graph',
  );
  assert.equal(classifyProbeFailure(undefined).kind, 'unclassified');
});

test('the access-graph builder assembles surface attestations into dated unknown paths', () => {
  const attestation = (overrides = {}) => ({
    id: 'claude:claude-native:reasoning-model:high',
    surfaceId: 'claude',
    providerId: 'anthropic',
    modelId: 'reasoning-model',
    effort: 'high',
    transportId: 'claude-native',
    attested: true,
    attestationFailures: [],
    enforcement: { model: 'per-spawn', effort: 'per-spawn' },
    capabilityEvidence: {
      revision: 'capability-r1',
      observedAt: '2026-07-28T00:00:00.000Z',
      expiresAt: '2026-07-29T00:00:00.000Z',
    },
    ...overrides,
  });

  const graph = buildAccessGraph({ attestations: [attestation()] });
  assert.equal(graph.schemaVersion, ACCESS_GRAPH_VERSION);
  assert.equal(graph.paths[0].availability, 'unknown');
  assert.match(graph.revision, /^sha256-/);
  assert.equal(
    buildAccessGraph({ attestations: [attestation()] }).revision,
    graph.revision,
    'the revision is content-derived and stable',
  );

  assert.deepEqual(
    buildAccessGraph({
      attestations: [attestation({ attested: false, attestationFailures: ['effort control is not enforced'] })],
    }).paths,
    [],
  );

  assert.throws(
    () => buildAccessGraph({
      attestations: [attestation({ effort: 'ultra' })],
      effortDomains: { 'anthropic:reasoning-model': ['low', 'medium', 'high'] },
    }),
    /effort is outside the model effort domain/,
  );

  const afk = resolveAccessRoute(graph, {
    providerId: 'anthropic',
    modelId: 'reasoning-model',
    effort: 'high',
  }, { afk: true });
  assert.equal(afk.state, 'blocked');
  const supervised = resolveAccessRoute(graph, {
    providerId: 'anthropic',
    modelId: 'reasoning-model',
    effort: 'high',
  }, { afk: false });
  assert.equal(supervised.state, 'verification-required');
});

const policyPair = (model, effort = 'high') => ({ model, effort });
const policyRoute = (model, effort = 'high', state = 'configured') => ({ model, effort, state });
const NO_STANDARD_ROUTES = { mechanical: null, development: null, judgment: null };

const routingPolicy = (overrides = {}) => ({
  schemaVersion: ROUTING_POLICY_VERSION,
  revision: 'policy-r5',
  allowedSurfaces: ['codex', 'claude'],
  allowedTransports: ['native', 'approved-plugin'],
  switching: 'automatic',
  roster: [policyPair('model-a'), policyPair('model-b')],
  standardRoutes: {
    mechanical: policyRoute('model-a'),
    development: policyRoute('model-a'),
    judgment: policyRoute('model-b'),
  },
  unreachable: 'block',
  missingInfrastructure: 'inherit',
  ...overrides,
});

const legacyRoutingPolicy = (overrides = {}) => ({
  schemaVersion: ROUTING_POLICY_LEGACY_VERSION,
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

  assert.equal(policy.schemaVersion, ROUTING_POLICY_VERSION);
  assert.equal(policy.revision, 'policy-r5');
  assert.equal(policy.unreachable, 'block');
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

test('routing policy v2 drops the optimization dial and carries roster pairs and effective standard routes', () => {
  const policy = validateRoutingPolicy(routingPolicy());

  assert.deepEqual(Object.keys(policy).sort(), [
    'allowedSurfaces', 'allowedTransports', 'missingInfrastructure', 'revision',
    'roster', 'schemaVersion', 'standardRoutes', 'switching', 'unreachable',
  ]);
  assert.deepEqual(policy.roster, [
    { model: 'model-a', effort: 'high' },
    { model: 'model-b', effort: 'high' },
  ]);
  // The route vocabulary is the profile's, not a second literal list.
  assert.deepEqual(Object.keys(policy.standardRoutes), [...STANDARD_ROUTE_CLASSES]);
  assert.deepEqual(policy.standardRoutes.judgment, {
    model: 'model-b', effort: 'high', state: 'configured',
  });
  assert.throws(
    () => validateRoutingPolicy(routingPolicy({ optimization: 'quality' })),
    /unknown routing policy field: optimization/,
  );
  // Authorization consistency: a configured route must name a pair the roster authorizes.
  assert.throws(
    () => validateRoutingPolicy(routingPolicy({
      standardRoutes: { ...routingPolicy().standardRoutes, judgment: policyRoute('model-unlisted') },
    })),
    /standardRoutes\.judgment must name an authorized roster pair/,
  );
  // A knowingly broken nomination stays representable rather than invalidating the policy.
  const unresolved = validateRoutingPolicy(routingPolicy({
    standardRoutes: {
      ...routingPolicy().standardRoutes,
      judgment: policyRoute('withdrawn-model', 'high', 'unresolved'),
    },
  }));
  assert.equal(unresolved.standardRoutes.judgment.state, 'unresolved');
});

test('a v1 routing policy decodes deterministically to v2 with the optimization dial dropped and recorded', () => {
  const derivation = {
    roster: [policyPair('model-a')],
    standardRoutes: { ...NO_STANDARD_ROUTES, development: policyRoute('model-a') },
  };
  const decoded = decodeRoutingPolicy(legacyRoutingPolicy(), derivation);

  assert.equal(decoded.fromVersion, ROUTING_POLICY_LEGACY_VERSION);
  assert.deepEqual(decoded.dropped, ['optimization']);
  assert.deepEqual(decoded.notes, [{ code: 'optimization-removed', value: 'quality' }]);
  assert.equal(decoded.policy.schemaVersion, ROUTING_POLICY_VERSION);
  assert.equal('optimization' in decoded.policy, false);
  assert.equal(decoded.policy.revision, 'policy-r5');
  assert.equal(decoded.policy.unreachable, 'block');
  assert.equal(decoded.policy.missingInfrastructure, 'inherit');
  assert.deepEqual(decoded.policy.roster, [{ model: 'model-a', effort: 'high' }]);
  assert.deepEqual(decoded.policy.standardRoutes.development, {
    model: 'model-a', effort: 'high', state: 'configured',
  });
  assert.deepEqual(decodeRoutingPolicy(legacyRoutingPolicy(), derivation), decoded);

  const already = decodeRoutingPolicy(routingPolicy());
  assert.equal(already.fromVersion, ROUTING_POLICY_VERSION);
  assert.deepEqual(already.dropped, []);
  assert.deepEqual(already.notes, []);
  assert.deepEqual(already.policy, validateRoutingPolicy(routingPolicy()));
});

test('a routing policy that derives neither a roster nor a standard route fails closed', () => {
  // A v1 document carries no roster at all, so decoding one without a derivation
  // names the reason instead of inventing an empty authorization.
  assert.throws(() => decodeRoutingPolicy(legacyRoutingPolicy()), /routing-policy-not-derivable/);
  assert.throws(() => validateRoutingPolicy(legacyRoutingPolicy()), /routing-policy-not-derivable/);
  assert.throws(
    () => validateRoutingPolicy(routingPolicy({ roster: [], standardRoutes: NO_STANDARD_ROUTES })),
    /routing-policy-not-derivable/,
  );
  // An unresolved route authorizes nothing, so it never rescues an empty roster.
  assert.throws(
    () => validateRoutingPolicy(routingPolicy({
      roster: [],
      standardRoutes: {
        ...NO_STANDARD_ROUTES,
        judgment: policyRoute('withdrawn-model', 'high', 'unresolved'),
      },
    })),
    /routing-policy-not-derivable/,
  );
  // A roster alone derives: pairs may be authorized before any route is nominated.
  const rosterOnly = validateRoutingPolicy(routingPolicy({
    roster: [policyPair('model-a')], standardRoutes: NO_STANDARD_ROUTES,
  }));
  assert.deepEqual(rosterOnly.standardRoutes, NO_STANDARD_ROUTES);
});

const POLICY_INVENTORY = Object.freeze({
  revision: 'sha256-inventory-1',
  pairs: Object.freeze([
    Object.freeze({ surface: 'codex', provider: 'openai', modelId: 'model-a', effort: 'high' }),
    Object.freeze({ surface: 'claude', provider: 'anthropic', modelId: 'model-b', effort: 'high' }),
  ]),
});

const globalAuthorization = (overrides = {}) => ({
  schemaVersion: ROUTING_PROFILE_VERSION,
  registryRevision: 1,
  selectedSurfaces: ['codex', 'claude'],
  consideredSurfaces: ['codex', 'claude'],
  authorizedTransports: [
    { surface: 'codex', transport: 'native' },
    { surface: 'claude', transport: 'approved-plugin' },
  ],
  switching: 'automatic',
  roster: [
    { model: 'model-a', effort: 'high', state: 'admitted' },
    { model: 'model-b', effort: 'high', state: 'admitted' },
  ],
  inventoryRevision: POLICY_INVENTORY.revision,
  standardRoutes: {
    mechanical: policyRoute('model-a'),
    development: policyRoute('model-a'),
    judgment: policyRoute('model-b'),
  },
  advanced: null,
  ...overrides,
});

test('the routing policy revision hashes exactly the two generations and the inventory revision', () => {
  const inputs = {
    globalGeneration: 4, projectGeneration: 2, inventoryRevision: POLICY_INVENTORY.revision,
  };
  const revision = routingPolicyRevision(inputs);

  assert.deepEqual([...ROUTING_POLICY_REVISION_INPUTS], [
    'globalGeneration', 'projectGeneration', 'inventoryRevision',
  ]);
  assert.match(revision, /^sha256-[A-Za-z0-9_-]{43}$/);
  assert.equal(routingPolicyRevision({ ...inputs }), revision, 'derivation is pure');
  for (const [field, value] of [
    ['globalGeneration', 5],
    ['projectGeneration', null],
    ['inventoryRevision', 'sha256-inventory-2'],
  ]) {
    assert.notEqual(routingPolicyRevision({ ...inputs, [field]: value }), revision, field);
  }
  // Exactly those three: nothing else is hashed, and nothing else is accepted.
  assert.throws(
    () => routingPolicyRevision({ ...inputs, switching: 'ask' }),
    /unknown routing policy revision input field: switching/,
  );
  assert.throws(() => routingPolicyRevision({ ...inputs, globalGeneration: null }), /globalGeneration/);
});

test('a composed routing profile and its generations derive one validated, revisioned policy', () => {
  const composed = composeRoutingProfile({
    global: globalAuthorization(), inventory: POLICY_INVENTORY,
  });
  const derive = (overrides = {}) => deriveRoutingPolicy({
    composed, globalGeneration: 4, projectGeneration: 2, ...overrides,
  });
  const policy = derive();

  assert.equal(policy.schemaVersion, ROUTING_POLICY_VERSION);
  assert.equal(policy.revision, routingPolicyRevision({
    globalGeneration: 4, projectGeneration: 2, inventoryRevision: POLICY_INVENTORY.revision,
  }));
  assert.deepEqual(policy.allowedSurfaces, ['codex', 'claude']);
  assert.deepEqual(policy.allowedTransports, ['native', 'approved-plugin']);
  assert.equal(policy.switching, 'automatic');
  assert.deepEqual(policy.roster, [
    { model: 'model-a', effort: 'high' },
    { model: 'model-b', effort: 'high' },
  ]);
  assert.deepEqual(policy.standardRoutes.judgment, {
    model: 'model-b', effort: 'high', state: 'configured',
  });
  // The resolver's fallback semantics stay in the policy and default fail-closed.
  assert.equal(policy.unreachable, 'block');
  assert.equal(policy.missingInfrastructure, 'block');
  assert.deepEqual(derive(), policy, 'derivation is pure');
  assert.throws(() => derive({ unreachable: 'improvise' }), /unreachable/);

  const narrowed = composeRoutingProfile({
    global: globalAuthorization(),
    project: {
      schemaVersion: ROUTING_PROFILE_VERSION,
      selectedSurfaces: null,
      authorizedTransports: null,
      switching: 'current-surface-only',
      roster: [policyPair('model-a')],
      standardRoutes: null,
    },
    inventory: POLICY_INVENTORY,
  });
  const narrowedPolicy = deriveRoutingPolicy({
    composed: narrowed, globalGeneration: 4, projectGeneration: 3,
  });
  assert.deepEqual(narrowedPolicy.roster, [{ model: 'model-a', effort: 'high' }]);
  assert.equal(narrowedPolicy.switching, 'current-surface-only');
  // judgment named a pair the project narrowed away: derived unresolved, never replaced.
  assert.equal(narrowedPolicy.standardRoutes.judgment.state, 'unresolved');
  assert.notEqual(narrowedPolicy.revision, policy.revision);
});

test('deriving a policy from a profile that authorizes nothing blocks with the named reason', () => {
  const composed = composeRoutingProfile({
    global: globalAuthorization({
      roster: [
        { model: 'model-a', effort: 'high', state: 'declined' },
        { model: 'model-b', effort: 'high', state: 'declined' },
      ],
      standardRoutes: NO_STANDARD_ROUTES,
    }),
    inventory: POLICY_INVENTORY,
  });

  assert.deepEqual(composed.roster, []);
  assert.throws(
    () => deriveRoutingPolicy({ composed, globalGeneration: 1, projectGeneration: null }),
    /routing-policy-not-derivable/,
  );
});

const resolverFixture = (overrides = {}) => ({
  intent: routingIntent(),
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
  assert.equal(ROUTE_DECISION_VERSION, 2);
  // Provenance and execution state are orthogonal axes, each with its own vocabulary.
  assert.deepEqual([...ROUTE_DECISION_ORIGINS], ['evidence', 'standard']);
  assert.deepEqual([...ROUTE_DECISION_STATES], [
    'ready', 'approval-required', 'verification-required', 'blocked',
  ]);
  assert.deepEqual([...BEST_OVERALL_STATES], ['resolved', 'ambiguous', 'unavailable']);
  assert.equal(decision.status, 'ready');
  assert.equal(decision.origin, 'evidence');
  assert.equal(decision.state, 'ready');
  assert.equal(decision.bestOverall.status, 'resolved');
  assert.equal(decision.bestOverall.route.modelId, 'model-b');
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
  // The roster authorizes what may be dispatched, so it names the fixture's own pairs.
  const frontendPolicy = routingPolicy({
    roster: [
      policyPair('model-a'),
      policyPair('model-b'),
      ...models.map(({ modelId }) => policyPair(modelId)),
    ],
  });
  const greenfield = resolveRoute(resolverFixture({
    intent: routingIntent({ evidenceSelection: greenfieldSelection }),
    catalog,
    policy: frontendPolicy,
    accessGraph: {
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'frontend-access-r1',
      paths,
    },
  }));
  assert.equal(greenfield.intent.workload, 'development');
  assert.equal(greenfield.status, 'ready');
  assert.equal(greenfield.bestOverall.status, 'resolved');
  assert.match(greenfield.bestOverall.route.workload, /visual-preference$/);
  assert.match(greenfield.bestOverall.route.reason, /frontend-greenfield:marketing:visual-preference/);
  assert.notEqual(greenfield.bestOverall.route.observationId, wrongAxis.id);

  const repairSelection = classifyFrontendWorkload({
    lifecycle: 'repair',
    repositoryContext: 'existing-repository',
    qualityAxes: ['functional', 'visual-preference'],
  }).evidenceSelection;
  const repair = resolveRoute(resolverFixture({
    intent: routingIntent({ evidenceSelection: repairSelection }),
    catalog,
    policy: frontendPolicy,
    accessGraph: {
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'frontend-access-r1',
      paths,
    },
  }));
  assert.equal(repair.status, 'ready');
  assert.equal(repair.bestOverall.status, 'resolved');
  assert.match(repair.bestOverall.route.workload, /frontend-repository-repair:general:functional/);
  assert.match(repair.bestOverall.route.reason, /frontend-repository-repair:general:functional/);
  assert.equal(repair.bestOverall.route.source.id, openHandsFrontendSource.sourceId);
});

test('routing intent keeps evidence selection provider-neutral and rejects unknown nested fields', () => {
  const evidenceSelection = classifyFrontendWorkload({
    lifecycle: 'greenfield',
    repositoryContext: 'isolated',
    qualityAxes: ['visual-preference'],
  }).evidenceSelection;
  const intent = routingIntent({ workload: 'judgment', reasoning: 'deep', evidenceSelection });
  assert.deepEqual(validateRoutingIntent(intent), {
    ...intent,
    evidenceSelection,
  });
  assert.throws(
    () => validateRoutingIntent(routingIntent({
      evidenceSelection: { ...evidenceSelection, modelId: 'volatile-model' },
    })),
    /unknown evidence selection field: modelId/,
  );

  const block = serializeRoutingIntent(intent);
  assert.match(block, /^evidence-selection: frontend-greenfield:general:visual-preference$/m);
  assert.deepEqual(parseRoutingIntent(block).intent, validateRoutingIntent(intent));
  assert.throws(
    () => serializeRoutingIntent(routingIntent({
      evidenceSelection: { ...evidenceSelection, axes: ['visual,preference'] },
    })),
    /evidence selection axis must not contain a comma/,
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

test('a model-and-effort pair outside the roster is refused before any executable ranking', () => {
  const outsideRoster = resolveRoute(resolverFixture({
    policy: routingPolicy({
      roster: [policyPair('model-b')],
      standardRoutes: {
        mechanical: policyRoute('model-b'),
        development: policyRoute('model-b'),
        judgment: policyRoute('model-b'),
      },
    }),
  }));

  assert.equal(outsideRoster.status, 'blocked');
  assert.equal(outsideRoster.bestExecutable, null);
  assert.ok(outsideRoster.blockers.includes('pair-not-authorized:model-a+high'));
  // The roster authorizes dispatch; it never edits the evidence view.
  assert.equal(outsideRoster.bestOverall.status, 'resolved');
  assert.equal(outsideRoster.bestOverall.route.modelId, 'model-b');

  // The pair is the unit: the same model at an effort the roster never admitted stays refused.
  const otherEffort = resolveRoute(resolverFixture({
    policy: routingPolicy({
      roster: [policyPair('model-a', 'low'), policyPair('model-b')],
      standardRoutes: {
        mechanical: policyRoute('model-a', 'low'),
        development: policyRoute('model-a', 'low'),
        judgment: policyRoute('model-b'),
      },
    }),
  }));
  assert.equal(otherEffort.bestExecutable, null);
  assert.ok(otherEffort.blockers.includes('pair-not-authorized:model-a+high'));
});

test('candidates from different cohorts are never compared and the Standard route decides', () => {
  const decision = resolveRoute(resolverFixture({
    catalog: {
      schemaVersion: EVIDENCE_CATALOG_VERSION,
      revision: 'catalog-r8',
      models: [
        { providerId: 'provider-a', modelId: 'model-a' },
        { providerId: 'provider-b', modelId: 'model-b' },
      ],
      observations: [
        observation(),
        observation({
          id: 'other-harness:model-b:high',
          providerId: 'provider-b',
          modelId: 'model-b',
          score: 0.98,
          harness: { id: 'other-harness', version: '9.0' },
        }),
      ],
    },
    accessGraph: {
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'access-r5',
      paths: [
        accessPath(),
        accessPath({
          id: 'codex:native:model-b',
          providerId: 'provider-b',
          modelId: 'model-b',
        }),
      ],
    },
  }));

  assert.equal(decision.bestOverall.status, 'ambiguous');
  assert.equal(decision.bestOverall.route, null, 'no single best across incomparable cohorts');
  assert.deepEqual(
    decision.bestOverall.cohorts.map((entry) => entry.modelId).sort(),
    ['model-a', 'model-b'],
  );
  // Not an arbitrary pick: the Standard route decides and the decision says so.
  assert.equal(decision.origin, 'standard');
  assert.equal(decision.state, 'ready');
  assert.equal(decision.status, 'ready');
  assert.equal(decision.reason, 'ambiguous-evidence');
  assert.equal(decision.selected.workloadClass, 'development');
  assert.equal(decision.bestExecutable.modelId, 'model-a');
  assert.equal(decision.bestExecutable.score, undefined, 'a fallback fabricates no evidence');
  assert.equal(decision.bestExecutable.observationId, undefined);
});

test('inside one cohort uncertainty decides comparability and cost only breaks the tie', () => {
  const cohortCatalog = {
    schemaVersion: EVIDENCE_CATALOG_VERSION,
    revision: 'catalog-r9',
    models: [
      { providerId: 'provider-a', modelId: 'model-a' },
      { providerId: 'provider-b', modelId: 'model-b' },
      { providerId: 'provider-c', modelId: 'model-c' },
    ],
    observations: [
      observation({ id: 'cohort:model-a', score: 0.9, cost: { amount: 5, currency: 'USD', unit: 'run' } }),
      observation({
        id: 'cohort:model-b',
        providerId: 'provider-b',
        modelId: 'model-b',
        score: 0.89,
        cost: { amount: 1, currency: 'USD', unit: 'run' },
      }),
      observation({
        id: 'cohort:model-c',
        providerId: 'provider-c',
        modelId: 'model-c',
        score: 0.4,
        cost: { amount: 0, currency: 'USD', unit: 'run' },
      }),
    ],
  };
  const decision = resolveRoute(resolverFixture({ catalog: cohortCatalog }));

  assert.equal(decision.bestOverall.cohorts.length, 1, 'one comparable cohort');
  assert.equal(decision.bestOverall.status, 'resolved');
  // 0.90 vs 0.89 sits inside the combined uncertainty, so the cheaper pair wins;
  // 0.40 is decisively worse and its zero cost never buys it the route.
  assert.equal(decision.bestOverall.route.modelId, 'model-b');
});

test('an intent no evidence covers reports bestOverall unavailable and names the Standard route', () => {
  const decision = resolveRoute(resolverFixture({
    intent: routingIntent({ workload: 'judgment' }),
  }));

  assert.equal(decision.bestOverall.status, 'unavailable');
  assert.equal(decision.bestOverall.route, null);
  assert.deepEqual(decision.bestOverall.cohorts, []);
  assert.equal(decision.origin, 'standard');
  assert.equal(decision.reason, 'no-evidence-route');
  assert.equal(decision.selected.workloadClass, 'judgment');
  assert.equal(decision.selected.modelId, 'model-b');
  assert.equal(decision.state, 'blocked', 'the judgment Standard route has no attested path here');
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.bestExecutable, null);
  assert.ok(decision.blockers.includes('standard-route-unreachable:model-b+high'));
});

test('ask-before-switching resolves an approval-required candidate and blocks without approval', () => {
  const approvalFixture = (approval) => resolverFixture({
    accessGraph: {
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: 'access-r4',
      paths: [accessPath({
        id: 'claude:plugin:model-a',
        surfaceId: 'claude',
        transportId: 'approved-plugin',
      })],
    },
    policy: routingPolicy({ switching: 'ask' }),
    ...(approval === undefined ? {} : { approval }),
  });

  const pending = resolveRoute(approvalFixture());
  assert.equal(pending.origin, 'evidence');
  assert.equal(pending.state, 'approval-required');
  assert.equal(pending.reason, 'approval-required');
  assert.equal(pending.selected.surfaceId, 'claude');
  assert.equal(pending.status, 'blocked', 'a pending approval never dispatches');
  assert.equal(pending.bestExecutable, null);
  assert.ok(pending.blockers.includes('surface-switch-approval-required:claude'));

  const granted = resolveRoute(approvalFixture({
    decision: 'granted',
    authorizationId: 'plan-authorization-1',
  }));
  assert.equal(granted.state, 'ready');
  assert.equal(granted.status, 'ready');
  assert.equal(granted.bestExecutable.surfaceId, 'claude');
  assert.equal(granted.approval.authorizationId, 'plan-authorization-1');

  const declined = resolveRoute(approvalFixture({ decision: 'declined' }));
  assert.equal(declined.state, 'blocked');
  assert.equal(declined.status, 'blocked');
  assert.equal(declined.bestExecutable, null);
  assert.ok(declined.blockers.includes('approval-declined:claude'));
  assert.throws(
    () => resolveRoute(approvalFixture({ decision: 'maybe' })),
    /approval decision must be one of/,
  );
});

test('untested access is a supervised verification route and stays blocked for an AFK run', () => {
  const untested = {
    schemaVersion: ACCESS_GRAPH_VERSION,
    revision: 'access-r6',
    paths: [accessPath({ availability: 'unknown', attestation: null })],
  };

  const supervised = resolveRoute(resolverFixture({ accessGraph: untested }));
  assert.equal(supervised.origin, 'evidence');
  assert.equal(supervised.state, 'verification-required');
  assert.equal(supervised.status, 'blocked');
  assert.equal(supervised.bestExecutable, null);
  assert.ok(supervised.blockers.includes('access-unknown:codex:native:model-a'));

  const afk = resolveRoute(resolverFixture({
    accessGraph: untested,
    intent: routingIntent({ autonomyRequirement: 'afk' }),
  }));
  assert.equal(afk.state, 'blocked');
  assert.equal(afk.bestExecutable, null);
  assert.ok(afk.blockers.includes('afk-requires-attested-access:codex:native:model-a'));
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
  assert.equal(DISPATCH_RECEIPT_VERSION, 2);
  const receipt = createDispatchReceipt({
    executionId: 'run-123',
    status: 'dispatched',
    afk: true,
    requestedRoute: dispatchedRoute(),
    appliedRoute: dispatchedRoute(),
    enforcement: { model: 'per-spawn', effort: 'per-spawn' },
    precedence: { model: 'explicit-argument', effort: 'explicit-argument' },
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
  assert.deepEqual(receipt.precedence, {
    model: 'explicit-argument',
    effort: 'explicit-argument',
  });
});

test('dispatch receipt rejects silent degradation and unenforced AFK routes', () => {
  const base = {
    executionId: 'run-123',
    status: 'dispatched',
    afk: true,
    requestedRoute: dispatchedRoute(),
    appliedRoute: dispatchedRoute(),
    enforcement: { model: 'per-spawn', effort: 'per-spawn' },
    precedence: { model: 'explicit-argument', effort: 'explicit-argument' },
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
  assert.throws(
    () => createDispatchReceipt({
      ...base,
      precedence: { model: 'arbitrary-precedence', effort: 'explicit-argument' },
    }),
    /model precedence/,
  );
  const { precedence: _precedence, ...withoutPrecedence } = base;
  assert.throws(
    () => createDispatchReceipt(withoutPrecedence),
    /AFK dispatch requires verified environment precedence/,
  );
});

test('blocked mismatch receipt preserves applied route and structured precedence', () => {
  const receipt = createDispatchReceipt({
    executionId: 'run-mismatch',
    status: 'blocked',
    afk: true,
    requestedRoute: dispatchedRoute(),
    appliedRoute: dispatchedRoute({ modelId: 'environment-model' }),
    enforcement: { model: 'named-agent', effort: 'named-agent' },
    precedence: {
      model: 'environment-over-agent-definition',
      effort: 'agent-definition-over-environment',
    },
    revisions: {
      catalog: 'catalog-r7',
      accessGraph: 'access-r4',
      policy: 'policy-r5',
    },
    dispatchedAt: '2026-07-23T00:01:00.000Z',
    reason: 'environment precedence mismatch: model',
  });

  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.appliedRoute.modelId, 'environment-model');
  assert.equal(receipt.precedence.model, 'environment-over-agent-definition');
});

test('receipt v2 keeps non-AFK callers compatible with explicit unreported precedence', () => {
  const receipt = createDispatchReceipt({
    executionId: 'run-interactive-legacy',
    status: 'dispatched',
    afk: false,
    requestedRoute: dispatchedRoute(),
    appliedRoute: dispatchedRoute(),
    enforcement: { model: 'session-default', effort: 'session-default' },
    revisions: {
      catalog: 'catalog-r7',
      accessGraph: 'access-r4',
      policy: 'policy-r5',
    },
    dispatchedAt: '2026-07-23T00:01:00.000Z',
  });

  assert.deepEqual(receipt.precedence, { model: 'unreported', effort: 'unreported' });
});
