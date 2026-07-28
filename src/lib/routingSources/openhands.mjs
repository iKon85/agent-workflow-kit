import {
  assertCostUnit,
  assertPublishedEffort,
  evidenceFreshness,
  evidenceIdentity,
  evidenceSourceClaim,
} from '../routingCatalog.mjs';

const SOURCE_ID = 'openhands-evaluation';
const OWNER = 'All Hands AI';
const ARTIFACT_URL = 'https://github.com/All-Hands-AI/OpenHands/tree/main/evaluation';
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

function ingest({ payload, snapshotHash, observedAt, expiresAt }) {
  string(snapshotHash, 'snapshotHash');
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new TypeError('observedAt must be an ISO timestamp');
  }
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new TypeError('expiresAt must be an ISO timestamp after observedAt');
  }
  object(payload, 'OpenHands payload');
  const provenance = object(payload.provenance, 'OpenHands provenance');
  if (provenance.organization !== OWNER || provenance.artifactUrl !== ARTIFACT_URL) {
    throw new TypeError('OpenHands source identity does not match the owner artifact');
  }
  const benchmark = string(provenance.benchmarkName, 'OpenHands benchmark name');
  const benchmarkVersion = string(
    provenance.benchmarkVersion,
    'OpenHands benchmark version',
  );
  const harnessId = string(provenance.harnessId, 'OpenHands harness id');
  const harnessVersion = string(provenance.harnessVersion, 'OpenHands harness version');
  if (!Array.isArray(payload.results)) throw new TypeError('OpenHands results must be an array');

  const models = new Map();
  const observations = [];
  const observationIds = new Set();
  payload.results.forEach((row, index) => {
    object(row, `OpenHands results[${index}]`);
    const providerId = string(row.provider, `OpenHands results[${index}].provider`);
    const modelId = string(row.model, `OpenHands results[${index}].model`);
    const effort = assertPublishedEffort({
      sourceId: SOURCE_ID,
      effort: string(row.effort, `OpenHands results[${index}].effort`),
    });
    const id = `${SOURCE_ID}:${benchmarkVersion}:${providerId}:${modelId}:${effort}`;
    if (observationIds.has(id)) throw new TypeError(`duplicate OpenHands observation: ${id}`);
    observationIds.add(id);
    models.set(`${providerId}:${modelId}`, { providerId, modelId });
    const meanCost = object(row.meanCost, `OpenHands results[${index}].meanCost`);
    observations.push({
      id,
      providerId,
      modelId,
      effort,
      workload: WORKLOAD,
      harness: { id: harnessId, version: harnessVersion },
      score: number(row.resolvedRate, `OpenHands results[${index}].resolvedRate`),
      source: {
        id: SOURCE_ID,
        owner: OWNER,
        url: ARTIFACT_URL,
        benchmark,
        version: benchmarkVersion,
        snapshotHash,
      },
      uncertainty: {
        kind: 'standard-error',
        value: number(row.standardError, `OpenHands results[${index}].standardError`),
      },
      freshness: evidenceFreshness({ sourceId: SOURCE_ID, observedAt }),
      cost: {
        amount: number(meanCost.amount, `OpenHands results[${index}].meanCost.amount`),
        currency: string(
          meanCost.currency,
          `OpenHands results[${index}].meanCost.currency`,
        ),
        unit: assertCostUnit(meanCost.unit, `OpenHands results[${index}].meanCost.unit`),
      },
    });
  });
  return {
    sourceId: SOURCE_ID,
    models: [...models.values()],
    observations,
  };
}

export const openHandsSource = Object.freeze({
  sourceId: SOURCE_ID,
  owner: OWNER,
  artifactUrl: ARTIFACT_URL,
  claim: evidenceSourceClaim(SOURCE_ID),
  ingest,
});
