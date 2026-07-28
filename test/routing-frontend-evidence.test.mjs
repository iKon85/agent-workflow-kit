import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { codeArenaSource } from '../src/lib/routingSources/codeArena.mjs';
import { openHandsFrontendSource } from '../src/lib/routingSources/openhandsFrontend.mjs';
import { benchLmSource } from '../src/lib/routingSources/benchlm.mjs';
import {
  EVIDENCE_AXES,
  EVIDENCE_WORKLOADS,
  FRONTEND_QUALITY_AXES,
  evidenceAxesFor,
  evidenceDomainsFor,
  evidenceIdentity,
  evidenceSourceClaim,
  isDecisiveEvidence,
  validateEvidenceCatalog,
} from '../src/lib/routingCatalog.mjs';
import { refreshRoutingEvidence } from '../src/commands/routing-policy-update.mjs';
import {
  FRONTEND_SOURCE_CLAIMS,
  classifyFrontendWorkload,
  createFrontendRouteReason,
  evaluateVision2WebReadiness,
} from '../src/lib/frontendWorkloads.mjs';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/routing/${name}.json`, import.meta.url)));

const context = {
  snapshotHash: 'sha256:0123456789abcdef',
  observedAt: '2026-07-22T12:00:00.000Z',
  expiresAt: '2026-08-22T12:00:00.000Z',
};

test('frontend taxonomy keeps visual generation, repository repair, and quality gaps separate', () => {
  assert.deepEqual(
    classifyFrontendWorkload({
      lifecycle: 'greenfield',
      repositoryContext: 'isolated',
      qualityAxes: ['visual-preference', 'functional'],
      frontendDomain: 'marketing',
    }),
    {
      evidenceSelection: {
        workload: 'frontend-greenfield',
        domain: 'marketing',
        axes: ['visual-preference'],
      },
      repositoryContext: 'isolated',
      unsupportedAxes: ['functional'],
    },
  );
  assert.deepEqual(
    classifyFrontendWorkload({
      lifecycle: 'repair',
      repositoryContext: 'existing-repository',
      qualityAxes: ['functional', 'accessibility', 'responsive'],
    }),
    {
      evidenceSelection: {
        workload: 'frontend-repository-repair',
        domain: 'general',
        axes: ['functional'],
      },
      repositoryContext: 'existing-repository',
      unsupportedAxes: ['accessibility', 'responsive'],
    },
  );
  assert.deepEqual(FRONTEND_SOURCE_CLAIMS.design2code.axes, ['visual-fidelity']);
  assert.equal(isDecisiveEvidence(FRONTEND_SOURCE_CLAIMS.design2code), false);
});

test('the frontend vocabulary is a strict subset of the researched taxonomy', () => {
  const frontendWorkloads = ['frontend-greenfield', 'frontend-repository-repair'];
  for (const workload of frontendWorkloads) {
    assert.ok(EVIDENCE_WORKLOADS.includes(workload), `taxonomy must contain ${workload}`);
    assert.deepEqual(evidenceDomainsFor(workload), [
      'general',
      'reference-design',
      'marketing',
      'analytics',
      'product',
      'game',
      'simulation',
      'editor',
    ]);
    for (const axis of FRONTEND_QUALITY_AXES) {
      assert.ok(evidenceAxesFor(workload).includes(axis), `${workload} must keep ${axis}`);
      assert.ok(EVIDENCE_AXES.includes(axis), `taxonomy must contain ${axis}`);
    }
  }
  assert.deepEqual(
    [...FRONTEND_QUALITY_AXES].sort(),
    ['accessibility', 'functional', 'responsive', 'visual-fidelity', 'visual-preference'],
  );
  assert.equal(
    evidenceIdentity({ workload: 'frontend-greenfield', domain: 'marketing', axis: 'visual-preference' }),
    'frontend-greenfield:marketing:visual-preference',
  );
  // The generalization is additive: it never widens the frontend segments onto
  // workloads whose owner publishes a single aggregate.
  assert.deepEqual(evidenceDomainsFor('repository-repair'), ['general']);
  assert.throws(
    () => evidenceIdentity({ workload: 'repository-repair', domain: 'marketing', axis: 'functional' }),
    /domain/,
  );
  assert.throws(
    () => evidenceIdentity({ workload: 'repository-repair', axis: 'visual-preference' }),
    /axis/,
  );
  assert.throws(
    () => evidenceIdentity({ workload: 'frontend-design', axis: 'functional' }),
    /unknown evidence workload/,
  );
  assert.throws(
    () => validateEvidenceCatalog({
      schemaVersion: 1,
      revision: 'taxonomy-guard-r1',
      models: [{ providerId: 'provider-k', modelId: 'model-k' }],
      observations: [{
        id: 'guard:1',
        providerId: 'provider-k',
        modelId: 'model-k',
        effort: 'unknown',
        workload: 'frontend-greenfield:marketing:pixel-vibes',
        harness: { id: 'h', version: '1' },
        score: 1,
        source: {
          id: 'code-arena-webdev',
          owner: 'Arena',
          url: 'https://arena.ai/leaderboard/code/webdev',
          benchmark: 'code-arena-webdev',
          version: '2026-07-22',
          snapshotHash: 'sha256:guard',
        },
        uncertainty: { kind: 'confidence-interval', value: 1 },
        freshness: {
          observedAt: '2026-07-22T12:00:00.000Z',
          expiresAt: '2026-08-22T12:00:00.000Z',
        },
        cost: { amount: 0, currency: 'USD', unit: 'run' },
      }],
    }),
    /axis/,
  );
});

test('the two formerly decisive frontend sources name the dimension they collapse', () => {
  for (const sourceId of ['code-arena-webdev', 'openhands-frontend']) {
    const claim = FRONTEND_SOURCE_CLAIMS[sourceId];
    assert.deepEqual(claim, { ...claim, ...evidenceSourceClaim(sourceId) });
    assert.equal(claim.measuresTriple, true, `${sourceId} measures its triple`);
    assert.equal(claim.preservesHarness, true, `${sourceId} names its harness`);
    assert.equal(claim.preservesEffort, false, `${sourceId} collapses effort`);
    assert.deepEqual(claim.collapsedDimensions, ['effort']);
    assert.match(claim.reason, /effort/);
    assert.equal(isDecisiveEvidence(claim), false);
    assert.equal('decisive' in claim, false);
  }
});

test('Code Arena adapter emits model-plus-harness preference evidence without overstating axes', async () => {
  assert.ok(Object.isFrozen(codeArenaSource));
  const result = codeArenaSource.ingest({
    payload: await fixture('code-arena'),
    ...context,
  });

  assert.equal(result.sourceId, 'code-arena-webdev');
  assert.equal(result.observations.length, 3);
  assert.deepEqual(
    new Set(result.observations.map(({ workload }) => workload)),
    new Set(['frontend-greenfield:marketing:visual-preference']),
  );
  assert.equal(result.observations[0].source.snapshotHash, context.snapshotHash);
  assert.equal(result.observations[0].uncertainty.status, 'preliminary');
  assert.equal(result.observations[1].uncertainty.status, 'established');
  assert.equal(result.observations[0].effort, 'unknown');
  assert.doesNotMatch(JSON.stringify(result.observations), /accessibility|responsive/);
  assert.doesNotThrow(() => validateEvidenceCatalog({
    schemaVersion: 1,
    revision: 'frontend-code-arena-r1',
    models: result.models,
    observations: result.observations,
  }));

  const reason = createFrontendRouteReason(result.observations[0]);
  assert.match(reason, /frontend-greenfield/);
  assert.match(reason, /visual-preference/);
  assert.match(reason, /code-arena-webdev/);
});

test('overlapping Code Arena confidence intervals and preliminary status remain explicit', async () => {
  const result = codeArenaSource.ingest({
    payload: await fixture('code-arena'),
    ...context,
  });
  assert.equal(result.diagnostics.overlappingUncertainty, true);
  assert.deepEqual(result.diagnostics.preliminaryObservationIds, [
    result.observations[0].id,
  ]);
});

test('OpenHands adapter emits only existing-repository functional repair evidence', async () => {
  assert.ok(Object.isFrozen(openHandsFrontendSource));
  const result = openHandsFrontendSource.ingest({
    payload: await fixture('openhands-frontend'),
    ...context,
  });

  assert.equal(result.sourceId, 'openhands-frontend');
  assert.equal(result.observations.length, 1);
  assert.equal(
    result.observations[0].workload,
    'frontend-repository-repair:general:functional',
  );
  assert.equal(result.observations[0].harness.id, 'openhands-sdk');
  assert.doesNotMatch(JSON.stringify(result.observations), /visual-preference|accessibility|responsive/);
  assert.match(createFrontendRouteReason(result.observations[0]), /functional/);
  assert.doesNotThrow(() => validateEvidenceCatalog({
    schemaVersion: 1,
    revision: 'frontend-openhands-r1',
    models: result.models,
    observations: result.observations,
  }));
});

test('empty current-season Vision2Web is candidate readiness, not a route observation', () => {
  assert.deepEqual(
    evaluateVision2WebReadiness({
      season: '2026-s1',
      benchmarkVersion: '1.0',
      results: [],
    }),
    {
      sourceId: 'vision2web',
      status: 'candidate',
      season: '2026-s1',
      benchmarkVersion: '1.0',
      observations: [],
      reason: 'current-season-leaderboard-empty',
    },
  );
});

test('BenchLM discovers catalog and pricing changes but emits no decisive observations', async () => {
  assert.ok(Object.isFrozen(benchLmSource));
  const result = benchLmSource.ingest({
    payload: await fixture('benchlm'),
    ...context,
  });

  assert.deepEqual(result.models, [
    { providerId: 'provider-n', modelId: 'model-new' },
  ]);
  assert.deepEqual(result.observations, []);
  assert.ok(result.signals.some(({ kind }) => kind === 'candidate-discovered'));
  assert.ok(result.signals.some(({ kind }) => kind === 'pricing-changed'));
  assert.ok(result.signals.some(({ kind }) => kind === 'evidence-gap'));
  assert.doesNotMatch(JSON.stringify(result.observations), /model-new|effort/);
});

const emptyCache = () => ({
  schemaVersion: 1,
  revision: 0,
  refreshedAt: '2026-07-01T12:00:00.000Z',
  expiresAt: '2026-08-01T12:00:00.000Z',
  catalog: {
    schemaVersion: 1,
    revision: 'catalog-r0',
    models: [],
    observations: [],
  },
});

const loadedBenchLm = (payload, snapshotHash) => ({
  adapter: benchLmSource,
  load: async () => ({ payload, snapshotHash }),
});

test('BenchLM source state persists advisory signals, retains LKG offline, and replaces on empty', async () => {
  const first = await refreshRoutingEvidence({
    sources: [loadedBenchLm(await fixture('benchlm'), context.snapshotHash)],
    currentCache: emptyCache(),
    expectedRevision: 0,
    refreshedAt: context.observedAt,
    expiresAt: context.expiresAt,
  });

  assert.deepEqual(first.cache.catalog.models, [
    { providerId: 'provider-n', modelId: 'model-new' },
  ]);
  assert.deepEqual(first.cache.catalog.observations, []);
  assert.equal(first.cache.sources[0].sourceId, benchLmSource.sourceId);
  assert.ok(first.cache.sources[0].signals.some(({ kind }) => kind === 'pricing-changed'));
  assert.ok(first.cache.sources[0].signals.some(({ kind }) => kind === 'freshness'));
  assert.ok(
    first.cache.sources[0].signals.some(({ kind }) => kind === 'corroboration-candidate'),
  );

  const offline = await refreshRoutingEvidence({
    sources: [{
      adapter: benchLmSource,
      load: async () => {
        throw new Error('offline');
      },
    }],
    currentCache: first.cache,
    expectedRevision: 1,
    refreshedAt: '2026-07-23T12:00:00.000Z',
    expiresAt: '2026-08-23T12:00:00.000Z',
  });
  assert.equal(offline.sources[0].status, 'cached');
  assert.deepEqual(offline.cache.sources[0], first.cache.sources[0]);

  const emptyPayload = {
    schemaVersion: 1,
    generatedAt: '2026-07-24T10:00:00.000Z',
    sourceLastUpdated: '2026-07-24T10:00:00.000Z',
    models: [],
    benchmarks: [],
    updates: [],
  };
  const emptied = await refreshRoutingEvidence({
    sources: [loadedBenchLm(emptyPayload, 'sha256:empty-benchlm')],
    currentCache: offline.cache,
    expectedRevision: 2,
    refreshedAt: '2026-07-24T12:00:00.000Z',
    expiresAt: '2026-08-24T12:00:00.000Z',
  });
  assert.deepEqual(emptied.cache.catalog.models, []);
  assert.deepEqual(emptied.cache.catalog.observations, []);
  assert.deepEqual(emptied.cache.sources[0].models, []);
  assert.deepEqual(emptied.cache.sources[0].signals, []);
});

test('broken owner links, duplicate identities, and inconsistent exports quarantine by throwing', async () => {
  const codeArena = await fixture('code-arena');
  codeArena.benchmark.url = 'https://aggregator.invalid/code-arena';
  assert.throws(
    () => codeArenaSource.ingest({ payload: codeArena, ...context }),
    /owner URL/,
  );

  const openHands = await fixture('openhands-frontend');
  openHands.rows.push(structuredClone(openHands.rows[0]));
  assert.throws(
    () => openHandsFrontendSource.ingest({ payload: openHands, ...context }),
    /duplicate observation identity/,
  );

  const effortLabelled = await fixture('code-arena');
  effortLabelled.rows[2].effort = 'xhigh';
  assert.throws(
    () => codeArenaSource.ingest({ payload: effortLabelled, ...context }),
    /does not preserve reasoning effort/,
  );

  const votePriced = await fixture('code-arena');
  votePriced.rows[0].cost.unit = 'vote';
  assert.throws(
    () => codeArenaSource.ingest({ payload: votePriced, ...context }),
    /unit must be one of: attempt, run, success-derived/,
  );

  const benchLm = await fixture('benchlm');
  benchLm.benchmarks.push(structuredClone(benchLm.benchmarks[0]));
  assert.throws(
    () => benchLmSource.ingest({ payload: benchLm, ...context }),
    /duplicate benchmark identity/,
  );

  const inconsistent = await fixture('benchlm');
  inconsistent.sourceLastUpdated = '2026-07-23T12:00:00.000Z';
  assert.throws(
    () => benchLmSource.ingest({ payload: inconsistent, ...context }),
    /sourceLastUpdated cannot follow generatedAt/,
  );
});
