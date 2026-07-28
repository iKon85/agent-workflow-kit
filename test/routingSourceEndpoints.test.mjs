import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { loadRoutingInventory } from '../src/lib/routingInventory.mjs';
import { createModelIdentityResolver } from '../src/lib/routingModelIdentity.mjs';
import { deepSweSource } from '../src/lib/routingSources/deepswe.mjs';
import { artificialAnalysisSource } from '../src/lib/routingSources/artificialAnalysis.mjs';
import { benchLmSource } from '../src/lib/routingSources/benchlm.mjs';
import { codeArenaSource } from '../src/lib/routingSources/codeArena.mjs';
import { openHandsSource } from '../src/lib/routingSources/openhands.mjs';
import { openHandsFrontendSource } from '../src/lib/routingSources/openhandsFrontend.mjs';
import {
  ENDPOINT_ARTIFACT,
  ENDPOINT_DOCUMENTED_API,
  ENDPOINT_NONE,
  ROUTING_SOURCE_ENDPOINTS,
  createRoutingSourceLoad,
  routingSourceEndpoint,
} from '../src/lib/routingSources/endpoints.mjs';

const observedAt = '2026-07-28T10:00:00.000Z';
const expiresAt = '2026-08-27T10:00:00.000Z';

const liveDeepSwe = async () => JSON.parse(await readFile(
  new URL('./fixtures/routing/deepswe-live-2026-07-28.json', import.meta.url),
  'utf8',
));

async function resolver() {
  return createModelIdentityResolver(await loadRoutingInventory());
}

test('every shipped source declares an endpoint exactly once', () => {
  const shipped = [
    deepSweSource,
    artificialAnalysisSource,
    benchLmSource,
    codeArenaSource,
    openHandsSource,
    openHandsFrontendSource,
  ].map(({ sourceId }) => sourceId).sort();
  const declared = ROUTING_SOURCE_ENDPOINTS.map(({ sourceId }) => sourceId).sort();
  assert.deepEqual(declared, shipped);
  assert.equal(new Set(declared).size, declared.length);
  for (const entry of ROUTING_SOURCE_ENDPOINTS) {
    assert.ok(entry.evidence, `${entry.sourceId} must cite where its declaration was checked`);
    if (entry.kind === ENDPOINT_ARTIFACT) {
      assert.ok(entry.documents.length > 0);
      assert.equal(entry.unavailableReason, null);
      assert.equal(typeof entry.normalize, 'function');
    } else {
      assert.equal(entry.documents.length, 0);
      assert.ok(entry.unavailableReason, `${entry.sourceId} must name why it cannot be fetched`);
    }
  }
});

test('an unknown source id is refused rather than answered with a blank endpoint', () => {
  assert.throws(() => routingSourceEndpoint('terminal-bench'), /unknown routing evidence source/);
});

test('the recorded live DeepSWE artifact normalizes into a payload the parser accepts', async () => {
  const entry = routingSourceEndpoint('deepswe');
  const { payload, unresolved, skipped } = entry.normalize({
    documents: { leaderboard: await liveDeepSwe() },
    resolver: await resolver(),
  });

  assert.equal(payload.artifact.owner, deepSweSource.owner);
  assert.equal(payload.artifact.url, deepSweSource.artifactUrl);
  assert.equal(payload.artifact.version, 'v1.1');
  assert.equal(payload.artifact.harness.id, 'mini-swe-agent');
  assert.equal(payload.artifact.generatedAt, '2026-07-25T03:13:49.273952+00:00');

  const ingested = deepSweSource.ingest({
    payload,
    snapshotHash: 'sha256-live-2026-07-28',
    observedAt,
    expiresAt,
  });
  assert.equal(ingested.sourceId, 'deepswe');
  assert.equal(ingested.observations.length, 35);
  const opus = ingested.observations.find((row) => row.modelId === 'opus' && row.effort === 'max');
  assert.equal(opus.providerId, 'anthropic');
  assert.equal(opus.score, 0.7364864864864865);
  assert.equal(opus.uncertainty.value, 0.03872310426371729);
  assert.equal(opus.cost.amount, 11.837583271396396);
  assert.deepEqual(
    [...new Set(ingested.models.map(({ modelId }) => modelId))].sort(),
    ['fable', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'opus', 'sonnet'],
  );
  assert.deepEqual([...new Set(skipped.map(({ publishedId }) => publishedId))], ['kimi-k2-7-code']);
  assert.equal(unresolved.length, 14);
});

test('a row without a published effort is filtered instead of quarantining the source', async () => {
  const entry = routingSourceEndpoint('deepswe');
  const document = await liveDeepSwe();
  const { payload, skipped } = entry.normalize({
    documents: { leaderboard: document },
    resolver: await resolver(),
  });
  assert.equal(document.rows.filter((row) => row.reasoning_effort === null).length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'no-published-effort');
  assert.equal(payload.rows.some((row) => row.effort == null), false);
  assert.doesNotThrow(() => deepSweSource.ingest({
    payload,
    snapshotHash: 'sha256-live-2026-07-28',
    observedAt,
    expiresAt,
  }));
});

test('a published model outside the inventory is reported, never silently dropped', async () => {
  const entry = routingSourceEndpoint('deepswe');
  const { unresolved } = entry.normalize({
    documents: { leaderboard: await liveDeepSwe() },
    resolver: await resolver(),
  });
  assert.deepEqual(
    [...new Set(unresolved.map(({ publishedId }) => publishedId))].sort(),
    [
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'gemini-3-1-pro-preview',
      'gemini-3-5-flash',
      'gemini-3-6-flash',
      'glm-5-2',
      'grok-4-5',
      'kimi-k3',
      'muse-spark-1-1',
    ],
  );
  for (const record of unresolved) assert.equal(record.resolved, false);
});

test('rows naming several harnesses are refused rather than folded into one artifact', async () => {
  const entry = routingSourceEndpoint('deepswe');
  const document = await liveDeepSwe();
  document.rows[0].harness = 'another-harness';
  await assert.rejects(
    async () => entry.normalize({ documents: { leaderboard: document }, resolver: await resolver() }),
    /several harnesses/,
  );
});

test('the Artificial Analysis normalizer emits the collapsed effort the claim demands', async () => {
  const entry = routingSourceEndpoint('artificial-analysis-coding-agents');
  const { payload, unresolved } = entry.normalize({
    documents: {
      index: {
        index: 'Coding Agent Index',
        release: 'v1.3',
        harness_name: 'Coding Agent Harness',
        harness_release: '2026-07',
        rows: [
          {
            model: 'gpt-5-6-sol',
            index_score: 0.71,
            confidence_interval_half_width: 0.02,
            artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 5.5 } },
          },
          {
            model: 'grok-4-5',
            index_score: 0.5,
            confidence_interval_half_width: 0.03,
            artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: 1.5 } },
          },
        ],
      },
    },
    resolver: await resolver(),
  });
  assert.deepEqual(payload.configurations.map(({ reasoningEffort }) => reasoningEffort), ['unknown']);
  assert.equal(payload.configurations[0].modelId, 'gpt-5.6-sol');
  assert.equal(payload.configurations[0].costPerTaskUsd, 5.5);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].publishedId, 'grok-4-5');
  const ingested = artificialAnalysisSource.ingest({
    payload,
    snapshotHash: 'sha256-aa',
    observedAt,
    expiresAt,
  });
  assert.equal(ingested.observations[0].effort, 'unknown');
});

test('the BenchLM normalizer merges the three documented exports', async () => {
  const entry = routingSourceEndpoint('benchlm');
  assert.deepEqual(entry.documents.map(({ key }) => key), ['models', 'benchmarks', 'updates']);
  const envelope = { schemaVersion: 1, generatedAt: '2026-07-28T00:00:00.000Z', sourceLastUpdated: '2026-07-27T00:00:00.000Z' };
  const { payload } = entry.normalize({
    documents: {
      models: {
        ...envelope,
        models: [{
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          family: 'gpt-5.6',
          releasedAt: '2026-06-01',
          pricing: { inputPerMillionUsd: 1 },
          aggregates: {},
        }],
      },
      benchmarks: {
        ...envelope,
        benchmarks: [{ id: 'design2code', ownerUrl: 'https://github.com/NoviScl/Design2Code', status: 'active' }],
      },
      updates: { ...envelope, updates: [{ kind: 'pricing-changed', identity: 'openai:gpt-5.6-sol' }] },
    },
  });
  const ingested = benchLmSource.ingest({
    payload,
    snapshotHash: 'sha256-benchlm',
    observedAt,
    expiresAt,
  });
  assert.deepEqual(ingested.observations, []);
  assert.ok(ingested.signals.length > 0);
});

test('exports disagreeing on schema version are refused rather than merged', () => {
  const entry = routingSourceEndpoint('benchlm');
  const envelope = { schemaVersion: 1, generatedAt: '2026-07-28T00:00:00.000Z', sourceLastUpdated: '2026-07-27T00:00:00.000Z' };
  assert.throws(() => entry.normalize({
    documents: {
      models: { ...envelope, models: [] },
      benchmarks: { ...envelope, schemaVersion: 2, benchmarks: [] },
      updates: { ...envelope, updates: [] },
    },
  }), /schemaVersion/);
});

test('a source with no machine-readable artifact loads into a named quarantine reason', async () => {
  const withoutArtifact = ROUTING_SOURCE_ENDPOINTS
    .filter(({ kind }) => kind === ENDPOINT_NONE)
    .map(({ sourceId }) => sourceId);
  assert.deepEqual(
    withoutArtifact.sort(),
    ['code-arena-webdev', 'openhands-evaluation', 'openhands-frontend'],
  );
  for (const sourceId of withoutArtifact) {
    const load = createRoutingSourceLoad({
      sourceId,
      resolver: await resolver(),
      fetchJson: async () => assert.fail(`${sourceId} must never reach the network`),
    });
    await assert.rejects(load, (error) => {
      assert.match(error.message, new RegExp(`^routing source ${sourceId} has no fetchable artifact:`));
      assert.match(error.message, /\S/);
      return true;
    });
  }
});

test('a credentialed API is declared, not fetched blind', async () => {
  const entry = routingSourceEndpoint('artificial-analysis-coding-agents');
  assert.equal(entry.kind, ENDPOINT_DOCUMENTED_API);
  assert.equal(entry.reference, 'https://artificialanalysis.ai/data-api/docs');
  const load = createRoutingSourceLoad({
    sourceId: entry.sourceId,
    resolver: await resolver(),
    fetchJson: async () => assert.fail('a documented API must not be fetched without its endpoint'),
  });
  await assert.rejects(load, /has no fetchable artifact/);
});

test('a fetchable source loads through the injected fetch, joins ids and hashes the artifact', async () => {
  const requested = [];
  const load = createRoutingSourceLoad({
    sourceId: 'deepswe',
    resolver: await resolver(),
    fetchJson: async ({ url }) => {
      requested.push(url);
      return { payload: await liveDeepSwe(), snapshotHash: 'sha256-live', bytes: 62289 };
    },
  });
  const loaded = await load();
  assert.deepEqual(requested, ['https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json']);
  assert.equal(loaded.snapshotHash, 'leaderboard=sha256-live');
  assert.equal(loaded.unresolved.length, 14);
  assert.equal(loaded.skipped.length, 1);
  const ingested = deepSweSource.ingest({
    payload: loaded.payload,
    snapshotHash: loaded.snapshotHash,
    observedAt,
    expiresAt,
  });
  assert.equal(ingested.observations.length, 35);
});
