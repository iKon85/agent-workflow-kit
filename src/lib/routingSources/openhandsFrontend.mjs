import { frontendEvidenceWorkload } from '../frontendWorkloads.mjs';
import {
  assertCostUnit,
  assertPublishedEffort,
  evidenceFreshness,
  evidenceSourceClaim,
} from '../routingCatalog.mjs';

const OWNER_URL = 'https://www.openhands.dev/blog/openhands-index';
const SOURCE_ID = 'openhands-frontend';
const BENCHMARK_ID = 'swe-bench-multimodal';

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

function finite(value, field) {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`);
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

function ingest({ payload, snapshotHash, observedAt, expiresAt }) {
  object(payload, 'OpenHands frontend payload');
  string(snapshotHash, 'snapshotHash');
  timestamp(observedAt, 'observedAt');
  timestamp(expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new TypeError('expiresAt must follow observedAt');
  }
  if (payload.schemaVersion !== 1) throw new TypeError('OpenHands schemaVersion must be 1');
  string(payload.exportId, 'OpenHands exportId');
  object(payload.benchmark, 'OpenHands benchmark');
  if (payload.benchmark.id !== BENCHMARK_ID) {
    throw new TypeError(`OpenHands benchmark identity must be ${BENCHMARK_ID}`);
  }
  if (payload.benchmark.url !== OWNER_URL) {
    throw new TypeError(`OpenHands owner URL must be ${OWNER_URL}`);
  }
  string(payload.benchmark.owner, 'OpenHands benchmark owner');
  string(payload.benchmark.version, 'OpenHands benchmark version');
  object(payload.harness, 'OpenHands harness');
  string(payload.harness.id, 'OpenHands harness id');
  string(payload.harness.version, 'OpenHands harness version');
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    throw new TypeError('OpenHands rows must be a non-empty array');
  }

  const models = [];
  const observations = [];
  const modelIds = new Set();
  const observationIds = new Set();
  for (const [index, row] of payload.rows.entries()) {
    object(row, `OpenHands rows[${index}]`);
    const providerId = string(row.providerId, `OpenHands rows[${index}].providerId`);
    const modelId = string(row.modelId, `OpenHands rows[${index}].modelId`);
    const effort = assertPublishedEffort({
      sourceId: SOURCE_ID,
      effort: string(row.effort, `OpenHands rows[${index}].effort`),
    });
    const modelIdentity = `${providerId}:${modelId}`;
    if (!modelIds.has(modelIdentity)) {
      models.push({ providerId, modelId });
      modelIds.add(modelIdentity);
    }
    const id = `${SOURCE_ID}:${payload.benchmark.version}:${modelIdentity}:${effort}`;
    if (observationIds.has(id)) {
      throw new TypeError(`duplicate observation identity: ${id}`);
    }
    observationIds.add(id);
    if (!['preliminary', 'established'].includes(row.status)) {
      throw new TypeError(`OpenHands rows[${index}].status is unsupported`);
    }
    object(row.cost, `OpenHands rows[${index}].cost`);
    observations.push({
      id,
      providerId,
      modelId,
      effort,
      workload: frontendEvidenceWorkload({
        workload: 'frontend-repository-repair',
        axis: 'functional',
      }),
      harness: {
        id: payload.harness.id,
        version: payload.harness.version,
      },
      score: finite(row.score, `OpenHands rows[${index}].score`),
      source: {
        id: SOURCE_ID,
        owner: payload.benchmark.owner,
        url: payload.benchmark.url,
        benchmark: BENCHMARK_ID,
        version: payload.benchmark.version,
        snapshotHash,
      },
      uncertainty: {
        kind: 'confidence-interval',
        value: finite(
          row.confidenceInterval,
          `OpenHands rows[${index}].confidenceInterval`,
        ),
        status: row.status,
        sampleSize: finite(row.sampleSize, `OpenHands rows[${index}].sampleSize`),
      },
      freshness: evidenceFreshness({ sourceId: SOURCE_ID, observedAt }),
      cost: {
        amount: finite(row.cost.amount, `OpenHands rows[${index}].cost.amount`),
        currency: string(row.cost.currency, `OpenHands rows[${index}].cost.currency`),
        unit: assertCostUnit(row.cost.unit, `OpenHands rows[${index}].cost.unit`),
      },
    });
  }
  return deepFreeze({ sourceId: SOURCE_ID, models, observations });
}

export const openHandsFrontendSource = Object.freeze({
  sourceId: SOURCE_ID,
  owner: 'OpenHands',
  artifactUrl: OWNER_URL,
  claim: evidenceSourceClaim(SOURCE_ID),
  ingest,
});
