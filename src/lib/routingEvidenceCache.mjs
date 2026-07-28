import { validateEvidenceCatalog } from './routingCatalog.mjs';
import { validateAccessGraph } from './routingAccessGraph.mjs';
import { validateRoutingPolicy } from './routingPolicy.mjs';
import { deriveRoutingPolicy } from './routingProfilePolicy.mjs';

export const ROUTING_EVIDENCE_CACHE_VERSION = 1;
export const ROUTING_STORE_SNAPSHOT_VERSION = 1;

/** Every axis a store-backed snapshot compares, each named by what moved. */
export const ROUTING_STORE_SNAPSHOT_FIELDS = Object.freeze([
  'globalGeneration', 'projectGeneration', 'inventoryRevision', 'accessGraph', 'policy', 'catalog',
]);

const PROFILE_MUTATION = 'concurrent routing profile mutation';
const CATALOG_MUTATION = 'concurrent evidence catalog mutation';

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return value;
}

function string(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function validateRoutingEvidenceSourceSnapshot(input, index = 0) {
  const field = `sources[${index}]`;
  object(input, field);
  const sourceId = string(input.sourceId, `${field}.sourceId`);
  const owner = string(input.owner, `${field}.owner`);
  const artifactUrl = string(input.artifactUrl, `${field}.artifactUrl`);
  const snapshotHash = string(input.snapshotHash, `${field}.snapshotHash`);
  const observedAt = timestamp(input.observedAt, `${field}.observedAt`);
  const expiresAt = timestamp(input.expiresAt, `${field}.expiresAt`);
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new TypeError(`${field}.expiresAt must follow observedAt`);
  }
  if (!Array.isArray(input.models)) throw new TypeError(`${field}.models must be an array`);
  if (!Array.isArray(input.observations)) {
    throw new TypeError(`${field}.observations must be an array`);
  }
  const catalog = validateEvidenceCatalog({
    schemaVersion: 1,
    revision: `source:${sourceId}`,
    models: input.models,
    observations: input.observations,
  });
  for (const [observationIndex, observation] of catalog.observations.entries()) {
    const observationField = `${field}.observations[${observationIndex}].source`;
    if (observation.source.id !== sourceId) {
      throw new TypeError(`${observationField}.id must equal ${sourceId}`);
    }
    if (observation.source.snapshotHash !== snapshotHash) {
      throw new TypeError(`${observationField}.snapshotHash must equal loaded snapshotHash`);
    }
    if (observation.source.owner !== owner) {
      throw new TypeError(`${observationField}.owner must equal ${owner}`);
    }
    if (observation.source.url !== artifactUrl) {
      throw new TypeError(`${observationField}.url must equal ${artifactUrl}`);
    }
  }
  const rawSignals = input.signals ?? [];
  if (!Array.isArray(rawSignals)) throw new TypeError(`${field}.signals must be an array`);
  const signals = rawSignals.map((signal, signalIndex) => {
    object(signal, `${field}.signals[${signalIndex}]`);
    return structuredClone(signal);
  });
  return deepFreeze({
    sourceId,
    owner,
    artifactUrl,
    snapshotHash,
    observedAt,
    expiresAt,
    models: structuredClone(catalog.models),
    observations: structuredClone(catalog.observations),
    signals,
  });
}

function validateSourceSnapshots(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new TypeError('routing evidence cache sources must be an array');
  const sources = input.map(validateRoutingEvidenceSourceSnapshot);
  const sourceIds = new Set();
  const observationIds = new Set();
  for (const source of sources) {
    if (sourceIds.has(source.sourceId)) {
      throw new TypeError(`duplicate routing evidence source: ${source.sourceId}`);
    }
    sourceIds.add(source.sourceId);
    for (const observation of source.observations) {
      if (observationIds.has(observation.id)) {
        throw new TypeError(`duplicate evidence observation across sources: ${observation.id}`);
      }
      observationIds.add(observation.id);
    }
  }
  return sources;
}

export function buildEvidenceCatalogFromSources(sources, revision) {
  const validated = validateSourceSnapshots(sources);
  const modelMap = new Map();
  const observations = [];
  const observationIds = new Set();
  for (const source of validated) {
    for (const model of source.models) {
      modelMap.set(`${model.providerId}:${model.modelId}`, model);
    }
    for (const observation of source.observations) {
      if (observationIds.has(observation.id)) {
        throw new TypeError(`duplicate evidence observation across sources: ${observation.id}`);
      }
      observationIds.add(observation.id);
      observations.push(observation);
    }
  }
  return validateEvidenceCatalog({
    schemaVersion: 1,
    revision,
    models: [...modelMap.values()],
    observations,
  });
}

function validateCacheShape(input) {
  object(input, 'routing evidence cache');
  if (input.schemaVersion !== ROUTING_EVIDENCE_CACHE_VERSION) {
    throw new TypeError(
      `routing evidence cache schemaVersion must be ${ROUTING_EVIDENCE_CACHE_VERSION}`,
    );
  }
  if (!Number.isInteger(input.revision) || input.revision < 0) {
    throw new TypeError('routing evidence cache revision must be a non-negative integer');
  }
  const refreshedAt = timestamp(input.refreshedAt, 'routing evidence cache refreshedAt');
  const expiresAt = timestamp(input.expiresAt, 'routing evidence cache expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(refreshedAt)) {
    throw new TypeError('routing evidence cache expiresAt must follow refreshedAt');
  }
  return deepFreeze({
    schemaVersion: ROUTING_EVIDENCE_CACHE_VERSION,
    revision: input.revision,
    refreshedAt,
    expiresAt,
    catalog: validateEvidenceCatalog(input.catalog),
    sources: validateSourceSnapshots(input.sources),
  });
}

export function routingEvidenceSourcesFromCache(input) {
  return validateCacheShape(input).sources;
}

export function validateRoutingEvidenceCache(input, { now } = {}) {
  const cache = validateCacheShape(input);
  const checkedAt = Date.parse(now);
  if (!Number.isFinite(checkedAt)) throw new TypeError('now must be an ISO timestamp');
  if (Date.parse(cache.expiresAt) <= checkedAt) {
    throw new Error(`stale routing evidence cache: expired at ${cache.expiresAt}`);
  }
  return cache;
}

export function commitRoutingEvidenceCache({
  current,
  expectedRevision,
  nextCatalog,
  nextSources,
  refreshedAt,
  expiresAt,
}) {
  const cache = validateCacheShape(current);
  if (cache.revision !== expectedRevision) {
    throw new Error(
      `concurrent evidence cache mutation: expected revision ${expectedRevision}, `
      + `found ${cache.revision}`,
    );
  }
  return validateRoutingEvidenceCache({
    schemaVersion: ROUTING_EVIDENCE_CACHE_VERSION,
    revision: cache.revision + 1,
    refreshedAt,
    expiresAt,
    catalog: nextCatalog,
    sources: nextSources ?? cache.sources,
  }, { now: refreshedAt });
}

function snapshotReader(source, field) {
  if (typeof source[field] !== 'function') {
    throw new TypeError(`routing store snapshot ${field} must be a function`);
  }
  return source[field];
}

/**
 * The store-backed snapshot token: the revisions of the *persisted* routing
 * inputs, taken by re-reading them. The Routing policy is recomputed from the
 * generations and the inventory revision just read — a policy is derived and is
 * never read back from a store — so a revision a caller merely states cannot
 * authorize a dispatch, which comparing a resolver input with itself would allow.
 */
export async function captureRoutingStoreSnapshot(source) {
  object(source, 'routing store snapshot source');
  const [readProfile, readAccessGraph, readCatalog] = ['readProfile', 'readAccessGraph',
    'readCatalog'].map((field) => snapshotReader(source, field));
  const profile = await readProfile();
  if (!profile?.global || !profile.composed) {
    throw new Error('routing profile store carries no committed authorization');
  }
  const projectGeneration = profile.project?.generation ?? null;
  const policy = deriveRoutingPolicy({
    composed: profile.composed,
    globalGeneration: profile.global.generation,
    projectGeneration,
    ...(source.policyOptions ?? {}),
  });
  const accessGraph = await readAccessGraph();
  const catalog = validateEvidenceCatalog(await readCatalog());
  return Object.freeze({
    schemaVersion: ROUTING_STORE_SNAPSHOT_VERSION,
    globalGeneration: profile.global.generation,
    projectGeneration,
    inventoryRevision: profile.composed.rosterState?.inventoryRevision
      ?? profile.composed.inventoryRevision ?? null,
    accessGraph: accessGraph?.revision ?? null,
    policy: policy.revision,
    catalog: catalog.revision,
  });
}

/**
 * Compare the named axes of two snapshot tokens. A moved axis names itself and
 * fails the dispatch; the receipt reduces the message to a constant reason, so
 * the compared values never leave this call.
 */
export function assertRoutingSnapshotMatches(expected, actual, fields) {
  for (const token of [expected, actual]) object(token, 'routing store snapshot');
  for (const field of fields) {
    if (expected[field] === actual[field]) continue;
    throw new Error(`${field === 'catalog' ? CATALOG_MUTATION : PROFILE_MUTATION}: `
      + `${field} changed from ${expected[field]} to ${actual[field]}`);
  }
  return true;
}

/** The full-axis comparison a held lease runs before it releases the spawn. */
export function assertRoutingStoreSnapshotUnchanged(before, after) {
  return assertRoutingSnapshotMatches(before, after, ROUTING_STORE_SNAPSHOT_FIELDS);
}

/**
 * The in-process check over one caller's own resolver input. It only sees a
 * mutation this process made to that object, so it is the degenerate case for a
 * dispatch without a store-backed lease — never the authority over the store.
 */
export function captureRoutingProfileSnapshot({ accessGraph, policy }) {
  const access = validateAccessGraph(accessGraph);
  const routingPolicy = validateRoutingPolicy(policy);
  return Object.freeze({
    accessGraph: access.revision,
    policy: routingPolicy.revision,
  });
}

export function assertRoutingProfileUnchanged(snapshot, { accessGraph, policy }) {
  object(snapshot, 'routing profile snapshot');
  const current = captureRoutingProfileSnapshot({ accessGraph, policy });
  for (const field of ['accessGraph', 'policy']) {
    if (snapshot[field] !== current[field]) {
      throw new Error(
        `concurrent routing profile mutation: ${field} changed from `
        + `${snapshot[field]} to ${current[field]}`,
      );
    }
  }
  return true;
}
