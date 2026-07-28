/**
 * `routing refresh` — the verb that writes the two documents `routing status`
 * reads.
 *
 * The refresh machinery could always build an Evidence catalog and nothing ever
 * stored one, because no command reached it: every Route decision therefore fell
 * back to a Standard route and named `missing:catalog`. This command is that
 * missing link. It builds the source list from the declared endpoint registry,
 * owns the `load` closures — which is what keeps the live network out of every
 * caller that injects its own — refreshes the catalog, and rebuilds the Access
 * graph from this host's observed capabilities.
 *
 * Both documents are written beside the routing profile, at the paths
 * `routing status` reads, through the constants that command exports. A second
 * copy of those paths is exactly how a reader and a writer drift apart.
 *
 * A partial refresh never replaces a good catalog with a worse one. A source
 * that fails to load keeps its previously cached snapshot, and a run in which no
 * source loaded at all writes nothing: the stored file survives untouched rather
 * than being replaced by an emptier one. Most runs are partial by construction —
 * only one of the six shipped sources publishes a key-free artifact and the
 * other five declare why they cannot be fetched — so the summary reports each
 * source's endpoint kind next to its status, and quarantine reads as the
 * declared steady state rather than as breakage.
 *
 * The summary also names every published model id the identity join could not
 * place. A board that renames a model would otherwise drop out of the catalog
 * without a trace, and a silent evidence miss is the one failure this command
 * exists to make impossible.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeAtomic } from '../lib/atomicWrite.mjs';
import {
  EVIDENCE_CATALOG_VERSION, evidenceSourceClaim, validateEvidenceCatalog,
} from '../lib/routingCatalog.mjs';
import { ROUTING_EVIDENCE_CACHE_VERSION } from '../lib/routingEvidenceCache.mjs';
import { refreshAccessGraph } from '../lib/routingHostCapabilities.mjs';
import { loadRoutingInventory } from '../lib/routingInventory.mjs';
import { createModelIdentityResolver } from '../lib/routingModelIdentity.mjs';
import { routingProfileStorageRoot } from '../lib/routingProfile.mjs';
import {
  ROUTING_SOURCE_ENDPOINTS, createRoutingSourceLoad,
} from '../lib/routingSources/endpoints.mjs';
import { refreshRoutingEvidence } from './routing-policy-update.mjs';
import {
  ACCESS_GRAPH_FILE, EVIDENCE_CATALOG_FILE, redactDiagnostic,
} from './routing-status.mjs';

export const ROUTING_REFRESH_DOCUMENT_VERSION = 1;

/** User-local routing evidence: owner-only, like every other routing document. */
const STORE_MODE = 0o600;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Why a refreshed catalog was not written. A written one names no reason. */
const NO_SOURCE_LOADED = 'no-source-loaded';
const UNCHANGED = 'unchanged';

/** What a first refresh starts from: no models, no observations, revision zero. */
const EMPTY_CATALOG = Object.freeze({
  schemaVersion: EVIDENCE_CATALOG_VERSION,
  revision: 'catalog-r0',
  models: Object.freeze([]),
  observations: Object.freeze([]),
});

/** Read the stored catalog. Missing is `null`; unreadable or invalid fails closed. */
async function readStoredCatalog(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return validateEvidenceCatalog(JSON.parse(raw));
}

/**
 * The refresh counter lives in the stored revision, so a refresh advances the
 * one it read instead of restarting a numbering the dispatch lease compares.
 */
function storedRevision(catalog) {
  const match = /-r(\d+)$/.exec(catalog?.revision ?? '');
  return match ? Number(match[1]) : 0;
}

/** The refresh window closes when its shortest-lived source's evidence does. */
function refreshWindow(sources, refreshedAt) {
  const days = sources.map(({ adapter }) =>
    evidenceSourceClaim(adapter.sourceId).freshness.maxAgeDays);
  return new Date(Date.parse(refreshedAt) + Math.min(...days) * DAY_MS).toISOString();
}

/**
 * The cache envelope the refresh reconciles against. Only the catalog is stored,
 * so each previously cached source snapshot comes back from the observations
 * that catalog already carries.
 */
function currentCache(catalog, refreshedAt, expiresAt) {
  return {
    schemaVersion: ROUTING_EVIDENCE_CACHE_VERSION,
    revision: storedRevision(catalog),
    refreshedAt,
    expiresAt,
    catalog: catalog ?? EMPTY_CATALOG,
  };
}

/** The declared endpoint of one source; `null` for a source a caller injected. */
const endpointKind = (sourceId) =>
  ROUTING_SOURCE_ENDPOINTS.find((entry) => entry.sourceId === sourceId)?.kind ?? null;

/**
 * The shipped sources with the `load` closure each one's declared endpoint
 * implies. A source without a fetchable artifact throws its declared reason, and
 * that throw is the quarantine trigger.
 */
export function shippedRoutingSources({ resolver, fetchJson }) {
  return ROUTING_SOURCE_ENDPOINTS.map(({ adapter, sourceId }) => ({
    adapter,
    load: createRoutingSourceLoad({ sourceId, resolver, fetchJson }),
  }));
}

/** Wrap one `load` so the identity join's misses survive into the summary. */
function recordingSource({ adapter, load }, misses) {
  return {
    adapter,
    load: async () => {
      const loaded = await load();
      for (const key of ['unresolved', 'skipped']) {
        for (const record of loaded[key] ?? []) {
          misses[key].push({ sourceId: adapter.sourceId, ...record });
        }
      }
      return loaded;
    },
  };
}

const evidenceOf = ({ models, observations }) => JSON.stringify({ models, observations });

/**
 * Store the refreshed catalog — but only when a source actually loaded and the
 * evidence moved. A run in which every source failed leaves the stored file
 * exactly as it was: a partial refresh must never replace a good catalog with a
 * worse one, and an emptier catalog is worse than yesterday's.
 */
async function storeCatalog({ file, catalog, stored, live }) {
  if (!live) {
    return { written: false, reason: NO_SOURCE_LOADED, revision: stored?.revision ?? null };
  }
  if (stored && evidenceOf(stored) === evidenceOf(catalog)) {
    return { written: false, reason: UNCHANGED, revision: stored.revision };
  }
  await writeAtomic(file, `${JSON.stringify(catalog, null, 2)}\n`, STORE_MODE);
  return { written: true, reason: null, revision: catalog.revision };
}

/** Load every source, then store whatever survived the loading. */
async function refreshCatalog({ file, sources, now }) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new TypeError('routing refresh needs at least one evidence source');
  }
  const misses = { unresolved: [], skipped: [] };
  const stored = await readStoredCatalog(file);
  const expiresAt = refreshWindow(sources, now);
  const refreshed = await refreshRoutingEvidence({
    sources: sources.map((source) => recordingSource(source, misses)),
    currentCache: currentCache(stored, now, expiresAt),
    expectedRevision: storedRevision(stored),
    refreshedAt: now,
    expiresAt,
  });
  const { catalog } = refreshed.cache;
  return {
    ...refreshed,
    ...misses,
    catalog,
    write: await storeCatalog({
      file,
      catalog,
      stored,
      live: refreshed.sources.some(({ status }) => status === 'live'),
    }),
  };
}

/** One key set, whatever the outcome — a machine reads the same shape every time. */
function refreshDocument(fields = {}) {
  return {
    schemaVersion: ROUTING_REFRESH_DOCUMENT_VERSION,
    outcome: 'failed',
    exitCode: 1,
    refreshedAt: null,
    catalog: null,
    accessGraph: null,
    sources: [],
    quarantines: [],
    unresolved: [],
    skipped: [],
    diagnostics: [],
    ...fields,
  };
}

/** An unexpected failure still answers in the machine shape, redacted. */
export function routingRefreshFailure(detail) {
  return refreshDocument({
    diagnostics: [{ code: 'routing-refresh-failed', detail: redactDiagnostic(detail) }],
  });
}

function catalogSummary({ catalog, write, diff }) {
  return {
    revision: write.revision,
    written: write.written,
    reason: write.reason,
    models: catalog.models.length,
    observations: catalog.observations.length,
    diff: { ...diff },
  };
}

function accessGraphSummary(stored) {
  return {
    revision: stored.revision,
    changed: stored.changed,
    paths: stored.graph.paths.length,
    detectedSurfaces: [...stored.detectedSurfaces],
    unobservedSurfaces: [...stored.unobservedSurfaces],
  };
}

function sourceSummary(entry) {
  return {
    sourceId: entry.sourceId,
    status: entry.status,
    reason: entry.reason ?? null,
    cachedAt: entry.cachedAt ?? null,
    endpoint: endpointKind(entry.sourceId),
  };
}

/**
 * Refresh both routing documents and report what moved. Every source is loaded
 * whether or not it can succeed, and a failure becomes a named quarantine rather
 * than a throw, so one absent artifact never costs the run its other five.
 */
export async function routingRefresh(options = {}) {
  const {
    profileRoot, now = new Date().toISOString(), inventory = null, sources = null,
    fetchJson, hostEvidence = {}, registry, commandAvailable, lockTimeoutMs,
  } = options;
  const pinned = inventory ?? await loadRoutingInventory();
  const storage = routingProfileStorageRoot(profileRoot);
  const catalog = await refreshCatalog({
    file: join(storage, EVIDENCE_CATALOG_FILE),
    sources: sources ?? shippedRoutingSources({
      resolver: createModelIdentityResolver(pinned), fetchJson,
    }),
    now,
  });
  const graph = await refreshAccessGraph({
    file: join(storage, ACCESS_GRAPH_FILE),
    inventory: pinned,
    registry,
    hostEvidence,
    commandAvailable,
    lockTimeoutMs,
  });
  return refreshDocument({
    outcome: catalog.write.written || graph.changed ? 'refreshed' : UNCHANGED,
    exitCode: 0,
    refreshedAt: now,
    catalog: catalogSummary(catalog),
    accessGraph: accessGraphSummary(graph),
    sources: catalog.sources.map(sourceSummary),
    quarantines: catalog.quarantines.map((entry) => ({ ...entry })),
    unresolved: catalog.unresolved,
    skipped: catalog.skipped,
  });
}
