/**
 * The production test of Welle 21 (#384): the verification matrix tested resolver
 * behaviour *given* a catalog and never tested catalog *production*, so every row
 * was green while no catalog was ever written. These cases run the real verb —
 * refresh, then resolve — with injected `load` closures and no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { routingRefresh } from '../src/commands/routing-refresh.mjs';
import {
  ACCESS_GRAPH_FILE, EVIDENCE_CATALOG_FILE, routingStatus,
} from '../src/commands/routing-status.mjs';
import { createDispatchReceipt } from '../src/lib/dispatchReceipt.mjs';
import { hostCapabilityPathId } from '../src/lib/routingHostCapabilities.mjs';
import { routingProfileStorageRoot } from '../src/lib/routingProfile.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/routing/status/', import.meta.url));
const LIVE_DEEPSWE = fileURLToPath(
  new URL('./fixtures/routing/deepswe-live-2026-07-28.json', import.meta.url),
);
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const COMMAND = fileURLToPath(new URL('../src/commands/routing-refresh.mjs', import.meta.url));

const NOW = '2026-07-28T00:00:00.000Z';
const HOST_EXPIRES_AT = '2026-08-28T00:00:00.000Z';
const DEEPSWE_HOST = 'https://deepswe.datacurve.ai/';
const SNAPSHOT_HASH = 'sha256-deepswe-live-fixture';
const CLAUDE_ENV = Object.freeze({ CLAUDE_CODE_ENTRYPOINT: 'cli' });
/** The fixture composes from the global authorization: no project narrowing. */
const IDENTITY = Object.freeze({
  key: 'routing-status-fixture', value: 'routing-status-fixture',
  source: 'project-path', confidence: 'lower', markerPath: null,
});

const OPUS_PATH_ID = hostCapabilityPathId({
  surfaceId: 'claude-code', transportId: 'native', modelId: 'opus', effort: 'high',
});

/**
 * One fully observed host route. Without host evidence `refreshAccessGraph`
 * writes a valid but EMPTY graph — which lifts `missing:accessGraph` while
 * leaving nothing for the evidence to rank, i.e. exactly the green-gate,
 * absent-capability failure this slice exists to kill.
 */
const HOST_EVIDENCE = Object.freeze({
  'claude-code': {
    observedAt: NOW,
    expiresAt: HOST_EXPIRES_AT,
    routes: {
      [OPUS_PATH_ID]: {
        callable: true,
        permitted: true,
        model: { enforced: true, precedence: 'explicit-argument', applied: 'opus' },
        effort: { enforced: true, precedence: 'explicit-argument', applied: 'high' },
      },
    },
  },
});

/**
 * The one artifact this suite serves. Every other url fails — which is what the
 * five sources without a key-free artifact do in production too, so quarantine
 * is the steady state here for the same reason it is there.
 */
function servingDeepSwe(payload) {
  return async ({ url }) => {
    if (!url.startsWith(DEEPSWE_HOST)) throw new Error(`no fixture artifact for ${url}`);
    return { url, payload, snapshotHash: SNAPSHOT_HASH };
  };
}

const servingNothing = async ({ url }) => { throw new Error(`no fixture artifact for ${url}`); };

const liveDeepSwe = async () => JSON.parse(await readFile(LIVE_DEEPSWE, 'utf8'));

/** A writable routing world whose two documents are the ones the verb produces. */
async function world() {
  const root = await mkdtemp(join(tmpdir(), 'awk-routing-refresh-'));
  const profileRoot = join(root, 'agent-workflow-kit');
  await cp(join(FIXTURE, 'agent-workflow-kit'), profileRoot, { recursive: true });
  const storage = routingProfileStorageRoot(profileRoot);
  await rm(join(storage, EVIDENCE_CATALOG_FILE));
  await rm(join(storage, ACCESS_GRAPH_FILE));
  return {
    root,
    profileRoot,
    catalogFile: join(storage, EVIDENCE_CATALOG_FILE),
    graphFile: join(storage, ACCESS_GRAPH_FILE),
  };
}

const refresh = (profileRoot, fetchJson) => routingRefresh({
  profileRoot,
  now: NOW,
  fetchJson,
  hostEvidence: HOST_EVIDENCE,
  commandAvailable: async () => true,
});

const status = (profileRoot, name) => routingStatus({
  argv: ['--json', `--intent-file=${join(FIXTURE, `intent-${name}.txt`)}`],
  env: CLAUDE_ENV,
  now: NOW,
  consumerRoot: FIXTURE,
  profileRoot,
  identity: IDENTITY,
});

const sourceStatus = (document, sourceId) =>
  document.sources.find((entry) => entry.sourceId === sourceId);

test('the verb writes both documents to the exact paths routing status reads', async () => {
  const { root, profileRoot, catalogFile, graphFile } = await world();

  const document = await refresh(profileRoot, servingDeepSwe(await liveDeepSwe()));

  assert.equal(document.schemaVersion, 1);
  assert.equal(document.outcome, 'refreshed');
  assert.equal(document.exitCode, 0);
  assert.equal(document.catalog.written, true);
  assert.equal(document.catalog.revision, 'catalog-r1');
  assert.ok(document.catalog.observations > 0);
  assert.equal(document.accessGraph.changed, true);

  const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
  assert.equal(catalog.revision, document.catalog.revision);
  assert.equal(catalog.observations.length, document.catalog.observations);
  const graph = JSON.parse(await readFile(graphFile, 'utf8'));
  assert.equal(graph.revision, document.accessGraph.revision);
  assert.deepEqual(graph.paths.map((path) => path.id), [OPUS_PATH_ID]);

  // Every shipped source is attempted, and each one says which endpoint it has.
  assert.equal(document.sources.length, 6);
  assert.equal(sourceStatus(document, 'deepswe').status, 'live');
  assert.equal(sourceStatus(document, 'deepswe').endpoint, 'artifact');
  assert.equal(sourceStatus(document, 'openhands-evaluation').endpoint, 'none');
  await rm(root, { recursive: true, force: true });
});

test('refresh then resolve: a covered intent becomes an evidence-backed decision', async () => {
  const { root, profileRoot } = await world();

  // The control: without the verb the very same intent has no catalog at all.
  const before = await status(profileRoot, 'development');
  assert.equal(before.document.origin, null);
  assert.ok(before.document.blockers.includes('missing:catalog'));

  const document = await refresh(profileRoot, servingDeepSwe(await liveDeepSwe()));
  const after = await status(profileRoot, 'development');

  assert.equal(after.document.origin, 'evidence');
  assert.equal(after.document.evidenceBacked, true);
  assert.equal(after.document.selected.modelId, 'opus');
  assert.equal(after.document.selected.accessPathId, OPUS_PATH_ID);
  assert.equal(after.document.revisions.catalog, document.catalog.revision);
  assert.equal(after.document.revisions.accessGraph, document.accessGraph.revision);

  // The written revision travels all the way into the receipt that proves a run.
  const route = {
    providerId: after.document.selected.providerId,
    modelId: after.document.selected.modelId,
    effort: after.document.selected.effort,
    surfaceId: after.document.selected.surfaceId,
    transportId: after.document.selected.transportId,
  };
  const receipt = createDispatchReceipt({
    executionId: 'routing-refresh-slice',
    status: 'dispatched',
    afk: false,
    requestedRoute: route,
    appliedRoute: route,
    enforcement: after.document.selected.enforcement,
    revisions: after.document.revisions,
    dispatchedAt: NOW,
  });
  assert.equal(receipt.catalogRevision, document.catalog.revision);
  await rm(root, { recursive: true, force: true });
});

test('an intent the catalog does not cover still falls back to its Standard route', async () => {
  const { root, profileRoot } = await world();

  await refresh(profileRoot, servingDeepSwe(await liveDeepSwe()));
  const { document } = await status(profileRoot, 'judgment');

  assert.equal(document.origin, 'standard');
  assert.equal(document.evidenceBacked, false);
  assert.equal(document.selected.workloadClass, 'judgment');
  assert.equal(document.bestOverall.status, 'unavailable');
  await rm(root, { recursive: true, force: true });
});

test('a source that cannot load is quarantined and never overwrites a good catalog', async () => {
  const { root, profileRoot, catalogFile } = await world();

  const first = await refresh(profileRoot, servingDeepSwe(await liveDeepSwe()));
  const stored = await readFile(catalogFile, 'utf8');

  // Five of six sources publish no fetchable artifact: quarantine is declared,
  // not broken, and every quarantine names the reason it was refused with.
  assert.equal(first.quarantines.length, 5);
  for (const { sourceId, reason } of first.quarantines) {
    assert.match(reason, /no fetchable artifact|no fixture artifact/, sourceId);
    assert.equal(sourceStatus(first, sourceId).status, 'quarantined');
  }

  const second = await refresh(profileRoot, servingNothing);

  assert.equal(second.catalog.written, false);
  assert.equal(second.catalog.reason, 'no-source-loaded');
  assert.equal(second.catalog.revision, first.catalog.revision);
  assert.equal(sourceStatus(second, 'deepswe').status, 'cached');
  assert.match(sourceStatus(second, 'deepswe').reason, /no fixture artifact/);
  assert.equal(await readFile(catalogFile, 'utf8'), stored, 'the stored catalog must survive');

  // And a first run in which every source fails writes no empty catalog at all.
  const bare = await world();
  const none = await refresh(bare.profileRoot, servingNothing);
  assert.equal(none.catalog.written, false);
  assert.equal(none.catalog.revision, null);
  await assert.rejects(access(bare.catalogFile), 'no catalog file may be created');

  await rm(root, { recursive: true, force: true });
  await rm(bare.root, { recursive: true, force: true });
});

test('the summary names every published model id the identity join could not place', async () => {
  const { root, profileRoot } = await world();

  const document = await refresh(profileRoot, servingDeepSwe(await liveDeepSwe()));

  assert.ok(document.unresolved.length > 0);
  assert.ok(document.unresolved.some(({ publishedId }) => publishedId === 'kimi-k3'));
  for (const record of document.unresolved) {
    assert.equal(record.sourceId, 'deepswe');
    assert.equal(record.resolved, false);
    assert.ok(record.reason, `${record.publishedId} must name why it did not resolve`);
  }
  // A row the parser cannot use is reported too, never silently dropped.
  for (const record of document.skipped) {
    assert.equal(record.sourceId, 'deepswe');
    assert.equal(record.reason, 'no-published-effort');
  }
  await rm(root, { recursive: true, force: true });
});

test('routing refresh --json prints only the summary document on stdout', async () => {
  const { root, profileRoot } = await world();
  const consumer = await mkdtemp(join(tmpdir(), 'awk-routing-refresh-consumer-'));
  const script = `
    import { readFile } from 'node:fs/promises';
    import { runCli } from ${JSON.stringify(`file://${CLI}`)};
    import { routingRefresh } from ${JSON.stringify(`file://${COMMAND}`)};
    const payload = JSON.parse(await readFile(${JSON.stringify(LIVE_DEEPSWE)}, 'utf8'));
    const fetchJson = async ({ url }) => {
      if (!url.startsWith(${JSON.stringify(DEEPSWE_HOST)})) throw new Error('no fixture artifact');
      return { url, payload, snapshotHash: ${JSON.stringify(SNAPSHOT_HASH)} };
    };
    process.exitCode = await runCli({
      argv: ['routing', 'refresh', '--json'],
      consumerRoot: ${JSON.stringify(consumer)},
      hasTTY: false,
      routingRefreshCommand: () => routingRefresh({
        profileRoot: ${JSON.stringify(profileRoot)},
        now: ${JSON.stringify(NOW)},
        fetchJson,
        hostEvidence: ${JSON.stringify(HOST_EVIDENCE)},
        commandAvailable: async () => true,
      }),
    });
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: consumer, encoding: 'utf8', input: '', timeout: 30_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().startsWith('{'), true, result.stdout);
  const document = JSON.parse(result.stdout);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.outcome, 'refreshed');
  assert.equal(document.catalog.written, true);
  await rm(root, { recursive: true, force: true });
  await rm(consumer, { recursive: true, force: true });
});
