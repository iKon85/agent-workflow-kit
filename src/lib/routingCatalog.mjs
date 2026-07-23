export const EVIDENCE_CATALOG_VERSION = 1;

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

function timestamp(value, field) {
  string(value, field);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be an ISO timestamp`);
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const identity = ({ providerId, modelId }) => `${providerId}:${modelId}`;

function validateModel(model, index) {
  object(model, `models[${index}]`);
  return {
    providerId: string(model.providerId, `models[${index}].providerId`),
    modelId: string(model.modelId, `models[${index}].modelId`),
  };
}

function validateObservation(entry, index, knownModels) {
  const field = `observations[${index}]`;
  object(entry, field);
  const observation = {
    id: string(entry.id, `${field}.id`),
    providerId: string(entry.providerId, `${field}.providerId`),
    modelId: string(entry.modelId, `${field}.modelId`),
    effort: string(entry.effort, `${field}.effort`),
    workload: string(entry.workload, `${field}.workload`),
    harness: clone(object(entry.harness, `${field}.harness`)),
    score: number(entry.score, `${field}.score`),
    source: clone(object(entry.source, `${field}.source`)),
    uncertainty: clone(object(entry.uncertainty, `${field}.uncertainty`)),
    freshness: clone(object(entry.freshness, `${field}.freshness`)),
    cost: clone(object(entry.cost, `${field}.cost`)),
  };
  string(observation.harness.id, `${field}.harness.id`);
  string(observation.harness.version, `${field}.harness.version`);
  string(observation.source.owner, `${field}.source.owner`);
  string(observation.source.url, `${field}.source.url`);
  string(observation.source.benchmark, `${field}.source.benchmark`);
  string(observation.source.version, `${field}.source.version`);
  string(observation.uncertainty.kind, `${field}.uncertainty.kind`);
  number(observation.uncertainty.value, `${field}.uncertainty.value`);
  const observedAt = timestamp(observation.freshness.observedAt, `${field}.freshness.observedAt`);
  const expiresAt = timestamp(observation.freshness.expiresAt, `${field}.freshness.expiresAt`);
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new TypeError(`${field}.freshness.expiresAt must follow observedAt`);
  }
  const amount = number(observation.cost.amount, `${field}.cost.amount`);
  if (amount < 0) throw new TypeError(`${field}.cost.amount must be non-negative`);
  string(observation.cost.currency, `${field}.cost.currency`);
  string(observation.cost.unit, `${field}.cost.unit`);
  if (!knownModels.has(identity(observation))) {
    throw new TypeError(`${field} references an unknown model`);
  }
  return observation;
}

export function validateEvidenceCatalog(input) {
  object(input, 'evidence catalog');
  if (input.schemaVersion !== EVIDENCE_CATALOG_VERSION) {
    throw new TypeError(`evidence catalog schemaVersion must be ${EVIDENCE_CATALOG_VERSION}`);
  }
  const revision = string(input.revision, 'evidence catalog revision');
  if (!Array.isArray(input.models)) throw new TypeError('evidence catalog models must be an array');
  if (!Array.isArray(input.observations)) {
    throw new TypeError('evidence catalog observations must be an array');
  }
  const models = input.models.map(validateModel);
  const modelIds = new Set();
  for (const model of models) {
    const key = identity(model);
    if (modelIds.has(key)) throw new TypeError(`duplicate evidence model: ${key}`);
    modelIds.add(key);
  }
  const observations = input.observations.map((entry, index) =>
    validateObservation(entry, index, modelIds));
  const observationIds = new Set();
  for (const entry of observations) {
    if (observationIds.has(entry.id)) {
      throw new TypeError(`duplicate evidence observation: ${entry.id}`);
    }
    observationIds.add(entry.id);
  }
  return deepFreeze({
    schemaVersion: EVIDENCE_CATALOG_VERSION,
    revision,
    models,
    observations,
  });
}
