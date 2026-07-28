/**
 * Where each shipped source is fetched from, and how its live document becomes
 * the payload that source's parser already accepts.
 *
 * Declared, never guessed. Three sources publish a machine-readable artifact
 * and three do not; a source without one is declared absent with the reason and
 * the evidence, so its `load()` throws an honest sentence and lands in
 * quarantine instead of looking like a source nobody asked for.
 *
 * The live shape is not the parser shape. A parser expects an identified
 * artifact block and rows carrying provider, effort, score, uncertainty and
 * cost; a live board publishes none of that structure. So a normalizer
 * synthesizes the artifact block from the adapter's own constants plus the live
 * generation stamp, renames the published metric fields, and joins the
 * published model id onto the pinned inventory. A row it cannot use is filtered
 * and reported, never dropped: one unusable row must not quarantine a whole
 * artifact, and an unknown model must not vanish.
 */
import { UNKNOWN_EFFORT } from '../routingCatalog.mjs';
import { fetchJsonArtifact } from '../routingFetch.mjs';
import { artificialAnalysisSource } from './artificialAnalysis.mjs';
import { benchLmSource } from './benchlm.mjs';
import { codeArenaSource } from './codeArena.mjs';
import { deepSweSource } from './deepswe.mjs';
import { openHandsSource } from './openhands.mjs';
import { openHandsFrontendSource } from './openhandsFrontend.mjs';

/** A key-free URL that returns the artifact on a plain GET. */
export const ENDPOINT_ARTIFACT = 'artifact';
/** An artifact behind a documented API the Kit cannot call unattended. */
export const ENDPOINT_DOCUMENTED_API = 'documented-api';
/** The owner publishes no machine-readable artifact at all. */
export const ENDPOINT_NONE = 'none';

const DEEPSWE_BENCHMARK = 'DeepSWE';
// DeepSWE names its harness per row but never a harness version; the parser
// requires one, so the artifact records the absence instead of inventing it.
const DEEPSWE_HARNESS_VERSION = 'unversioned';
const DEEPSWE_HARNESS_ID = 'mini-swe-agent';

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

function array(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

/** The benchmark version the Kit ingests is the one pinned in the artifact URL. */
function artifactVersion(url) {
  const match = /\/artifacts\/(v[0-9][0-9.]*)\//.exec(url);
  if (!match) throw new TypeError(`no benchmark version in artifact url ${url}`);
  return match[1];
}

function deepSweArtifact(generatedAt, harnesses) {
  if (harnesses.size > 1) {
    throw new TypeError(
      `DeepSWE live rows name several harnesses: ${[...harnesses].sort().join(', ')}`,
    );
  }
  return {
    owner: deepSweSource.owner,
    url: deepSweSource.artifactUrl,
    benchmark: DEEPSWE_BENCHMARK,
    version: artifactVersion(deepSweSource.artifactUrl),
    generatedAt,
    harness: { id: [...harnesses][0] ?? DEEPSWE_HARNESS_ID, version: DEEPSWE_HARNESS_VERSION },
  };
}

function normalizeDeepSwe({ documents, resolver }) {
  const live = object(documents?.leaderboard, 'DeepSWE live document');
  const generatedAt = string(live.generated_at, 'DeepSWE live generated_at');
  const rows = [];
  const unresolved = [];
  const skipped = [];
  const harnesses = new Set();
  array(live.rows, 'DeepSWE live rows').forEach((entry, index) => {
    const row = object(entry, `DeepSWE live rows[${index}]`);
    const published = string(row.model, `DeepSWE live rows[${index}].model`);
    // `deepswe` preserves effort, so a row that publishes none cannot be
    // ingested at all — but it is reported rather than quarantining the source.
    if (typeof row.reasoning_effort !== 'string' || row.reasoning_effort.trim() === '') {
      skipped.push(Object.freeze({ publishedId: published, reason: 'no-published-effort' }));
      return;
    }
    const identity = resolver.resolve(published);
    if (!identity.resolved) {
      unresolved.push(identity);
      return;
    }
    harnesses.add(string(row.harness, `DeepSWE live rows[${index}].harness`));
    rows.push({
      provider: identity.provider,
      model: identity.modelId,
      effort: row.reasoning_effort,
      score: row.pass_at_1,
      confidence95HalfWidth: row.ci_half,
      averageCostUsd: row.mean_cost_usd,
    });
  });
  return Object.freeze({
    payload: { artifact: deepSweArtifact(generatedAt, harnesses), rows },
    unresolved: Object.freeze(unresolved),
    skipped: Object.freeze(skipped),
  });
}

function artificialAnalysisIdentity(live) {
  return {
    publisher: artificialAnalysisSource.owner,
    canonicalUrl: artificialAnalysisSource.artifactUrl,
    index: string(live.index, 'Artificial Analysis index'),
    release: string(live.release, 'Artificial Analysis release'),
    harnessName: string(live.harness_name, 'Artificial Analysis harness_name'),
    harnessRelease: string(live.harness_release, 'Artificial Analysis harness_release'),
  };
}

function normalizeArtificialAnalysis({ documents, resolver }) {
  const live = object(documents?.index, 'Artificial Analysis index document');
  const configurations = [];
  const unresolved = [];
  array(live.rows, 'Artificial Analysis rows').forEach((entry, index) => {
    const row = object(entry, `Artificial Analysis rows[${index}]`);
    const identity = resolver.resolve(string(row.model, `Artificial Analysis rows[${index}].model`));
    if (!identity.resolved) {
      unresolved.push(identity);
      return;
    }
    const cost = object(
      row.artificial_analysis_intelligence_index_cost?.cost_per_task,
      `Artificial Analysis rows[${index}].cost_per_task`,
    );
    configurations.push({
      providerId: identity.provider,
      modelId: identity.modelId,
      // The Coding Agent Index runs every agent on its default reasoning
      // settings, so the source collapses effort by construction.
      reasoningEffort: UNKNOWN_EFFORT,
      indexScore: row.index_score,
      costPerTaskUsd: cost.total_cost,
      uncertainty: {
        kind: 'confidence-interval-95-half-width',
        value: row.confidence_interval_half_width,
      },
    });
  });
  return Object.freeze({
    payload: { identity: artificialAnalysisIdentity(live), configurations },
    unresolved: Object.freeze(unresolved),
    skipped: Object.freeze([]),
  });
}

function normalizeBenchLm({ documents }) {
  const parts = ['models', 'benchmarks', 'updates'].map((key) => [
    key,
    object(documents?.[key], `BenchLM ${key} export`),
  ]);
  const [, primary] = parts[0];
  const merged = {
    schemaVersion: primary.schemaVersion,
    // Every documented export carries the same envelope; the merged snapshot is
    // dated by the primary export and refuses parts that disagree on schema.
    generatedAt: string(primary.generatedAt, 'BenchLM models export generatedAt'),
    sourceLastUpdated: string(primary.sourceLastUpdated, 'BenchLM models export sourceLastUpdated'),
  };
  for (const [key, part] of parts) {
    if (part.schemaVersion !== primary.schemaVersion) {
      throw new TypeError(
        `BenchLM ${key} export declares schemaVersion ${part.schemaVersion}, `
        + `not ${primary.schemaVersion}`,
      );
    }
    merged[key] = array(part[key], `BenchLM ${key} export ${key}`);
  }
  return Object.freeze({
    payload: merged,
    unresolved: Object.freeze([]),
    skipped: Object.freeze([]),
  });
}

function endpoint({
  adapter, kind, documents = [], reference, evidence,
  unavailableReason = null, normalize = null,
}) {
  return Object.freeze({
    sourceId: adapter.sourceId,
    adapter,
    kind,
    documents: Object.freeze(documents.map((document) => Object.freeze({ ...document }))),
    reference,
    evidence,
    unavailableReason,
    normalize,
  });
}

export const ROUTING_SOURCE_ENDPOINTS = Object.freeze([
  endpoint({
    adapter: deepSweSource,
    kind: ENDPOINT_ARTIFACT,
    documents: [{ key: 'leaderboard', url: deepSweSource.artifactUrl }],
    reference: deepSweSource.artifactUrl,
    evidence: 'HTTP 200, 62 289 bytes, probed 2026-07-28; docs/research/agent-task-taxonomy-benchmark-coverage.md',
    normalize: normalizeDeepSwe,
  }),
  endpoint({
    adapter: artificialAnalysisSource,
    kind: ENDPOINT_DOCUMENTED_API,
    reference: 'https://artificialanalysis.ai/data-api/docs',
    evidence: 'docs/research/agent-task-taxonomy-benchmark-coverage.md, Data API row of the source table',
    unavailableReason: 'the Artificial Analysis Data API is documented but credentialed, and no '
      + 'key-free artifact url has been probed for the Coding Agent Index',
    normalize: normalizeArtificialAnalysis,
  }),
  endpoint({
    adapter: benchLmSource,
    kind: ENDPOINT_ARTIFACT,
    documents: [
      { key: 'models', url: 'https://benchlm.ai/data/models.json' },
      { key: 'benchmarks', url: 'https://benchlm.ai/data/benchmarks.json' },
      { key: 'updates', url: 'https://benchlm.ai/data/updates.json' },
    ],
    reference: benchLmSource.artifactUrl,
    evidence: 'docs/research/benchlm-routing-source.md, documented MIT-licensed /data/*.json exports',
    normalize: normalizeBenchLm,
  }),
  endpoint({
    adapter: codeArenaSource,
    kind: ENDPOINT_NONE,
    reference: 'https://arena.ai/leaderboard/code/webdev',
    evidence: 'docs/research/agent-task-taxonomy-benchmark-coverage.md, gap 7',
    unavailableReason: 'the WebDev board publishes no leaderboard API; only the ranking code and '
      + 'the raw vote dataset are released, and neither is the published board',
  }),
  endpoint({
    adapter: openHandsSource,
    kind: ENDPOINT_NONE,
    reference: 'https://index.openhands.dev/',
    evidence: 'docs/research/agent-task-taxonomy-benchmark-coverage.md, gap 7',
    unavailableReason: 'the OpenHands Index publishes no export; only the harness is open-sourced',
  }),
  endpoint({
    adapter: openHandsFrontendSource,
    kind: ENDPOINT_NONE,
    reference: 'https://www.openhands.dev/blog/openhands-index',
    evidence: 'docs/research/frontend-agent-benchmarks.md, the frontend subset section',
    unavailableReason: 'the frontend subset is reported inside the same Index that publishes no '
      + 'export, so it has no artifact of its own',
  }),
]);

export function routingSourceEndpoint(sourceId) {
  const entry = ROUTING_SOURCE_ENDPOINTS.find((candidate) => candidate.sourceId === sourceId);
  if (!entry) throw new TypeError(`unknown routing evidence source: ${sourceId}`);
  return entry;
}

/**
 * The `load()` one source needs: fetch its documents, join the published model
 * ids onto the pinned inventory, and hand back the parser payload together with
 * everything that could not be used. A source without a fetchable artifact
 * throws its declared reason — that throw is the quarantine trigger.
 */
export function createRoutingSourceLoad({ sourceId, resolver, fetchJson = fetchJsonArtifact }) {
  const entry = routingSourceEndpoint(sourceId);
  return async () => {
    if (entry.kind !== ENDPOINT_ARTIFACT) {
      throw new Error(
        `routing source ${entry.sourceId} has no fetchable artifact: ${entry.unavailableReason}`,
      );
    }
    const documents = {};
    const hashes = [];
    for (const { key, url } of entry.documents) {
      const fetched = await fetchJson({ url });
      documents[key] = fetched.payload;
      hashes.push(`${key}=${fetched.snapshotHash}`);
    }
    const { payload, unresolved, skipped } = entry.normalize({ documents, resolver });
    return { payload, snapshotHash: hashes.join(' '), unresolved, skipped };
  };
}
