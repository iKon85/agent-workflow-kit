import { validateEvidenceCatalog } from './routingCatalog.mjs';
import { validateAccessGraph } from './routingAccessGraph.mjs';
import { validateRoutingPolicy } from './routingPolicy.mjs';

export const ROUTING_EVIDENCE_CACHE_VERSION = 1;

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
  return Object.freeze({
    schemaVersion: ROUTING_EVIDENCE_CACHE_VERSION,
    revision: input.revision,
    refreshedAt,
    expiresAt,
    catalog: validateEvidenceCatalog(input.catalog),
  });
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
  }, { now: refreshedAt });
}

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
