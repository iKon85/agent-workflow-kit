import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  INVENTORY_SNAPSHOT_FILES, loadRoutingInventory, presentInventory, snapshotDigest,
} from '../src/lib/routingInventory.mjs';

const SNAPSHOT_DIR = fileURLToPath(new URL('../src/lib/routingInventory/snapshots/', import.meta.url));

const INTEGRITY = /^sha256-[A-Za-z0-9_-]{43}$/;

const pairKey = ({ surface, modelId, effort }) => `${surface}:${modelId}:${effort ?? ''}`;

/** Copy the pinned snapshots into a scratch directory so a test may tamper. */
async function snapshotFixture(mutate = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'routing-inventory-'));
  for (const file of INVENTORY_SNAPSHOT_FILES) {
    const snapshot = JSON.parse(await readFile(join(SNAPSHOT_DIR, file), 'utf8'));
    mutate(snapshot, file);
    await writeFile(join(dir, file), `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  return dir;
}

test('the pinned inventory lists every known model-and-effort pair, unfiltered', async () => {
  const inventory = await loadRoutingInventory();
  const expected = inventory.snapshots.flatMap((snapshot) => snapshot.models.flatMap(
    (model) => (model.effortAxis
      ? model.efforts.map((effort) => `${snapshot.surface}:${model.modelId}:${effort}`)
      : [`${snapshot.surface}:${model.modelId}:`]),
  ));
  assert.deepEqual(inventory.pairs.map(pairKey), expected);
  // ADR-0006: the shipped table is never filtered. A model the surface itself
  // hides from its own picker is still a known pair.
  assert.ok(inventory.snapshots.some((s) => s.models.some((m) => m.visibility !== 'list')));
  assert.ok(inventory.pairs.some((p) => p.modelId === 'codex-auto-review'));
});

test('a per-model effort domain is pinned, so an unsupported pair does not exist', async () => {
  const { pairs } = await loadRoutingInventory();
  assert.ok(pairs.some((p) => p.modelId === 'gpt-5.6-sol' && p.effort === 'ultra'));
  assert.ok(!pairs.some((p) => p.modelId === 'gpt-5.6-luna' && p.effort === 'ultra'));
  assert.ok(!pairs.some((p) => p.modelId === 'gpt-5.5' && p.effort === 'max'));
});

test('a model with no effort axis contributes exactly one pair whose effort is absent', async () => {
  const { pairs, snapshots } = await loadRoutingInventory();
  const axisless = snapshots.flatMap((s) => s.models.filter((m) => !m.effortAxis));
  assert.ok(axisless.length, 'the pinned inventory must record at least one model without an effort axis');
  for (const model of axisless) {
    const own = pairs.filter((p) => p.modelId === model.modelId);
    assert.equal(own.length, 1);
    assert.equal(own[0].effort, null);
  }
});

test('every snapshot carries its provenance and matches its recorded hash', async () => {
  const { snapshots, revision } = await loadRoutingInventory();
  assert.equal(snapshots.length, INVENTORY_SNAPSHOT_FILES.length);
  for (const snapshot of snapshots) {
    assert.match(snapshot.provenance.integrity, INTEGRITY);
    assert.equal(snapshotDigest(snapshot), snapshot.provenance.integrity);
    assert.ok(snapshot.provenance.sourceKind);
    assert.match(snapshot.provenance.capturedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(snapshot.provenance.sourceRef);
  }
  assert.match(revision, INTEGRITY);
});

test('the inventory revision is deterministic and moves only with the pinned payload', async () => {
  const first = await loadRoutingInventory();
  const second = await loadRoutingInventory();
  assert.equal(first.revision, second.revision);

  const dir = await snapshotFixture((snapshot, file) => {
    if (file !== INVENTORY_SNAPSHOT_FILES[0]) return;
    snapshot.models[0].efforts = snapshot.models[0].efforts.slice(0, 1);
    snapshot.models[0].defaultEffort = snapshot.models[0].efforts[0] ?? null;
    snapshot.provenance.integrity = snapshotDigest(snapshot);
  });
  try {
    const rehashed = await loadRoutingInventory({ snapshotDir: dir });
    assert.notEqual(rehashed.revision, first.revision);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a snapshot whose payload no longer matches its provenance hash fails closed', async () => {
  const dir = await snapshotFixture((snapshot, file) => {
    if (file !== INVENTORY_SNAPSHOT_FILES[0]) return;
    snapshot.models.push({
      modelId: 'smuggled-model', identifiers: ['smuggled-model'], effortAxis: false,
      efforts: [], defaultEffort: null, visibility: 'list', effortSource: 'none',
    });
  });
  try {
    await assert.rejects(
      loadRoutingInventory({ snapshotDir: dir }),
      /provenance hash/,
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an unreadable or malformed snapshot fails closed instead of shipping a partial inventory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'routing-inventory-broken-'));
  try {
    await writeFile(join(dir, INVENTORY_SNAPSHOT_FILES[0]), 'not json\n');
    await assert.rejects(loadRoutingInventory({ snapshotDir: dir }), /routing inventory snapshot/);
    await rm(join(dir, INVENTORY_SNAPSHOT_FILES[0]));
    await assert.rejects(loadRoutingInventory({ snapshotDir: dir }), /routing inventory snapshot/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('loading the pinned inventory makes no network call', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('the pinned inventory must never reach the network'); };
  try {
    const inventory = await loadRoutingInventory();
    assert.ok(inventory.pairs.length > 0);
  } finally { globalThis.fetch = original; }
});

test('local detection changes presentation order only and never the pair set', async () => {
  const inventory = await loadRoutingInventory();
  const undetected = presentInventory(inventory, []);
  const detected = presentInventory(inventory, [
    { id: 'codex', detected: true },
    { id: 'claude-code', detected: false },
  ]);
  assert.deepEqual(
    [...detected.pairs].map(pairKey).sort(),
    [...inventory.pairs].map(pairKey).sort(),
    'detection must never remove a known pair from the inventory',
  );
  assert.equal(detected.pairs.length, inventory.pairs.length);
  assert.equal(detected.pairs[0].surface, 'codex');
  assert.deepEqual(undetected.pairs.map(pairKey), inventory.pairs.map(pairKey));
});

test('detection feeds attestation as unknown access, never as authorization', async () => {
  const inventory = await loadRoutingInventory();
  const { attestations } = presentInventory(inventory, [{ id: 'codex', detected: true }]);
  assert.equal(attestations.length, inventory.pairs.length);
  for (const attestation of attestations) {
    assert.deepEqual(Object.keys(attestation).sort(), [
      'access', 'detectedSurface', 'effort', 'modelId', 'provider', 'surface',
    ]);
    assert.equal(attestation.access, 'unknown');
  }
  assert.ok(attestations.some((a) => a.surface === 'codex' && a.detectedSurface === true));
  assert.ok(attestations.some((a) => a.surface === 'claude-code' && a.detectedSurface === false));
});

test('the pinned snapshots ship beside their module so an installed consumer resolves them', async () => {
  for (const file of INVENTORY_SNAPSHOT_FILES) {
    const raw = await readFile(join(SNAPSHOT_DIR, file), 'utf8');
    assert.ok(JSON.parse(raw).models.length > 0, file);
  }
  const relocated = await mkdtemp(join(tmpdir(), 'routing-inventory-move-'));
  try {
    await mkdir(join(relocated, 'routingInventory/snapshots'), { recursive: true });
    for (const file of INVENTORY_SNAPSHOT_FILES) {
      await writeFile(
        join(relocated, 'routingInventory/snapshots', file),
        await readFile(join(SNAPSHOT_DIR, file)),
      );
    }
    await writeFile(
      join(relocated, 'routingInventory.mjs'),
      await readFile(fileURLToPath(new URL('../src/lib/routingInventory.mjs', import.meta.url))),
    );
    const module = await import(pathToFileURL(join(relocated, 'routingInventory.mjs')).href);
    const inventory = await module.loadRoutingInventory();
    assert.ok(inventory.pairs.length > 0);
  } finally { await rm(relocated, { recursive: true, force: true }); }
});
