import test from 'node:test';
import assert from 'node:assert/strict';

import { ACCESS_GRAPH_VERSION } from '../src/lib/routingAccessGraph.mjs';
import { ROUTING_POLICY_VERSION } from '../src/lib/routingPolicy.mjs';
import { ROUTING_INTENT_VERSION } from '../src/lib/routingIntent.mjs';
import {
  BOUNDED_RE_RESOLUTION_AXES,
  DISPATCH_PLAN_VERSION,
  PLAN_AUTHORIZATION_MISMATCH,
  PLAN_ROUTE_DRIFT,
  PLAN_UNIT_UNAUTHORIZED,
  authorizeDispatchPlan,
  authorizeDispatchUnit,
  buildDispatchPlan,
  canonicalizeDispatchPlan,
  checkPlanAuthorization,
  dispatchPlanHash,
} from '../src/lib/dispatchPlan.mjs';

const DATES = { observedAt: '2026-07-01T00:00:00.000Z', expiresAt: '2026-08-01T00:00:00.000Z' };

function observation(id, { modelId, score }) {
  return {
    id,
    providerId: 'anthropic',
    modelId,
    effort: 'high',
    workload: 'development',
    harness: { id: 'fixture', version: '1' },
    score,
    source: {
      owner: 'fixture', id: `fixture-${modelId}`, url: 'https://example.invalid/evidence',
      benchmark: 'fixture', version: '1', snapshotHash: `hash-${id}`,
    },
    uncertainty: { kind: 'interval', value: 0.01 },
    freshness: { ...DATES },
    cost: { amount: 1, currency: 'USD', unit: 'task' },
  };
}

function accessPath(id, modelId) {
  return {
    id,
    providerId: 'anthropic',
    modelId,
    effort: 'high',
    surfaceId: 'claude',
    transportId: 'claude-native',
    availability: 'available',
    enforcement: { model: 'named-agent', effort: 'named-agent' },
    capabilityEvidence: { revision: 'capability-1', ...DATES },
    attestation: {
      result: 'available',
      failureKind: null,
      probeId: 'capability-probe:minimal',
      authorizationId: 'probe-authorization-1',
      ...DATES,
    },
  };
}

/** One routing context; every override is applied to a fresh deep copy. */
function context({ compactScore = 0.5, revisions = {} } = {}) {
  const pair = (model) => ({ model, effort: 'high' });
  return {
    catalog: {
      schemaVersion: 1,
      revision: revisions.catalog ?? 'catalog-1',
      models: [
        { providerId: 'anthropic', modelId: 'reasoning-model' },
        { providerId: 'anthropic', modelId: 'compact-model' },
      ],
      observations: [
        observation('observation-reasoning', { modelId: 'reasoning-model', score: 0.9 }),
        observation('observation-compact', { modelId: 'compact-model', score: compactScore }),
      ],
    },
    accessGraph: {
      schemaVersion: ACCESS_GRAPH_VERSION,
      revision: revisions.accessGraph ?? 'access-1',
      paths: [accessPath('path-reasoning', 'reasoning-model'), accessPath('path-compact', 'compact-model')],
    },
    policy: {
      schemaVersion: ROUTING_POLICY_VERSION,
      revision: revisions.policy ?? 'policy-1',
      allowedSurfaces: ['claude'],
      allowedTransports: ['claude-native'],
      switching: 'automatic',
      roster: [pair('reasoning-model'), pair('compact-model')],
      standardRoutes: {
        mechanical: { ...pair('compact-model'), state: 'configured' },
        development: { ...pair('reasoning-model'), state: 'configured' },
        judgment: { ...pair('reasoning-model'), state: 'configured' },
      },
      unreachable: 'block',
      missingInfrastructure: 'block',
    },
    activeSurface: 'claude',
    knownTransports: ['claude-native'],
    now: '2026-07-23T12:00:00.000Z',
  };
}

const JUDGMENT_INTENT = Object.freeze({
  version: ROUTING_INTENT_VERSION,
  workload: 'judgment',
  reasoning: 'deep',
  taskShape: 'long-horizon',
  risk: 'high',
  autonomyRequirement: 'supervised',
  contextNeed: 'long-context',
});

const SIGNALS = Object.freeze({
  outcome: 'implementation',
  steps: 'several',
  blastRadius: 'shared',
  supervision: 'attended',
  breadth: 'repository',
});

const UNITS = Object.freeze([
  Object.freeze({ unitId: 'unit-b', intent: JUDGMENT_INTENT }),
  Object.freeze({ unitId: 'unit-a', signals: SIGNALS }),
]);

const plan = (options) => buildDispatchPlan({ units: UNITS, resolverInput: context(options) });

const RECORD = Object.freeze({
  id: 'plan-authorization-1',
  scope: 'wave-22',
  mode: 'fixed',
  timestamp: '2026-07-23T11:00:00.000Z',
  actor: 'niko',
});

test('a dispatch plan resolves intent before route and names why each route won', () => {
  const built = plan();

  assert.equal(built.schemaVersion, DISPATCH_PLAN_VERSION);
  assert.deepEqual(built.units.map(({ unitId }) => unitId), ['unit-a', 'unit-b']);
  assert.deepEqual(built.revisions, {
    catalog: 'catalog-1', accessGraph: 'access-1', policy: 'policy-1',
  });

  const [classified, explicit] = built.units;
  assert.equal(classified.intentSource, 'classifier');
  assert.equal(classified.intent.workload, 'development');
  assert.equal(classified.origin, 'evidence');
  assert.equal(classified.state, 'ready');
  assert.deepEqual(classified.route, {
    providerId: 'anthropic',
    modelId: 'reasoning-model',
    effort: 'high',
    surfaceId: 'claude',
    transportId: 'claude-native',
  });
  assert.match(classified.reason, /supported by fixture/);

  // No decisive evidence covers judgment, so the Standard route decides and says so.
  assert.equal(explicit.intentSource, 'explicit');
  assert.deepEqual(explicit.intent, JUDGMENT_INTENT);
  assert.equal(explicit.origin, 'standard');
  assert.equal(explicit.reason, 'standard-route:judgment');
});

test('the plan canonicalizes to one hash whatever the unit or key order', () => {
  const built = plan();
  assert.equal(built.planHash, dispatchPlanHash(built));
  assert.match(built.planHash, /^sha256-[0-9a-f]{64}$/);

  const reordered = {
    revisions: { policy: 'policy-1', accessGraph: 'access-1', catalog: 'catalog-1' },
    units: [...built.units].reverse(),
    schemaVersion: built.schemaVersion,
  };
  assert.equal(dispatchPlanHash(reordered), built.planHash);
  assert.equal(canonicalizeDispatchPlan(reordered), canonicalizeDispatchPlan(built));

  // The same units in the other declaration order plan to the same hash.
  assert.equal(
    buildDispatchPlan({ units: [...UNITS].reverse(), resolverInput: context() }).planHash,
    built.planHash,
  );
});

test('the plan hash covers every unit, intent, route, reason and revision', () => {
  const baseline = plan();
  const differs = (mutated, label) =>
    assert.notEqual(dispatchPlanHash(mutated), baseline.planHash, label);

  for (const field of ['catalog', 'accessGraph', 'policy']) {
    differs(plan({ revisions: { [field]: `${field}-2` } }), field);
  }

  // Raising the compact model above the reasoning model changes the chosen route.
  const reranked = plan({ compactScore: 0.99, revisions: { catalog: 'catalog-2' } });
  assert.equal(reranked.units[0].route.modelId, 'compact-model');
  differs(reranked, 'route');

  differs(buildDispatchPlan({
    units: [{ unitId: 'unit-renamed', intent: JUDGMENT_INTENT }, UNITS[1]],
    resolverInput: context(),
  }), 'unitId');
  differs(buildDispatchPlan({
    units: [{ unitId: 'unit-b', intent: { ...JUDGMENT_INTENT, risk: 'low' } }, UNITS[1]],
    resolverInput: context(),
  }), 'intent');

  // A reason on its own is hashed: nothing else about the plan changes here.
  const document = {
    schemaVersion: baseline.schemaVersion,
    revisions: baseline.revisions,
    units: baseline.units.map((unit, index) =>
      index === 0 ? { ...unit, reason: 'standard-route:development' } : unit),
  };
  differs(document, 'reason');
});

test('a plan builder without units, with duplicates, or without revisions fails closed', () => {
  assert.throws(() => buildDispatchPlan({ units: [], resolverInput: context() }),
    /dispatch plan needs at least one unit/);
  assert.throws(() => buildDispatchPlan({
    units: [UNITS[0], { unitId: 'unit-b', signals: SIGNALS }], resolverInput: context(),
  }), /duplicate dispatch plan unit: unit-b/);
  assert.throws(() => buildDispatchPlan({
    units: [{ unitId: 'unit-a', intent: JUDGMENT_INTENT, model: 'opus' }],
    resolverInput: context(),
  }), /unknown dispatch plan unit field: model/);

  const { catalog: _absent, ...withoutCatalog } = context();
  assert.throws(() => buildDispatchPlan({ units: UNITS, resolverInput: withoutCatalog }),
    /dispatch plan requires a catalog revision/);
});

test('an authorization record binds the plan hash to id, scope, mode, timestamp and actor', () => {
  const built = plan();
  const record = authorizeDispatchPlan(built, RECORD);

  for (const field of ['id', 'scope', 'mode', 'timestamp', 'actor']) {
    assert.equal(record[field], RECORD[field], field);
  }
  assert.deepEqual(Object.keys(record).sort(), [
    'actor', 'bounds', 'id', 'mode', 'plan', 'planHash', 'schemaVersion', 'scope', 'timestamp',
  ]);
  assert.equal(record.planHash, built.planHash);
  assert.equal(record.bounds, null);
  assert.equal(record.schemaVersion, DISPATCH_PLAN_VERSION);

  for (const [overrides, pattern] of [
    [{ mode: 'whatever' }, /plan authorization mode must be one of: fixed, bounded-re-resolution/],
    [{ actor: '' }, /plan authorization actor must be a non-empty string/],
    [{ id: null }, /plan authorization id must be a non-empty string/],
    [{ scope: undefined }, /plan authorization scope must be a non-empty string/],
    [{ timestamp: 'yesterday' }, /plan authorization timestamp must be an ISO timestamp/],
    [{ bounds: { axes: ['route'] } }, /a fixed plan authorization records no bounds/],
    [{ approvedBy: 'niko' }, /unknown plan authorization field: approvedBy/],
  ]) {
    assert.throws(() => authorizeDispatchPlan(built, { ...RECORD, ...overrides }), pattern);
  }

  for (const axis of ['intent', 'intentSource', 'units', 'policy']) {
    assert.throws(() => authorizeDispatchPlan(built, {
      ...RECORD, mode: 'bounded-re-resolution', bounds: { axes: ['route', axis] },
    }), new RegExp(`bounded re-resolution cannot cover: ${axis}`), axis);
    assert.ok(!BOUNDED_RE_RESOLUTION_AXES.includes(axis), axis);
  }
  assert.throws(() => authorizeDispatchPlan(built, { ...RECORD, mode: 'bounded-re-resolution' }),
    /bounded re-resolution must name the axes it covers/);
});

test('a plan-hash mismatch blocks pending a newly attributed authorization', () => {
  const record = authorizeDispatchPlan(plan(), RECORD);

  const unchanged = checkPlanAuthorization({ authorization: record, plan: plan() });
  assert.equal(unchanged.state, 'authorized');
  assert.deepEqual(unchanged.drift, []);

  const moved = checkPlanAuthorization({
    authorization: record, plan: plan({ revisions: { accessGraph: 'access-2' } }),
  });
  assert.equal(moved.state, 'blocked');
  assert.equal(moved.reason, PLAN_AUTHORIZATION_MISMATCH);
  assert.deepEqual(moved.drift, ['accessGraph']);

  // A record whose bound contents were rewritten under its own hash never passes.
  const forged = {
    ...record,
    plan: { ...record.plan, revisions: { ...record.plan.revisions, policy: 'policy-2' } },
  };
  const rewritten = checkPlanAuthorization({ authorization: forged, plan: plan() });
  assert.equal(rewritten.state, 'blocked');
  assert.equal(rewritten.reason, PLAN_AUTHORIZATION_MISMATCH);
});

test('a recorded bounded mode continues only inside the bounds it names', () => {
  const built = plan();
  const bounded = (axes) => authorizeDispatchPlan(built, {
    ...RECORD, mode: 'bounded-re-resolution', bounds: { axes },
  });
  const reranked = plan({ compactScore: 0.99, revisions: { catalog: 'catalog-2' } });

  const inside = checkPlanAuthorization({
    authorization: bounded(['route', 'reason', 'catalog']), plan: reranked,
  });
  assert.equal(inside.state, 'authorized');
  assert.equal(inside.mode, 'bounded-re-resolution');
  assert.deepEqual(inside.drift, ['catalog', 'reason', 'route']);

  const outside = checkPlanAuthorization({ authorization: bounded(['catalog']), plan: reranked });
  assert.equal(outside.state, 'blocked');
  assert.equal(outside.reason, PLAN_AUTHORIZATION_MISMATCH);
  assert.deepEqual(outside.outside, ['reason', 'route']);

  // Different work is never bounded re-resolution, whatever the bounds name.
  const rewrittenIntent = buildDispatchPlan({
    units: [{ unitId: 'unit-b', intent: { ...JUDGMENT_INTENT, risk: 'low' } }, UNITS[1]],
    resolverInput: context(),
  });
  const changedWork = checkPlanAuthorization({
    authorization: bounded([...BOUNDED_RE_RESOLUTION_AXES]), plan: rewrittenIntent,
  });
  assert.equal(changedWork.state, 'blocked');
  assert.deepEqual(changedWork.outside, ['intent']);
});

test('every dispatch references the record, per unit and per route', () => {
  const built = plan();
  const record = authorizeDispatchPlan(built, RECORD);
  const route = built.units[0].route;

  const authorized = authorizeDispatchUnit({
    authorization: record, plan: built, unitId: 'unit-a', route,
  });
  assert.deepEqual(authorized, { authorizationId: record.id, reason: null });

  assert.equal(authorizeDispatchUnit({
    authorization: record, plan: built, unitId: 'unit-c', route,
  }).reason, PLAN_UNIT_UNAUTHORIZED);

  assert.equal(authorizeDispatchUnit({
    authorization: record, plan: built, unitId: 'unit-a',
    route: { ...route, modelId: 'compact-model' },
  }).reason, PLAN_ROUTE_DRIFT);

  assert.equal(authorizeDispatchUnit({
    authorization: record, plan: plan({ revisions: { policy: 'policy-2' } }),
    unitId: 'unit-a', route,
  }).reason, PLAN_AUTHORIZATION_MISMATCH);
});
