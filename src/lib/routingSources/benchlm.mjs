import { evidenceFreshness, evidenceSourceClaim } from '../routingCatalog.mjs';

const SOURCE_ID = 'benchlm';
const ARTIFACT_URL = 'https://benchlm.ai/data';
const OWNER_URLS = Object.freeze({
  'code-arena-webdev': 'https://arena.ai/leaderboard/code/webdev',
  design2code: 'https://github.com/NoviScl/Design2Code',
  'swe-bench-multimodal': 'https://www.swebench.com/multimodal',
  vision2web: 'https://vision2web-bench.github.io/',
});

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function string(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function timestamp(value, field) {
  string(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validateUnique(items, identity, label) {
  const identities = new Set();
  for (const item of items) {
    const id = identity(item);
    if (identities.has(id)) throw new TypeError(`duplicate ${label} identity: ${id}`);
    identities.add(id);
  }
}

function ingest({ payload, snapshotHash, observedAt, expiresAt }) {
  object(payload, 'BenchLM payload');
  string(snapshotHash, 'snapshotHash');
  timestamp(observedAt, 'observedAt');
  timestamp(expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new TypeError('expiresAt must follow observedAt');
  }
  if (payload.schemaVersion !== 1) throw new TypeError('BenchLM schemaVersion must be 1');
  const generatedAt = timestamp(payload.generatedAt, 'BenchLM generatedAt');
  const sourceLastUpdated = timestamp(
    payload.sourceLastUpdated,
    'BenchLM sourceLastUpdated',
  );
  if (Date.parse(sourceLastUpdated) > Date.parse(generatedAt)) {
    throw new TypeError('BenchLM sourceLastUpdated cannot follow generatedAt');
  }
  if (!Array.isArray(payload.models)) throw new TypeError('BenchLM models must be an array');
  if (!Array.isArray(payload.benchmarks)) {
    throw new TypeError('BenchLM benchmarks must be an array');
  }
  if (!Array.isArray(payload.updates)) throw new TypeError('BenchLM updates must be an array');

  validateUnique(
    payload.models,
    (model) => `${string(model.providerId, 'BenchLM model providerId')}:`
      + string(model.modelId, 'BenchLM model modelId'),
    'model',
  );
  validateUnique(
    payload.benchmarks,
    (benchmark) => string(benchmark.id, 'BenchLM benchmark id'),
    'benchmark',
  );

  for (const benchmark of payload.benchmarks) {
    object(benchmark, 'BenchLM benchmark');
    const id = string(benchmark.id, 'BenchLM benchmark id');
    const expectedUrl = OWNER_URLS[id];
    if (expectedUrl && benchmark.ownerUrl !== expectedUrl) {
      throw new TypeError(`BenchLM owner URL for ${id} must be ${expectedUrl}`);
    }
    string(benchmark.ownerUrl, `BenchLM benchmark ${id} ownerUrl`);
    string(benchmark.status, `BenchLM benchmark ${id} status`);
  }

  const models = payload.models.map((model) => ({
    providerId: string(model.providerId, 'BenchLM model providerId'),
    modelId: string(model.modelId, 'BenchLM model modelId'),
  }));
  const signals = [];
  for (const model of payload.models) {
    object(model, 'BenchLM model');
    string(model.family, 'BenchLM model family');
    string(model.releasedAt, 'BenchLM model releasedAt');
    object(model.pricing, 'BenchLM model pricing');
    object(model.aggregates, 'BenchLM model aggregates');
    signals.push({
      kind: 'pricing-changed',
      identity: `${model.providerId}:${model.modelId}`,
      pricing: structuredClone(model.pricing),
      observedAt: sourceLastUpdated,
    });
    if (Object.keys(model.aggregates).length > 0) {
      signals.push({
        kind: 'evidence-gap',
        identity: `${model.providerId}:${model.modelId}`,
        reason: 'aggregate-requires-owner-observation',
        ownerCandidates: payload.benchmarks.map(({ id, ownerUrl }) => ({ id, ownerUrl })),
      });
    }
  }
  for (const update of payload.updates) {
    object(update, 'BenchLM update');
    signals.push({
      kind: string(update.kind, 'BenchLM update kind'),
      identity: string(update.identity, 'BenchLM update identity'),
    });
  }
  if (payload.models.length > 0 || payload.benchmarks.length > 0 || payload.updates.length > 0) {
    signals.push({
      kind: 'freshness',
      generatedAt,
      sourceLastUpdated,
      snapshotHash,
      // The owner publishes no cadence, so the Kit dates its own expiry.
      ...evidenceFreshness({ sourceId: SOURCE_ID, observedAt }),
    });
    signals.push({
      kind: 'corroboration-candidate',
      benchmarkIds: payload.benchmarks.map(({ id }) => id),
    });
  }

  return deepFreeze({
    sourceId: SOURCE_ID,
    models,
    observations: [],
    signals,
  });
}

export const benchLmSource = Object.freeze({
  sourceId: SOURCE_ID,
  owner: 'BenchLM',
  artifactUrl: ARTIFACT_URL,
  claim: evidenceSourceClaim(SOURCE_ID),
  ingest,
});
