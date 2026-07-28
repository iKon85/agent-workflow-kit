/**
 * The pinned Model inventory: every model-and-effort pair the Kit knows about,
 * per agent surface, read from provenance-hashed source snapshots committed
 * beside this module.
 *
 * Pinned, not live. Release preparation stays deterministic and offline: this
 * module only reads local files, never a provider API. Refreshing a snapshot is
 * a separate maintainer step.
 *
 * Unfiltered by construction. The inventory lists every known pair, including
 * pairs the local machine cannot reach and models a surface hides from its own
 * picker. Local detection feeds Access-graph attestation and the presentation
 * order of a setup list — never authorization. Authorization is the Model
 * roster, and it lives in the Routing profile.
 *
 * The digest covers the capability payload (surface, provider, snapshot
 * version, captured date, source kind, and the model records), not the free
 * prose of `provenance.sourceRef`: publish-time scrubbing rewrites prose but
 * must never touch a capability fact. It is written in the self-describing
 * `sha256-<base64url>` integrity form, so a shipped digest reads as a digest
 * rather than as an unexplained high-entropy string.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Snapshot files, in the order that fixes pair order. */
export const INVENTORY_SNAPSHOT_FILES = Object.freeze(['claude.json', 'codex.json']);

export const INVENTORY_SNAPSHOT_VERSION = 1;

/** Untested access is attested `unknown`; detection alone never promotes it. */
export const UNTESTED_ACCESS = 'unknown';

const DEFAULT_SNAPSHOT_DIR = fileURLToPath(
  new URL('./routingInventory/snapshots/', import.meta.url),
);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (text) => `sha256-${createHash('sha256').update(text).digest('base64url')}`;

/** Digest of a snapshot's capability payload — the value `provenance.integrity` pins. */
export function snapshotDigest(snapshot) {
  return sha256(canonical({
    snapshotVersion: snapshot.snapshotVersion,
    surface: snapshot.surface,
    provider: snapshot.provider,
    capturedAt: snapshot.provenance?.capturedAt ?? null,
    sourceKind: snapshot.provenance?.sourceKind ?? null,
    models: snapshot.models,
  }));
}

function assertModel(file, model) {
  const fail = (reason) => {
    throw new Error(`routing inventory snapshot ${file}: ${reason}`);
  };
  if (!model || typeof model.modelId !== 'string' || !model.modelId) fail('a model has no modelId');
  if (!Array.isArray(model.identifiers) || !model.identifiers.includes(model.modelId)) {
    fail(`model ${model.modelId} does not list its own identifier`);
  }
  if (typeof model.effortAxis !== 'boolean') fail(`model ${model.modelId} has no effortAxis`);
  if (!Array.isArray(model.efforts)) fail(`model ${model.modelId} has no effort domain`);
  if (model.effortAxis === (model.efforts.length === 0)) {
    fail(`model ${model.modelId} contradicts its effort axis`);
  }
  if (new Set(model.efforts).size !== model.efforts.length) {
    fail(`model ${model.modelId} repeats an effort`);
  }
  const fallback = model.defaultEffort ?? null;
  if (fallback !== null && !model.efforts.includes(fallback)) {
    fail(`model ${model.modelId} defaults to an effort outside its domain`);
  }
}

function assertSnapshot(file, snapshot) {
  const fail = (reason) => {
    throw new Error(`routing inventory snapshot ${file}: ${reason}`);
  };
  if (snapshot?.snapshotVersion !== INVENTORY_SNAPSHOT_VERSION) {
    fail(`unsupported snapshot version ${snapshot?.snapshotVersion}`);
  }
  for (const field of ['surface', 'provider']) {
    if (typeof snapshot[field] !== 'string' || !snapshot[field]) fail(`missing ${field}`);
  }
  if (!Array.isArray(snapshot.models) || !snapshot.models.length) fail('lists no model');
  for (const model of snapshot.models) assertModel(file, model);
  if (snapshotDigest(snapshot) !== snapshot.provenance?.integrity) {
    fail('payload does not match its recorded provenance hash');
  }
}

async function readSnapshot(snapshotDir, file) {
  let raw;
  try {
    raw = await readFile(join(snapshotDir, file), 'utf8');
  } catch (error) {
    throw new Error(`routing inventory snapshot ${file} is unreadable: ${error.code ?? error.message}`);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (error) {
    throw new Error(`routing inventory snapshot ${file} is not valid JSON: ${error.message}`);
  }
  assertSnapshot(file, snapshot);
  return snapshot;
}

function pairsOf(snapshot) {
  return snapshot.models.flatMap((model) => {
    const efforts = model.effortAxis ? model.efforts : [null];
    return efforts.map((effort) => Object.freeze({
      surface: snapshot.surface,
      provider: snapshot.provider,
      modelId: model.modelId,
      effort,
    }));
  });
}

/**
 * Read the pinned inventory. Fails closed: an unreadable, malformed, or
 * tampered snapshot throws instead of yielding a partial pair list.
 */
export async function loadRoutingInventory({ snapshotDir = DEFAULT_SNAPSHOT_DIR } = {}) {
  const snapshots = [];
  for (const file of INVENTORY_SNAPSHOT_FILES) {
    snapshots.push(Object.freeze({ file, ...await readSnapshot(snapshotDir, file) }));
  }
  const revision = sha256(canonical(snapshots.map(({ file, provenance }) => ({
    file, digest: provenance.integrity,
  }))));
  return Object.freeze({
    revision,
    snapshots: Object.freeze(snapshots),
    pairs: Object.freeze(snapshots.flatMap(pairsOf)),
  });
}

function detectedSurfaceIds(surfaces) {
  return new Set(surfaces
    .map((surface) => (typeof surface === 'string' ? surface : (surface?.detected ? surface.id : null)))
    .filter(Boolean));
}

/**
 * Order the inventory for presentation and derive its Access-graph attestation
 * input. Detected surfaces sort first; nothing is ever removed, and every
 * attestation stays `unknown` until a probe proves otherwise.
 */
export function presentInventory(inventory, surfaces = []) {
  const detected = detectedSurfaceIds(surfaces);
  const ordered = inventory.pairs
    .map((pair, index) => ({ pair, index }))
    .sort((a, b) => (Number(detected.has(b.pair.surface)) - Number(detected.has(a.pair.surface)))
      || (a.index - b.index))
    .map(({ pair }) => pair);
  if (ordered.length !== inventory.pairs.length) {
    throw new Error('presentation reordered the inventory into a different pair set');
  }
  return Object.freeze({
    pairs: Object.freeze(ordered),
    attestations: Object.freeze(ordered.map((pair) => Object.freeze({
      surface: pair.surface,
      provider: pair.provider,
      modelId: pair.modelId,
      effort: pair.effort,
      detectedSurface: detected.has(pair.surface),
      access: UNTESTED_ACCESS,
    }))),
  });
}
