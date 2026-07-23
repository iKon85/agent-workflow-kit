const SOURCE_ID = 'artificial-analysis-coding-agents';
const OWNER = 'Artificial Analysis';
const ARTIFACT_URL = 'https://artificialanalysis.ai/agents/coding-agents';

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
  object(payload, 'Artificial Analysis payload');
  const identity = object(payload.identity, 'Artificial Analysis identity');
  if (identity.publisher !== OWNER || identity.canonicalUrl !== ARTIFACT_URL) {
    throw new TypeError(
      'Artificial Analysis source identity does not match the owner artifact',
    );
  }
  const benchmark = string(identity.index, 'Artificial Analysis index');
  const benchmarkVersion = string(identity.release, 'Artificial Analysis release');
  const harnessId = string(identity.harnessName, 'Artificial Analysis harness name');
  const harnessVersion = string(
    identity.harnessRelease,
    'Artificial Analysis harness release',
  );
  if (!Array.isArray(payload.configurations)) {
    throw new TypeError('Artificial Analysis configurations must be an array');
  }

  const models = new Map();
  const observations = [];
  const observationIds = new Set();
  payload.configurations.forEach((row, index) => {
    object(row, `Artificial Analysis configurations[${index}]`);
    const providerId = string(
      row.providerId,
      `Artificial Analysis configurations[${index}].providerId`,
    );
    const modelId = string(
      row.modelId,
      `Artificial Analysis configurations[${index}].modelId`,
    );
    const effort = string(
      row.reasoningEffort,
      `Artificial Analysis configurations[${index}].effort`,
    );
    const id = `${SOURCE_ID}:${benchmarkVersion}:${providerId}:${modelId}:${effort}`;
    if (observationIds.has(id)) {
      throw new TypeError(`duplicate Artificial Analysis observation: ${id}`);
    }
    observationIds.add(id);
    models.set(`${providerId}:${modelId}`, { providerId, modelId });
    const uncertainty = object(
      row.uncertainty,
      `Artificial Analysis configurations[${index}].uncertainty`,
    );
    observations.push({
      id,
      providerId,
      modelId,
      effort,
      workload: 'development',
      harness: { id: harnessId, version: harnessVersion },
      score: number(
        row.indexScore,
        `Artificial Analysis configurations[${index}].indexScore`,
      ),
      source: {
        id: SOURCE_ID,
        owner: OWNER,
        url: ARTIFACT_URL,
        benchmark,
        version: benchmarkVersion,
        snapshotHash,
      },
      uncertainty: {
        kind: string(
          uncertainty.kind,
          `Artificial Analysis configurations[${index}].uncertainty.kind`,
        ),
        value: number(
          uncertainty.value,
          `Artificial Analysis configurations[${index}].uncertainty.value`,
        ),
      },
      freshness: { observedAt, expiresAt },
      cost: {
        amount: number(
          row.costPerTaskUsd,
          `Artificial Analysis configurations[${index}].costPerTaskUsd`,
        ),
        currency: 'USD',
        unit: 'task',
      },
    });
  });
  return {
    sourceId: SOURCE_ID,
    models: [...models.values()],
    observations,
  };
}

export const artificialAnalysisSource = Object.freeze({
  sourceId: SOURCE_ID,
  owner: OWNER,
  artifactUrl: ARTIFACT_URL,
  ingest,
});
