import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { deepSweSource } from '../src/lib/routingSources/deepswe.mjs';
import {
  artificialAnalysisSource,
} from '../src/lib/routingSources/artificialAnalysis.mjs';
import { openHandsSource } from '../src/lib/routingSources/openhands.mjs';
import { codeArenaSource } from '../src/lib/routingSources/codeArena.mjs';
import { openHandsFrontendSource } from '../src/lib/routingSources/openhandsFrontend.mjs';
import { benchLmSource } from '../src/lib/routingSources/benchlm.mjs';
import {
  EVIDENCE_COST_UNITS,
  evidenceFreshness,
  evidenceSourceClaim,
  isDecisiveEvidence,
  parseEvidenceIdentity,
  validateEvidenceCatalog,
} from '../src/lib/routingCatalog.mjs';
import {
  refreshRoutingEvidence,
} from '../src/commands/routing-policy-update.mjs';

const fixture = async (name) => JSON.parse(await readFile(
  new URL(`./fixtures/routing/${name}.json`, import.meta.url),
  'utf8',
));

const observedAt = '2026-07-23T10:00:00.000Z';
const expiresAt = '2026-08-23T10:00:00.000Z';

function emptyCache() {
  return {
    schemaVersion: 1,
    revision: 0,
    refreshedAt: '2026-07-01T10:00:00.000Z',
    expiresAt: '2026-08-01T10:00:00.000Z',
    catalog: {
      schemaVersion: 1,
      revision: 'catalog-r0',
      models: [],
      observations: [],
    },
  };
}

const liveSource = (adapter, payload, snapshotHash) => ({
  adapter,
  load: async () => ({ payload, snapshotHash }),
});

test('owner adapters preserve execution identity and exact provenance', async () => {
  const snapshots = [
    [deepSweSource, await fixture('deepswe'), 'sha256:deepswe'],
    [artificialAnalysisSource, await fixture('artificial-analysis'), 'sha256:aa'],
    [openHandsSource, await fixture('openhands'), 'sha256:openhands'],
  ];

  for (const [adapter, payload, snapshotHash] of snapshots) {
    const ingested = adapter.ingest({ payload, snapshotHash, observedAt, expiresAt });
    assert.equal(ingested.sourceId, adapter.sourceId);
    assert.ok(ingested.observations.length > 0);
    for (const observation of ingested.observations) {
      assert.ok(observation.modelId);
      assert.ok(observation.effort);
      assert.ok(observation.harness.id);
      assert.ok(observation.harness.version);
      assert.equal(observation.source.owner, adapter.owner);
      assert.equal(observation.source.url, adapter.artifactUrl);
      assert.equal(observation.source.snapshotHash, snapshotHash);
      assert.equal(observation.freshness.observedAt, observedAt);
      assert.ok(Number.isFinite(observation.uncertainty.value));
      assert.ok(Number.isFinite(observation.cost.amount));
    }
  }
});

test('every source carries the three-part decisiveness test instead of a boolean', () => {
  const adapters = [
    deepSweSource,
    artificialAnalysisSource,
    openHandsSource,
    codeArenaSource,
    openHandsFrontendSource,
    benchLmSource,
  ];

  for (const adapter of adapters) {
    const claim = evidenceSourceClaim(adapter.sourceId);
    assert.deepEqual(adapter.claim, claim, `${adapter.sourceId} must publish its claim`);
    assert.equal('decisive' in claim, false, `${adapter.sourceId} must not carry a boolean`);
    for (const flag of ['measuresTriple', 'preservesEffort', 'preservesHarness']) {
      assert.equal(typeof claim[flag], 'boolean', `${adapter.sourceId}.${flag}`);
    }
    assert.equal(
      isDecisiveEvidence(claim),
      claim.collapsedDimensions.length === 0,
      `${adapter.sourceId} decisiveness must follow the three-part test`,
    );
  }

  assert.equal(isDecisiveEvidence(evidenceSourceClaim('deepswe')), true);
  assert.throws(() => evidenceSourceClaim('unlisted-owner'), /unknown evidence source/);
});

test('non-frontend owner adapters emit the researched taxonomy identity and cost unit', async () => {
  const snapshots = [
    [deepSweSource, await fixture('deepswe'), 'sha256:deepswe'],
    [artificialAnalysisSource, await fixture('artificial-analysis'), 'sha256:aa'],
    [openHandsSource, await fixture('openhands'), 'sha256:openhands'],
  ];

  for (const [adapter, payload, snapshotHash] of snapshots) {
    const ingested = adapter.ingest({ payload, snapshotHash, observedAt, expiresAt });
    for (const observation of ingested.observations) {
      assert.deepEqual(parseEvidenceIdentity(observation.workload), {
        workload: 'repository-repair',
        domain: 'general',
        axis: 'functional',
      });
      assert.ok(EVIDENCE_COST_UNITS.includes(observation.cost.unit));
      assert.equal(observation.cost.unit, 'attempt');
      assert.equal(observation.cost.currency, 'USD');
    }
    assert.doesNotThrow(() => validateEvidenceCatalog({
      schemaVersion: 1,
      revision: `taxonomy-${adapter.sourceId}`,
      models: ingested.models,
      observations: ingested.observations,
    }));
  }
});

test('observation freshness follows the Kit policy per source, never the owner', async () => {
  const payload = await fixture('deepswe');
  // An owner-published expiry in the artifact must not reach the observation.
  payload.artifact.expiresAt = '2026-07-23T11:00:00.000Z';
  const ingested = deepSweSource.ingest({
    payload,
    snapshotHash: 'sha256:deepswe',
    observedAt,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const { freshness } = evidenceSourceClaim(deepSweSource.sourceId);
  const expected = new Date(
    Date.parse(observedAt) + freshness.maxAgeDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  assert.equal(freshness.basis, 'kit-policy');
  assert.ok(freshness.maxAgeDays > 0);
  for (const observation of ingested.observations) {
    assert.equal(observation.freshness.observedAt, observedAt);
    assert.equal(observation.freshness.expiresAt, expected);
    assert.equal(observation.freshness.basis, 'kit-policy');
    assert.equal(observation.freshness.maxAgeDays, freshness.maxAgeDays);
  }
  assert.notEqual(
    evidenceFreshness({ sourceId: openHandsSource.sourceId, observedAt }).expiresAt,
    expected,
  );
});

test('an effort-collapsed source may not publish a reasoning effort it never measured', async () => {
  const analysis = await fixture('artificial-analysis');
  analysis.configurations[0].reasoningEffort = 'max';
  assert.throws(
    () => artificialAnalysisSource.ingest({
      payload: analysis,
      snapshotHash: 'sha256:aa-effort',
      observedAt,
      expiresAt,
    }),
    /does not preserve reasoning effort/,
  );

  const openHands = await fixture('openhands');
  openHands.results[0].effort = 'high';
  assert.throws(
    () => openHandsSource.ingest({
      payload: openHands,
      snapshotHash: 'sha256:openhands-effort',
      observedAt,
      expiresAt,
    }),
    /does not preserve reasoning effort/,
  );

  const deepSwe = await fixture('deepswe');
  deepSwe.rows[0].effort = 'unknown';
  assert.throws(
    () => deepSweSource.ingest({
      payload: deepSwe,
      snapshotHash: 'sha256:deepswe-effort',
      observedAt,
      expiresAt,
    }),
    /preserves reasoning effort/,
  );
});

test('an owner cost unit outside the enum quarantines instead of entering the catalog', async () => {
  const payload = await fixture('openhands');
  payload.results[0].meanCost.unit = 'task';
  assert.throws(
    () => openHandsSource.ingest({
      payload,
      snapshotHash: 'sha256:openhands-cost',
      observedAt,
      expiresAt,
    }),
    /unit must be one of: attempt, run, success-derived/,
  );

  const catalogOf = (observations) => ({
    schemaVersion: 1,
    revision: 'cost-unit-r1',
    models: [{ providerId: 'synthetic-provider', modelId: 'synthetic-model' }],
    observations,
  });
  const taxonomyCost = (cost) => [syntheticObservation('cost-unit', 'sha256:cost', {
    workload: 'repository-repair:general:functional',
    cost,
  })];

  assert.throws(
    () => validateEvidenceCatalog(catalogOf(taxonomyCost({
      amount: 1,
      currency: 'USD',
      unit: 'task',
    }))),
    /unit must be one of: attempt, run, success-derived/,
  );
  assert.throws(
    () => validateEvidenceCatalog(catalogOf(taxonomyCost({
      amount: 1,
      currency: 'USD',
      unit: 'success-derived',
    }))),
    /Kit-derived/,
  );
  assert.doesNotThrow(() => validateEvidenceCatalog(catalogOf(taxonomyCost({
    amount: 1,
    currency: 'USD',
    unit: 'success-derived',
    derived: true,
  }))));
  // A legacy aggregate identity names no axis and keeps its free-form unit, so
  // an already-cached catalog stays readable.
  assert.doesNotThrow(() => validateEvidenceCatalog(catalogOf([
    syntheticObservation('cost-unit', 'sha256:cost', {
      cost: { amount: 1, currency: 'USD', unit: 'task' },
    }),
  ])));
});

test('refresh reports source progress, live status, and the final evidence diff', async () => {
  const progress = [];
  const result = await refreshRoutingEvidence({
    sources: [
      liveSource(deepSweSource, await fixture('deepswe'), 'sha256:deepswe'),
      liveSource(
        artificialAnalysisSource,
        await fixture('artificial-analysis'),
        'sha256:aa',
      ),
      liveSource(openHandsSource, await fixture('openhands'), 'sha256:openhands'),
    ],
    currentCache: emptyCache(),
    expectedRevision: 0,
    refreshedAt: observedAt,
    expiresAt,
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.cache.revision, 1);
  assert.deepEqual(result.sources.map(({ status }) => status), ['live', 'live', 'live']);
  assert.deepEqual(progress.filter(({ status }) => status === 'loading').length, 3);
  assert.deepEqual(progress.filter(({ status }) => status === 'live').length, 3);
  assert.equal(result.diff.added.length, 4);
  assert.deepEqual(result.diff.removed, []);
  assert.deepEqual(result.quarantines, []);
});

test('schema, identity, and duplicate failures are quarantined', async () => {
  const changedIdentity = await fixture('deepswe');
  changedIdentity.artifact.url = 'https://mirror.invalid/not-owner-artifact.json';
  assert.throws(
    () => deepSweSource.ingest({
      payload: changedIdentity,
      snapshotHash: 'sha256:changed',
      observedAt,
      expiresAt,
    }),
    /source identity/,
  );

  const missingEffort = await fixture('artificial-analysis');
  delete missingEffort.configurations[0].reasoningEffort;
  assert.throws(
    () => artificialAnalysisSource.ingest({
      payload: missingEffort,
      snapshotHash: 'sha256:missing-effort',
      observedAt,
      expiresAt,
    }),
    /effort/,
  );

  const duplicated = await fixture('openhands');
  duplicated.results.push(structuredClone(duplicated.results[0]));
  const result = await refreshRoutingEvidence({
    sources: [liveSource(openHandsSource, duplicated, 'sha256:duplicate')],
    currentCache: emptyCache(),
    expectedRevision: 0,
    refreshedAt: observedAt,
    expiresAt,
  });
  assert.equal(result.sources[0].status, 'quarantined');
  assert.match(result.quarantines[0].reason, /duplicate/);
  assert.equal(result.cache.catalog.observations.length, 0);
});

test('offline and partial failure keep a visibly dated last-known-good snapshot', async () => {
  const first = await refreshRoutingEvidence({
    sources: [
      liveSource(deepSweSource, await fixture('deepswe'), 'sha256:deepswe'),
      liveSource(openHandsSource, await fixture('openhands'), 'sha256:openhands'),
    ],
    currentCache: emptyCache(),
    expectedRevision: 0,
    refreshedAt: observedAt,
    expiresAt,
  });
  const nextObservedAt = '2026-07-24T10:00:00.000Z';
  const nextExpiresAt = '2026-08-24T10:00:00.000Z';
  const corrupt = await fixture('openhands');
  delete corrupt.results[0].effort;
  const progress = [];
  const second = await refreshRoutingEvidence({
    sources: [
      {
        adapter: deepSweSource,
        load: async () => {
          throw new Error('offline');
        },
      },
      liveSource(openHandsSource, corrupt, 'sha256:corrupt'),
    ],
    currentCache: first.cache,
    expectedRevision: 1,
    refreshedAt: nextObservedAt,
    expiresAt: nextExpiresAt,
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(second.sources.map(({ status }) => status), ['cached', 'cached']);
  assert.ok(second.sources.every(({ cachedAt }) => cachedAt === observedAt));
  assert.equal(second.quarantines.length, 1);
  assert.match(second.quarantines[0].reason, /effort/);
  assert.equal(second.cache.catalog.observations.length, 3);
  assert.ok(second.cache.catalog.observations.every(
    (entry) => entry.freshness.observedAt === observedAt,
  ));
  assert.ok(progress.some(
    ({ sourceId, status }) => sourceId === openHandsSource.sourceId
      && status === 'quarantined',
  ));
  assert.ok(progress.some(({ status }) => status === 'cached'));
  assert.deepEqual(second.diff, { added: [], changed: [], removed: [] });
});

test('refreshing a subset preserves evidence owned by other source adapters', async () => {
  const first = await refreshRoutingEvidence({
    sources: [
      liveSource(deepSweSource, await fixture('deepswe'), 'sha256:deepswe'),
      liveSource(openHandsSource, await fixture('openhands'), 'sha256:openhands'),
    ],
    currentCache: emptyCache(),
    expectedRevision: 0,
    refreshedAt: observedAt,
    expiresAt,
  });
  const second = await refreshRoutingEvidence({
    sources: [
      liveSource(deepSweSource, await fixture('deepswe'), 'sha256:deepswe-next'),
    ],
    currentCache: first.cache,
    expectedRevision: 1,
    refreshedAt: '2026-07-24T10:00:00.000Z',
    expiresAt: '2026-08-24T10:00:00.000Z',
  });

  assert.ok(second.cache.catalog.observations.some(
    ({ source }) => source.id === openHandsSource.sourceId,
  ));
  assert.equal(second.diff.removed.length, 0);
});

test('catalog-only discovered models survive a failed source refresh', async () => {
  const catalogOnlySource = Object.freeze({
    sourceId: 'catalog-only',
    owner: 'Catalog Owner',
    artifactUrl: 'https://owner.invalid/catalog.json',
    ingest: () => ({
      sourceId: 'catalog-only',
      models: [{ providerId: 'provider-c', modelId: 'discovered-model' }],
      observations: [],
    }),
  });
  const first = await refreshRoutingEvidence({
    sources: [liveSource(catalogOnlySource, {}, 'sha256:catalog')],
    currentCache: emptyCache(),
    expectedRevision: 0,
    refreshedAt: observedAt,
    expiresAt,
  });
  const second = await refreshRoutingEvidence({
    sources: [{
      adapter: catalogOnlySource,
      load: async () => {
        throw new Error('offline');
      },
    }],
    currentCache: first.cache,
    expectedRevision: 1,
    refreshedAt: '2026-07-24T10:00:00.000Z',
    expiresAt: '2026-08-24T10:00:00.000Z',
  });

  assert.deepEqual(second.cache.catalog.models, [
    { providerId: 'provider-c', modelId: 'discovered-model' },
  ]);
  assert.deepEqual(second.cache.sources[0].models, [
    { providerId: 'provider-c', modelId: 'discovered-model' },
  ]);
});

function syntheticObservation(sourceId, snapshotHash, overrides = {}) {
  return {
    id: `${sourceId}:shared-observation`,
    providerId: 'synthetic-provider',
    modelId: 'synthetic-model',
    effort: 'high',
    workload: 'development',
    harness: { id: 'synthetic-harness', version: '1' },
    score: 0.5,
    source: {
      id: sourceId,
      owner: 'Synthetic Owner',
      url: `https://owner.invalid/${sourceId}.json`,
      benchmark: 'Synthetic',
      version: '1',
      snapshotHash,
    },
    uncertainty: { kind: 'standard-error', value: 0.1 },
    freshness: { observedAt, expiresAt },
    cost: { amount: 1, currency: 'USD', unit: 'attempt' },
    ...overrides,
  };
}

function syntheticSource(sourceId, transform = (result) => result) {
  const artifactUrl = `https://owner.invalid/${sourceId}.json`;
  return Object.freeze({
    sourceId,
    owner: 'Synthetic Owner',
    artifactUrl,
    ingest: ({ snapshotHash }) => transform({
      sourceId,
      models: [{ providerId: 'synthetic-provider', modelId: 'synthetic-model' }],
      observations: [syntheticObservation(sourceId, snapshotHash)],
      signals: [],
    }),
  });
}

test('foreign source ids and snapshot mismatches quarantine transactionally', async () => {
  const good = syntheticSource('transactional');
  const first = await refreshRoutingEvidence({
    sources: [liveSource(good, {}, 'sha256:good')],
    currentCache: emptyCache(),
    expectedRevision: 0,
    refreshedAt: observedAt,
    expiresAt,
  });
  const bad = syntheticSource('transactional', (result) => ({
    ...result,
    observations: [{
      ...result.observations[0],
      source: { ...result.observations[0].source, id: 'foreign-source' },
    }],
  }));
  const foreign = await refreshRoutingEvidence({
    sources: [liveSource(bad, {}, 'sha256:bad')],
    currentCache: first.cache,
    expectedRevision: 1,
    refreshedAt: '2026-07-24T10:00:00.000Z',
    expiresAt: '2026-08-24T10:00:00.000Z',
  });
  assert.equal(foreign.sources[0].status, 'cached');
  assert.match(foreign.quarantines[0].reason, /source.id/);
  assert.equal(foreign.cache.sources[0].snapshotHash, 'sha256:good');

  const wrongHash = syntheticSource('transactional', (result) => ({
    ...result,
    observations: [{
      ...result.observations[0],
      source: { ...result.observations[0].source, snapshotHash: 'sha256:forged' },
    }],
  }));
  const mismatched = await refreshRoutingEvidence({
    sources: [liveSource(wrongHash, {}, 'sha256:loaded')],
    currentCache: foreign.cache,
    expectedRevision: 2,
    refreshedAt: '2026-07-25T10:00:00.000Z',
    expiresAt: '2026-08-25T10:00:00.000Z',
  });
  assert.equal(mismatched.sources[0].status, 'cached');
  assert.match(mismatched.quarantines[0].reason, /snapshotHash/);
  assert.equal(mismatched.cache.sources[0].snapshotHash, 'sha256:good');
});

test('within-source and cross-source observation collisions never last-write-win', async () => {
  const duplicateWithin = syntheticSource('duplicate-within', (result) => ({
    ...result,
    observations: [result.observations[0], structuredClone(result.observations[0])],
  }));
  const within = await refreshRoutingEvidence({
    sources: [liveSource(duplicateWithin, {}, 'sha256:within')],
    currentCache: emptyCache(),
    expectedRevision: 0,
    refreshedAt: observedAt,
    expiresAt,
  });
  assert.equal(within.sources[0].status, 'quarantined');
  assert.match(within.quarantines[0].reason, /duplicate/);

  const first = syntheticSource('collision-a');
  const second = syntheticSource('collision-b', (result) => ({
    ...result,
    observations: [{ ...result.observations[0], id: 'collision-a:shared-observation' }],
  }));
  const across = await refreshRoutingEvidence({
    sources: [
      liveSource(first, {}, 'sha256:a'),
      liveSource(second, {}, 'sha256:b'),
    ],
    currentCache: emptyCache(),
    expectedRevision: 0,
    refreshedAt: observedAt,
    expiresAt,
  });
  assert.deepEqual(across.sources.map(({ status }) => status), ['live', 'quarantined']);
  assert.match(across.quarantines[0].reason, /duplicate/);
  assert.equal(across.cache.catalog.observations.length, 1);
  assert.equal(across.cache.catalog.observations[0].source.id, 'collision-a');

  const cachedFirst = await refreshRoutingEvidence({
    sources: [liveSource(first, {}, 'sha256:a')],
    currentCache: emptyCache(),
    expectedRevision: 0,
    refreshedAt: observedAt,
    expiresAt,
  });
  const againstCached = await refreshRoutingEvidence({
    sources: [liveSource(second, {}, 'sha256:b')],
    currentCache: cachedFirst.cache,
    expectedRevision: 1,
    refreshedAt: '2026-07-24T10:00:00.000Z',
    expiresAt: '2026-08-24T10:00:00.000Z',
  });
  assert.equal(againstCached.sources[0].status, 'quarantined');
  assert.match(againstCached.quarantines[0].reason, /duplicate/);
  assert.equal(againstCached.cache.catalog.observations[0].source.id, 'collision-a');
});

test('signals persist outside decisive observations and successful empty replaces source state', async () => {
  const source = syntheticSource('signals', (result) => ({
    ...result,
    signals: [{ kind: 'coverage', value: 0.73, estimated: true }],
  }));
  const first = await refreshRoutingEvidence({
    sources: [liveSource(source, {}, 'sha256:signals')],
    currentCache: emptyCache(),
    expectedRevision: 0,
    refreshedAt: observedAt,
    expiresAt,
  });
  assert.deepEqual(first.cache.sources[0].signals, [
    { kind: 'coverage', value: 0.73, estimated: true },
  ]);
  assert.equal(first.cache.catalog.observations.length, 1);
  assert.equal('signals' in first.cache.catalog, false);

  const failed = await refreshRoutingEvidence({
    sources: [{ adapter: source, load: async () => { throw new Error('offline'); } }],
    currentCache: first.cache,
    expectedRevision: 1,
    refreshedAt: '2026-07-24T10:00:00.000Z',
    expiresAt: '2026-08-24T10:00:00.000Z',
  });
  assert.deepEqual(failed.cache.sources[0].signals, first.cache.sources[0].signals);

  const empty = syntheticSource('signals', (result) => ({
    ...result,
    models: [],
    observations: [],
    signals: [],
  }));
  const replaced = await refreshRoutingEvidence({
    sources: [liveSource(empty, {}, 'sha256:empty')],
    currentCache: failed.cache,
    expectedRevision: 2,
    refreshedAt: '2026-07-25T10:00:00.000Z',
    expiresAt: '2026-08-25T10:00:00.000Z',
  });
  assert.deepEqual(replaced.cache.sources[0].models, []);
  assert.deepEqual(replaced.cache.sources[0].observations, []);
  assert.deepEqual(replaced.cache.sources[0].signals, []);
  assert.equal(replaced.cache.sources[0].snapshotHash, 'sha256:empty');
  assert.equal(replaced.cache.catalog.models.length, 0);
  assert.equal(replaced.cache.catalog.observations.length, 0);
});

test('refresh never changes or returns personal routing policy', async () => {
  const policy = Object.freeze({ revision: 'personal-r9', optimization: 'cost' });
  const before = structuredClone(policy);
  const result = await refreshRoutingEvidence({
    sources: [liveSource(deepSweSource, await fixture('deepswe'), 'sha256:deepswe')],
    currentCache: emptyCache(),
    expectedRevision: 0,
    refreshedAt: observedAt,
    expiresAt,
    policy,
  });

  assert.deepEqual(policy, before);
  assert.equal('policy' in result, false);
});
