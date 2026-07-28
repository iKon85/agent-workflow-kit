import { frontendEvidenceWorkload } from '../frontendWorkloads.mjs';
import {
  assertCostUnit,
  assertPublishedEffort,
  evidenceFreshness,
  evidenceSourceClaim,
} from '../routingCatalog.mjs';

const OWNER_URL = 'https://arena.ai/leaderboard/code/webdev';
const SOURCE_ID = 'code-arena-webdev';

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

function validateContext({ snapshotHash, observedAt, expiresAt }) {
  string(snapshotHash, 'snapshotHash');
  timestamp(observedAt, 'observedAt');
  timestamp(expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new TypeError('expiresAt must follow observedAt');
  }
}

function hasOverlappingIntervals(observations) {
  return observations.some((left, index) =>
    observations.slice(index + 1).some((right) =>
      left.score - left.uncertainty.value <= right.score + right.uncertainty.value
      && right.score - right.uncertainty.value <= left.score + left.uncertainty.value));
}

function ingest({ payload, snapshotHash, observedAt, expiresAt }) {
  object(payload, 'Code Arena payload');
  validateContext({ snapshotHash, observedAt, expiresAt });
  if (payload.schemaVersion !== 1) throw new TypeError('Code Arena schemaVersion must be 1');
  string(payload.exportId, 'Code Arena exportId');
  object(payload.benchmark, 'Code Arena benchmark');
  if (payload.benchmark.id !== SOURCE_ID) {
    throw new TypeError(`Code Arena benchmark identity must be ${SOURCE_ID}`);
  }
  if (payload.benchmark.url !== OWNER_URL) {
    throw new TypeError(`Code Arena owner URL must be ${OWNER_URL}`);
  }
  string(payload.benchmark.owner, 'Code Arena benchmark owner');
  string(payload.benchmark.version, 'Code Arena benchmark version');
  object(payload.harness, 'Code Arena harness');
  string(payload.harness.id, 'Code Arena harness id');
  string(payload.harness.version, 'Code Arena harness version');
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    throw new TypeError('Code Arena rows must be a non-empty array');
  }

  const models = [];
  const observations = [];
  const modelIds = new Set();
  const observationIds = new Set();
  for (const [index, row] of payload.rows.entries()) {
    object(row, `Code Arena rows[${index}]`);
    const providerId = string(row.providerId, `Code Arena rows[${index}].providerId`);
    const modelId = string(row.modelId, `Code Arena rows[${index}].modelId`);
    const effort = assertPublishedEffort({
      sourceId: SOURCE_ID,
      effort: string(row.effort, `Code Arena rows[${index}].effort`),
    });
    const domain = string(row.domain, `Code Arena rows[${index}].domain`);
    const score = finite(row.score, `Code Arena rows[${index}].score`);
    const interval = finite(
      row.confidenceInterval,
      `Code Arena rows[${index}].confidenceInterval`,
    );
    if (interval < 0) throw new TypeError('Code Arena confidenceInterval must be non-negative');
    if (!['preliminary', 'established'].includes(row.status)) {
      throw new TypeError(`Code Arena rows[${index}].status is unsupported`);
    }
    const sampleSize = finite(row.sampleSize, `Code Arena rows[${index}].sampleSize`);
    const modelIdentity = `${providerId}:${modelId}`;
    if (!modelIds.has(modelIdentity)) {
      models.push({ providerId, modelId });
      modelIds.add(modelIdentity);
    }
    const id = `${SOURCE_ID}:${payload.benchmark.version}:${domain}:${modelIdentity}:${effort}`;
    if (observationIds.has(id)) {
      throw new TypeError(`duplicate observation identity: ${id}`);
    }
    observationIds.add(id);
    object(row.cost, `Code Arena rows[${index}].cost`);
    observations.push({
      id,
      providerId,
      modelId,
      effort,
      workload: frontendEvidenceWorkload({
        workload: 'frontend-greenfield',
        frontendDomain: domain,
        axis: 'visual-preference',
      }),
      harness: {
        id: payload.harness.id,
        version: payload.harness.version,
      },
      score,
      source: {
        id: SOURCE_ID,
        owner: payload.benchmark.owner,
        url: payload.benchmark.url,
        benchmark: SOURCE_ID,
        version: payload.benchmark.version,
        snapshotHash,
      },
      uncertainty: {
        kind: 'confidence-interval',
        value: interval,
        status: row.status,
        sampleSize,
      },
      freshness: evidenceFreshness({ sourceId: SOURCE_ID, observedAt }),
      cost: {
        amount: finite(row.cost.amount, `Code Arena rows[${index}].cost.amount`),
        currency: string(row.cost.currency, `Code Arena rows[${index}].cost.currency`),
        unit: assertCostUnit(row.cost.unit, `Code Arena rows[${index}].cost.unit`),
      },
    });
  }

  return deepFreeze({
    sourceId: SOURCE_ID,
    models,
    observations,
    diagnostics: {
      overlappingUncertainty: hasOverlappingIntervals(observations),
      preliminaryObservationIds: observations
        .filter(({ uncertainty }) => uncertainty.status === 'preliminary')
        .map(({ id }) => id),
    },
  });
}

export const codeArenaSource = Object.freeze({
  sourceId: SOURCE_ID,
  owner: 'Arena',
  artifactUrl: OWNER_URL,
  claim: evidenceSourceClaim(SOURCE_ID),
  ingest,
});
