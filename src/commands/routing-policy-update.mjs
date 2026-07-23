import {
  buildEvidenceCatalogFromSources,
  commitRoutingEvidenceCache,
  routingEvidenceSourcesFromCache,
  validateRoutingEvidenceSourceSnapshot,
} from '../lib/routingEvidenceCache.mjs';

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function observationDiff(previous, next) {
  const before = new Map(previous.map((entry) => [entry.id, entry]));
  const after = new Map(next.map((entry) => [entry.id, entry]));
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...after.keys()].filter(
    (id) => before.has(id)
      && JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)),
  ).sort();
  return { added, changed, removed };
}

function validateSource(source, index) {
  if (!source || typeof source !== 'object') {
    throw new TypeError(`sources[${index}] must be an object`);
  }
  const { adapter, load } = source;
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError(`sources[${index}].adapter must be an object`);
  }
  for (const field of ['sourceId', 'owner', 'artifactUrl']) {
    if (typeof adapter[field] !== 'string' || adapter[field].trim() === '') {
      throw new TypeError(`sources[${index}].adapter.${field} must be a non-empty string`);
    }
  }
  if (typeof adapter.ingest !== 'function') {
    throw new TypeError(`sources[${index}].adapter.ingest must be a function`);
  }
  if (typeof load !== 'function') {
    throw new TypeError(`sources[${index}].load must be a function`);
  }
}

function modelsFor(observations, catalog) {
  const identities = new Set(
    observations.map(({ providerId, modelId }) => `${providerId}:${modelId}`),
  );
  return catalog.models.filter(
    ({ providerId, modelId }) => identities.has(`${providerId}:${modelId}`),
  );
}

function legacySourceSnapshots(cache) {
  const groups = new Map();
  for (const observation of cache.catalog.observations) {
    const { source, freshness } = observation;
    if (!source?.id || !source?.snapshotHash) continue;
    const existing = groups.get(source.id);
    if (existing && existing.snapshotHash !== source.snapshotHash) {
      throw new TypeError(
        `legacy source ${source.id} contains several snapshot hashes`,
      );
    }
    const observations = existing?.observations ?? [];
    observations.push(observation);
    groups.set(source.id, {
      sourceId: source.id,
      owner: source.owner,
      artifactUrl: source.url,
      snapshotHash: source.snapshotHash,
      observedAt: freshness.observedAt,
      expiresAt: freshness.expiresAt,
      models: [],
      observations,
      signals: [],
    });
  }
  return [...groups.values()].map((source, index) =>
    validateRoutingEvidenceSourceSnapshot({
      ...source,
      models: modelsFor(source.observations, cache.catalog),
    }, index));
}

function cachedSources(cache) {
  const explicit = routingEvidenceSourcesFromCache(cache);
  return explicit.length > 0 ? explicit : legacySourceSnapshots(cache);
}

function cachedStatus(adapter, prior, reason) {
  return {
    sourceId: adapter.sourceId,
    status: prior ? 'cached' : 'quarantined',
    reason,
    cachedAt: prior?.observedAt,
  };
}

export async function refreshRoutingEvidence({
  sources,
  currentCache,
  expectedRevision,
  refreshedAt,
  expiresAt,
  onProgress = () => {},
}) {
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array');
  sources.forEach(validateSource);
  const requestedIds = new Set();
  for (const { adapter } of sources) {
    if (requestedIds.has(adapter.sourceId)) {
      throw new TypeError(`duplicate routing evidence source: ${adapter.sourceId}`);
    }
    requestedIds.add(adapter.sourceId);
  }

  const sourceState = new Map(
    cachedSources(currentCache).map((source) => [source.sourceId, source]),
  );
  const statuses = [];
  const quarantines = [];

  for (const { adapter, load } of sources) {
    const prior = sourceState.get(adapter.sourceId);
    onProgress({ sourceId: adapter.sourceId, status: 'loading' });
    let loaded;
    try {
      loaded = await load();
    } catch (error) {
      const reason = `load failed: ${message(error)}`;
      const status = cachedStatus(adapter, prior, reason);
      if (!prior) quarantines.push({ sourceId: adapter.sourceId, reason });
      statuses.push(status);
      onProgress(status);
      continue;
    }

    try {
      const ingested = adapter.ingest({
        payload: loaded.payload,
        snapshotHash: loaded.snapshotHash,
        observedAt: refreshedAt,
        expiresAt,
      });
      if (ingested.sourceId !== adapter.sourceId) {
        throw new TypeError(
          `source identity changed from ${adapter.sourceId} to ${ingested.sourceId}`,
        );
      }
      const candidate = validateRoutingEvidenceSourceSnapshot({
        sourceId: adapter.sourceId,
        owner: adapter.owner,
        artifactUrl: adapter.artifactUrl,
        snapshotHash: loaded.snapshotHash,
        observedAt: refreshedAt,
        expiresAt,
        models: ingested.models,
        observations: ingested.observations,
        signals: ingested.signals ?? [],
      });
      const prospective = new Map(sourceState);
      prospective.set(adapter.sourceId, candidate);
      buildEvidenceCatalogFromSources(
        [...prospective.values()],
        `catalog-r${expectedRevision + 1}`,
      );
      sourceState.set(adapter.sourceId, candidate);
      const status = { sourceId: adapter.sourceId, status: 'live' };
      statuses.push(status);
      onProgress(status);
    } catch (error) {
      const reason = message(error);
      const status = cachedStatus(adapter, prior, reason);
      quarantines.push({ sourceId: adapter.sourceId, reason });
      onProgress({ sourceId: adapter.sourceId, status: 'quarantined', reason });
      statuses.push(status);
      if (prior) onProgress(status);
    }
  }

  const nextSources = [...sourceState.values()];
  const nextCatalog = buildEvidenceCatalogFromSources(
    nextSources,
    `catalog-r${expectedRevision + 1}`,
  );
  const cache = commitRoutingEvidenceCache({
    current: currentCache,
    expectedRevision,
    nextCatalog,
    nextSources,
    refreshedAt,
    expiresAt,
  });
  return {
    cache,
    sources: statuses,
    quarantines,
    diff: observationDiff(
      currentCache.catalog.observations,
      nextCatalog.observations,
    ),
  };
}
