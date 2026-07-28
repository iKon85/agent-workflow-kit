/**
 * The Access-graph store — the locked, atomic, revisioned home of the user-local
 * Access graph, plus the capability-probe lifecycle that moves one pair from
 * `unknown` to `available` or `unavailable`.
 *
 * Every write is compare-and-swap against the revision the caller read, so two
 * concurrent dispatches cannot each record an attestation the other never saw.
 * A stale expected revision is rejected, never merged; a held lock fails the
 * write instead of racing it; and a document that will not parse fails closed
 * rather than resetting the graph to empty.
 *
 * Only a deterministic unsupported or authorization failure may mutate
 * availability. Every other probe failure returns the graph untouched, so one
 * bad minute cannot poison it.
 */
import { mkdir, readFile, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { writeAtomic } from './atomicWrite.mjs';
import {
  buildAccessGraph,
  resolveAccessRoute,
  sealAccessGraph,
  validateAccessGraph,
} from './routingAccessGraph.mjs';

/** User-local routing evidence: owner-only, like every other routing document. */
const STORE_MODE = 0o600;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_POLL_MS = 10;

/**
 * The probe failure taxonomy, typed by what a failure actually proves.
 * `deterministic` kinds are the only ones allowed to mutate availability.
 */
export const PROBE_FAILURE_KINDS = Object.freeze({
  'unsupported-model': 'deterministic',
  'unsupported-effort': 'deterministic',
  'not-authorized': 'deterministic',
  timeout: 'transient',
  'rate-limited': 'transient',
  'malformed-response': 'transient',
  'provider-failure': 'transient',
});

const PROBE_FIELDS = new Set(['id', 'sideEffectFree', 'cost']);

const AUTHORIZATION_FIELDS = new Set(['id', 'actor', 'grantedAt']);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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

function timestamp(value, field) {
  string(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return value;
}

function closedFields(value, allowed, message) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${message}: ${key}`);
  }
  return value;
}

/**
 * A capability probe is minimal, side-effect-free and cost-visible, and it
 * carries no consumer task data — the closed field set is what enforces that.
 */
export function validateCapabilityProbe(probe) {
  object(probe, 'capability probe');
  closedFields(probe, PROBE_FIELDS, 'capability probe must carry no consumer task data');
  if (probe.sideEffectFree !== true) {
    throw new TypeError('capability probe must be side-effect-free');
  }
  const cost = object(probe.cost, 'capability probe cost');
  if (!Number.isFinite(cost.amount) || cost.amount < 0) {
    throw new TypeError('capability probe cost.amount must be a non-negative number');
  }
  return Object.freeze({
    id: string(probe.id, 'capability probe id'),
    sideEffectFree: true,
    cost: Object.freeze({
      amount: cost.amount,
      currency: string(cost.currency, 'capability probe cost.currency'),
      unit: string(cost.unit, 'capability probe cost.unit'),
    }),
  });
}

/** A probe only runs, and only mutates the graph, under a named authorization. */
export function validateProbeAuthorization(authorization) {
  object(authorization, 'probe authorization');
  closedFields(authorization, AUTHORIZATION_FIELDS, 'unknown probe authorization field');
  return Object.freeze({
    id: string(authorization.id, 'probe authorization id'),
    actor: string(authorization.actor, 'probe authorization actor'),
    grantedAt: timestamp(authorization.grantedAt, 'probe authorization grantedAt'),
  });
}

/** Type one probe failure. Anything untyped stays transient by construction. */
export function classifyProbeFailure(kind) {
  const named = typeof kind === 'string' && kind.trim() !== '' ? kind : 'unclassified';
  const determinism = PROBE_FAILURE_KINDS[named] === 'deterministic'
    ? 'deterministic'
    : 'transient';
  return Object.freeze({
    kind: named,
    determinism,
    mutatesAvailability: determinism === 'deterministic',
  });
}

function attestedPaths(paths, index, attestation) {
  return paths.map((path, position) => (position === index
    ? { ...path, availability: attestation.result, attestation }
    : path));
}

/**
 * Apply one authorized probe result to a graph. Success attests `available`, a
 * deterministic failure writes the dated `unavailable` attestation, and every
 * other failure returns the graph untouched.
 */
export function applyProbeOutcome(graph, outcome) {
  const current = validateAccessGraph(graph);
  object(outcome, 'probe outcome');
  const pathId = string(outcome.pathId, 'probe outcome pathId');
  const probe = validateCapabilityProbe(outcome.probe);
  const authorization = validateProbeAuthorization(outcome.authorization);
  const observedAt = timestamp(outcome.observedAt, 'probe outcome observedAt');
  const expiresAt = timestamp(outcome.expiresAt, 'probe outcome expiresAt');
  if (outcome.result !== 'succeeded' && outcome.result !== 'failed') {
    throw new TypeError('probe outcome result must be one of: succeeded, failed');
  }
  const index = current.paths.findIndex((path) => path.id === pathId);
  if (index < 0) throw new TypeError(`probe outcome names an unknown access path: ${pathId}`);
  const failure = outcome.result === 'failed' ? classifyProbeFailure(outcome.failureKind) : null;
  if (failure && !failure.mutatesAvailability) {
    return Object.freeze({
      graph: current,
      changed: false,
      availability: current.paths[index].availability,
      failure,
      reason: `probe-inconclusive:${failure.kind}`,
    });
  }
  const availability = outcome.result === 'succeeded' ? 'available' : 'unavailable';
  const next = sealAccessGraph(attestedPaths(current.paths, index, {
    result: availability,
    failureKind: failure?.kind ?? null,
    probeId: probe.id,
    authorizationId: authorization.id,
    observedAt,
    expiresAt,
  }));
  return Object.freeze({
    graph: next,
    changed: next.revision !== current.revision,
    availability,
    failure,
    reason: `probe-${availability}:${pathId}`,
  });
}

/** Read the stored graph. Missing is `null`; unreadable or invalid throws. */
export async function readAccessGraphDocument(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`access graph document is not valid JSON: ${file}`);
  }
  const graph = validateAccessGraph(parsed);
  return Object.freeze({ graph, revision: graph.revision });
}

async function withStoreLock(file, lockTimeoutMs, run) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`access graph store is locked: ${lock}`);
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await run();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

/**
 * Compare-and-swap write. `expectedRevision` is the revision the caller read,
 * or `null` for a first write; anything else is a stale write and is rejected.
 */
export async function writeAccessGraphDocument(file, graph, options = {}) {
  const next = validateAccessGraph(graph);
  const { expectedRevision, lockTimeoutMs = LOCK_TIMEOUT_MS } = options;
  if (expectedRevision !== null && typeof expectedRevision !== 'string') {
    throw new TypeError('access graph write requires an expected revision (null for a first write)');
  }
  await mkdir(dirname(file), { recursive: true });
  return withStoreLock(file, lockTimeoutMs, async () => {
    const found = (await readAccessGraphDocument(file))?.revision ?? null;
    if (found !== expectedRevision) {
      throw new Error(
        `stale access graph revision: expected ${expectedRevision ?? 'none'}, `
        + `found ${found ?? 'none'}`,
      );
    }
    await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`, STORE_MODE);
    return Object.freeze({ path: file, graph: next, revision: next.revision });
  });
}

/**
 * Rebuild the graph from the current surface attestations and store it. An
 * unchanged rebuild is a no-op: the revision is content-derived, so nothing is
 * written and every recorded attestation survives.
 */
export async function reconcileAccessGraph({
  file,
  attestations,
  effortDomains = null,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
}) {
  const current = await readAccessGraphDocument(file);
  const next = buildAccessGraph({
    attestations,
    previous: current?.graph ?? null,
    effortDomains,
  });
  if (current?.revision === next.revision) {
    return Object.freeze({ graph: current.graph, revision: current.revision, changed: false });
  }
  const written = await writeAccessGraphDocument(file, next, {
    expectedRevision: current?.revision ?? null,
    lockTimeoutMs,
  });
  return Object.freeze({ graph: written.graph, revision: written.revision, changed: true });
}

/**
 * Ask what one pair may do now. A supervised run gets the validated probe to
 * run; an AFK run stays blocked until the proof exists.
 */
export async function planCapabilityProbe({ file, pair, afk = false, probe }) {
  const validated = validateCapabilityProbe(probe);
  const current = await readAccessGraphDocument(file);
  if (!current) throw new Error(`access graph document is missing: ${file}`);
  const route = resolveAccessRoute(current.graph, pair, { afk });
  return Object.freeze({
    ...route,
    revision: current.revision,
    probe: route.state === 'verification-required' ? validated : null,
  });
}

/**
 * Record one authorized probe result. A deterministic failure writes the dated
 * unavailable attestation; every other failure leaves the stored graph alone.
 */
export async function recordProbeOutcome({ file, outcome, lockTimeoutMs = LOCK_TIMEOUT_MS }) {
  const current = await readAccessGraphDocument(file);
  if (!current) throw new Error(`access graph document is missing: ${file}`);
  const applied = applyProbeOutcome(current.graph, outcome);
  if (!applied.changed) return Object.freeze({ ...applied, revision: current.revision });
  const written = await writeAccessGraphDocument(file, applied.graph, {
    expectedRevision: current.revision,
    lockTimeoutMs,
  });
  return Object.freeze({ ...applied, revision: written.revision });
}
