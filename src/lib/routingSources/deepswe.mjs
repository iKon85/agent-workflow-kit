import {
  assertPublishedEffort,
  evidenceFreshness,
  evidenceIdentity,
  evidenceSourceClaim,
} from '../routingCatalog.mjs';

const SOURCE_ID = 'deepswe';
const OWNER = 'DataCurve';
const ARTIFACT_URL =
  'https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json';
const WORKLOAD = evidenceIdentity({ workload: 'repository-repair', axis: 'functional' });

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

function number(value, field) {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`);
  return value;
}

function context({ snapshotHash, observedAt, expiresAt }) {
  string(snapshotHash, 'snapshotHash');
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new TypeError('observedAt must be an ISO timestamp');
  }
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new TypeError('expiresAt must be an ISO timestamp after observedAt');
  }
  return { snapshotHash, observedAt, expiresAt };
}

function ingest({ payload, ...inputContext }) {
  // The caller's window bounds the refresh; the observation is dated by the
  // Kit-side freshness policy for this source, never by the owner artifact.
  const { snapshotHash, observedAt } = context(inputContext);
  object(payload, 'DeepSWE payload');
  const artifact = object(payload.artifact, 'DeepSWE artifact');
  if (artifact.owner !== OWNER || artifact.url !== ARTIFACT_URL) {
    throw new TypeError('DeepSWE source identity does not match the owner artifact');
  }
  const benchmark = string(artifact.benchmark, 'DeepSWE artifact benchmark');
  const benchmarkVersion = string(artifact.version, 'DeepSWE artifact version');
  const harness = object(artifact.harness, 'DeepSWE artifact harness');
  const harnessId = string(harness.id, 'DeepSWE artifact harness id');
  const harnessVersion = string(harness.version, 'DeepSWE artifact harness version');
  if (!Array.isArray(payload.rows)) throw new TypeError('DeepSWE rows must be an array');

  const models = new Map();
  const observations = [];
  const observationIds = new Set();
  payload.rows.forEach((row, index) => {
    object(row, `DeepSWE rows[${index}]`);
    const providerId = string(row.provider, `DeepSWE rows[${index}].provider`);
    const modelId = string(row.model, `DeepSWE rows[${index}].model`);
    const effort = assertPublishedEffort({
      sourceId: SOURCE_ID,
      effort: string(row.effort, `DeepSWE rows[${index}].effort`),
    });
    const id = `${SOURCE_ID}:${benchmarkVersion}:${providerId}:${modelId}:${effort}`;
    if (observationIds.has(id)) throw new TypeError(`duplicate DeepSWE observation: ${id}`);
    observationIds.add(id);
    models.set(`${providerId}:${modelId}`, { providerId, modelId });
    observations.push({
      id,
      providerId,
      modelId,
      effort,
      workload: WORKLOAD,
      harness: { id: harnessId, version: harnessVersion },
      score: number(row.score, `DeepSWE rows[${index}].score`),
      source: {
        id: SOURCE_ID,
        owner: OWNER,
        url: ARTIFACT_URL,
        benchmark,
        version: benchmarkVersion,
        snapshotHash,
      },
      uncertainty: {
        kind: 'confidence-interval-95-half-width',
        value: number(
          row.confidence95HalfWidth,
          `DeepSWE rows[${index}].confidence95HalfWidth`,
        ),
      },
      freshness: evidenceFreshness({ sourceId: SOURCE_ID, observedAt }),
      cost: {
        amount: number(row.averageCostUsd, `DeepSWE rows[${index}].averageCostUsd`),
        currency: 'USD',
        unit: 'attempt',
      },
    });
  });

  return {
    sourceId: SOURCE_ID,
    models: [...models.values()],
    observations,
  };
}

export const deepSweSource = Object.freeze({
  sourceId: SOURCE_ID,
  owner: OWNER,
  artifactUrl: ARTIFACT_URL,
  claim: evidenceSourceClaim(SOURCE_ID),
  ingest,
});
