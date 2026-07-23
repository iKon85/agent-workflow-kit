export const ACCESS_GRAPH_VERSION = 1;

export const ROUTE_AVAILABILITY = Object.freeze([
  'available',
  'unavailable',
  'unknown',
]);

export const ENFORCEMENT_METHODS = Object.freeze([
  'per-spawn',
  'named-agent',
  'session-default',
  'none',
]);

const PATH_FIELDS = new Set([
  'id',
  'surfaceId',
  'providerId',
  'modelId',
  'transportId',
  'availability',
  'enforcement',
  'capabilityEvidence',
]);

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

function oneOf(value, values, field) {
  if (!values.includes(value)) throw new TypeError(`${field} must be one of: ${values.join(', ')}`);
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

function validatePath(path, index) {
  const field = `paths[${index}]`;
  object(path, field);
  for (const key of Object.keys(path)) {
    if (!PATH_FIELDS.has(key)) throw new TypeError(`unknown access path field: ${key}`);
  }
  const enforcement = object(path.enforcement, `${field}.enforcement`);
  const evidence = object(path.capabilityEvidence, `${field}.capabilityEvidence`);
  const observedAt = timestamp(evidence.observedAt, `${field}.capabilityEvidence.observedAt`);
  const expiresAt = timestamp(evidence.expiresAt, `${field}.capabilityEvidence.expiresAt`);
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new TypeError(`${field}.capabilityEvidence.expiresAt must follow observedAt`);
  }
  return {
    id: string(path.id, `${field}.id`),
    surfaceId: string(path.surfaceId, `${field}.surfaceId`),
    providerId: string(path.providerId, `${field}.providerId`),
    modelId: string(path.modelId, `${field}.modelId`),
    transportId: string(path.transportId, `${field}.transportId`),
    availability: oneOf(path.availability, ROUTE_AVAILABILITY, `${field}.availability`),
    enforcement: {
      model: oneOf(enforcement.model, ENFORCEMENT_METHODS, `${field}.enforcement.model`),
      effort: oneOf(enforcement.effort, ENFORCEMENT_METHODS, `${field}.enforcement.effort`),
    },
    capabilityEvidence: {
      revision: string(evidence.revision, `${field}.capabilityEvidence.revision`),
      observedAt,
      expiresAt,
    },
  };
}

export function validateAccessGraph(input) {
  object(input, 'access graph');
  if (input.schemaVersion !== ACCESS_GRAPH_VERSION) {
    throw new TypeError(`access graph schemaVersion must be ${ACCESS_GRAPH_VERSION}`);
  }
  const revision = string(input.revision, 'access graph revision');
  if (!Array.isArray(input.paths)) throw new TypeError('access graph paths must be an array');
  const paths = input.paths.map(validatePath);
  const ids = new Set();
  for (const path of paths) {
    if (ids.has(path.id)) throw new TypeError(`duplicate access path: ${path.id}`);
    ids.add(path.id);
  }
  return deepFreeze({ schemaVersion: ACCESS_GRAPH_VERSION, revision, paths });
}
