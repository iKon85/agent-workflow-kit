import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ACCESS_GRAPH_VERSION, buildAccessGraph } from '../src/lib/routingAccessGraph.mjs';
import { claudeAccessAttestations } from '../src/lib/routingAdapters/claude.mjs';
import {
  planCapabilityProbe,
  readAccessGraphDocument,
  reconcileAccessGraph,
  recordProbeOutcome,
  writeAccessGraphDocument,
} from '../src/lib/routingAccessGraphStore.mjs';

const CAPABILITY_DATES = Object.freeze({
  revision: 'capability-r1',
  observedAt: '2026-07-28T00:00:00.000Z',
  expiresAt: '2026-07-29T00:00:00.000Z',
});

const PROBE = Object.freeze({
  id: 'capability-probe:minimal',
  sideEffectFree: true,
  cost: { amount: 0.002, currency: 'USD', unit: 'probe' },
});

const AUTHORIZATION = Object.freeze({
  id: 'probe-authorization-1',
  actor: 'account-owner',
  grantedAt: '2026-07-28T00:00:00.000Z',
});

const PAIR = Object.freeze({ providerId: 'anthropic', modelId: 'reasoning-model', effort: 'high' });

const PATH_ID = 'claude:claude-native:reasoning-model:high';

const control = (applied) =>
  ({ method: 'per-spawn', enforced: true, precedence: 'explicit-argument', applied });

const capabilityInventory = ({ effort = 'high', id = PATH_ID, verified = true } = {}) => ({
  contractVersion: 1,
  paths: [{
    id,
    surfaceId: 'claude',
    providerId: 'anthropic',
    modelId: 'reasoning-model',
    transportId: 'claude-native',
    detected: true,
    callable: true,
    permitted: verified,
    model: control('reasoning-model'),
    effort: control(effort),
  }],
});

const attestationsFor = (options) =>
  claudeAccessAttestations(capabilityInventory(options), CAPABILITY_DATES);

const storeFile = async () =>
  join(await mkdtemp(join(tmpdir(), 'awk-access-graph-')), 'access-graph.json');

const outcome = (overrides = {}) => ({
  pathId: PATH_ID,
  probe: PROBE,
  authorization: AUTHORIZATION,
  result: 'succeeded',
  observedAt: '2026-07-28T01:00:00.000Z',
  expiresAt: '2026-07-29T01:00:00.000Z',
  ...overrides,
});

test('a fresh reconcile stores every attested path as unknown access', async () => {
  const file = await storeFile();

  const first = await reconcileAccessGraph({ file, attestations: attestationsFor() });

  assert.equal(first.changed, true);
  assert.equal(first.graph.schemaVersion, ACCESS_GRAPH_VERSION);
  assert.equal(first.graph.paths.length, 1);
  assert.equal(first.graph.paths[0].effort, 'high');
  assert.equal(first.graph.paths[0].availability, 'unknown');
  assert.equal(first.graph.paths[0].attestation, null);

  const stored = await readAccessGraphDocument(file);
  assert.equal(stored.revision, first.revision);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).schemaVersion, ACCESS_GRAPH_VERSION);
  assert.equal(
    buildAccessGraph({ attestations: attestationsFor() }).revision,
    first.revision,
    'the revision is derived from the paths, not from wall-clock time',
  );

  const repeated = await reconcileAccessGraph({ file, attestations: attestationsFor() });
  assert.equal(repeated.changed, false, 'an unchanged reconcile must not churn the revision');
  assert.equal(repeated.revision, first.revision);
});

test('an unattested capability path never becomes a dispatchable access path', async () => {
  const file = await storeFile();
  const result = await reconcileAccessGraph({
    file,
    attestations: attestationsFor({ verified: false }),
  });
  assert.deepEqual(result.graph.paths, []);
});

test('an authorized probe promotes unknown to available and records dated proof', async () => {
  const file = await storeFile();
  const before = await reconcileAccessGraph({ file, attestations: attestationsFor() });

  const promoted = await recordProbeOutcome({ file, outcome: outcome() });

  assert.equal(promoted.changed, true);
  assert.equal(promoted.availability, 'available');
  assert.notEqual(promoted.revision, before.revision);
  const [path] = promoted.graph.paths;
  assert.equal(path.availability, 'available');
  assert.deepEqual(path.attestation, {
    result: 'available',
    failureKind: null,
    probeId: PROBE.id,
    authorizationId: AUTHORIZATION.id,
    observedAt: '2026-07-28T01:00:00.000Z',
    expiresAt: '2026-07-29T01:00:00.000Z',
  });
  assert.equal((await readAccessGraphDocument(file)).graph.paths[0].availability, 'available');
});

test('a deterministic authorization rejection writes the dated unavailable attestation', async () => {
  const file = await storeFile();
  await reconcileAccessGraph({ file, attestations: attestationsFor() });

  const rejected = await recordProbeOutcome({
    file,
    outcome: outcome({ result: 'failed', failureKind: 'not-authorized' }),
  });

  assert.equal(rejected.changed, true);
  assert.equal(rejected.availability, 'unavailable');
  assert.equal(rejected.graph.paths[0].attestation.result, 'unavailable');
  assert.equal(rejected.graph.paths[0].attestation.failureKind, 'not-authorized');
  assert.equal(rejected.graph.paths[0].attestation.observedAt, '2026-07-28T01:00:00.000Z');
});

test('a transient probe failure leaves the path unknown and writes nothing', async () => {
  const file = await storeFile();
  const before = await reconcileAccessGraph({ file, attestations: attestationsFor() });

  for (const failureKind of ['timeout', 'rate-limited', 'malformed-response', 'provider-failure']) {
    const inconclusive = await recordProbeOutcome({
      file,
      outcome: outcome({ result: 'failed', failureKind }),
    });

    assert.equal(inconclusive.changed, false, failureKind);
    assert.equal(inconclusive.availability, 'unknown', failureKind);
    assert.equal(inconclusive.revision, before.revision, failureKind);
    assert.match(inconclusive.reason, new RegExp(`probe-inconclusive:${failureKind}`));
    assert.equal(inconclusive.graph.paths[0].attestation, null, failureKind);
  }

  const unclassified = await recordProbeOutcome({
    file,
    outcome: outcome({ result: 'failed', failureKind: 'weather-on-the-provider-side' }),
  });
  assert.equal(unclassified.changed, false, 'an unclassified failure is never deterministic');
  assert.equal((await readAccessGraphDocument(file)).graph.paths[0].availability, 'unknown');
});

test('AFK stays blocked while a path is unknown; a supervised run may verify it', async () => {
  const file = await storeFile();
  await reconcileAccessGraph({ file, attestations: attestationsFor() });
  const plan = (afk, pair = PAIR) => planCapabilityProbe({ file, pair, afk, probe: PROBE });

  const afk = await plan(true);
  assert.equal(afk.state, 'blocked');
  assert.match(afk.reason, /afk-requires-attested-access/);
  assert.equal(afk.probe, null, 'an AFK run must not be handed a probe to run');

  const supervised = await plan(false);
  assert.equal(supervised.state, 'verification-required');
  assert.match(supervised.reason, /access-unknown/);
  assert.equal(supervised.probe.id, PROBE.id);

  const wrongEffort = await plan(false, { ...PAIR, effort: 'low' });
  assert.equal(wrongEffort.state, 'blocked');
  assert.match(wrongEffort.reason, /pair-not-attested:anthropic:reasoning-model:low/);

  await recordProbeOutcome({ file, outcome: outcome() });
  const proven = await plan(true);
  assert.equal(proven.state, 'ready', 'AFK unblocks once the proof exists');
  assert.equal(proven.path.id, PATH_ID);
});

test('an unavailable pair blocks instead of falling back to another pair', async () => {
  const file = await storeFile();
  await reconcileAccessGraph({ file, attestations: attestationsFor() });
  await recordProbeOutcome({
    file,
    outcome: outcome({ result: 'failed', failureKind: 'unsupported-effort' }),
  });

  const unavailable = await planCapabilityProbe({ file, pair: PAIR, afk: false, probe: PROBE });
  assert.equal(unavailable.state, 'blocked');
  assert.match(unavailable.reason, /route-unavailable/);
});

test('a reconcile preserves a dated attestation and never silently rewrites authorization', async () => {
  const file = await storeFile();
  await reconcileAccessGraph({ file, attestations: attestationsFor() });
  const rejected = await recordProbeOutcome({
    file,
    outcome: outcome({ result: 'failed', failureKind: 'not-authorized' }),
  });

  const rebuilt = await reconcileAccessGraph({ file, attestations: attestationsFor() });
  assert.equal(rebuilt.changed, false);
  assert.equal(rebuilt.graph.paths[0].availability, 'unavailable');
  assert.deepEqual(rebuilt.graph.paths[0].attestation, rejected.graph.paths[0].attestation);

  const movedEffort = await reconcileAccessGraph({
    file,
    attestations: attestationsFor({ effort: 'low', id: 'claude:claude-native:reasoning-model:low' }),
  });
  assert.equal(movedEffort.graph.paths[0].effort, 'low');
  assert.equal(
    movedEffort.graph.paths[0].availability,
    'unknown',
    'a different pair inherits no attestation from another pair',
  );
});

test('an access graph write with a stale expected revision is rejected', async () => {
  const file = await storeFile();
  const first = await reconcileAccessGraph({ file, attestations: attestationsFor() });
  const second = await recordProbeOutcome({ file, outcome: outcome() });
  assert.notEqual(second.revision, first.revision);

  await assert.rejects(
    () => writeAccessGraphDocument(file, second.graph, { expectedRevision: first.revision }),
    /stale access graph revision/,
  );
  await assert.rejects(
    () => writeAccessGraphDocument(file, second.graph, { expectedRevision: null }),
    /stale access graph revision/,
  );

  const untouched = await readAccessGraphDocument(file);
  assert.equal(untouched.revision, second.revision);
});

test('a held store lock fails the write instead of racing it', async () => {
  const file = await storeFile();
  const { graph, revision } = await reconcileAccessGraph({ file, attestations: attestationsFor() });
  await mkdir(`${file}.lock`);

  await assert.rejects(
    () => writeAccessGraphDocument(file, graph, { expectedRevision: revision, lockTimeoutMs: 20 }),
    /access graph store is locked/,
  );
});

test('a corrupt access graph document fails closed instead of resetting the graph', async () => {
  const file = await storeFile();
  await writeFile(file, '{ not json', 'utf8');

  await assert.rejects(() => readAccessGraphDocument(file), /access graph document is not valid JSON/);
  await assert.rejects(
    () => reconcileAccessGraph({ file, attestations: attestationsFor() }),
    /access graph document is not valid JSON/,
  );
});

test('a capability probe stays minimal, side-effect-free, cost-visible and task-free', async () => {
  const file = await storeFile();
  await reconcileAccessGraph({ file, attestations: attestationsFor() });
  const plan = (probe) => planCapabilityProbe({ file, pair: PAIR, afk: false, probe });
  const { cost: _cost, ...costless } = PROBE;

  await assert.rejects(
    () => plan({ ...PROBE, prompt: 'implement the slice' }),
    /capability probe must carry no consumer task data: prompt/,
  );
  await assert.rejects(
    () => plan({ ...PROBE, sideEffectFree: false }),
    /capability probe must be side-effect-free/,
  );
  await assert.rejects(() => plan(costless), /capability probe cost/);
  await assert.rejects(
    () => recordProbeOutcome({ file, outcome: { ...outcome(), authorization: undefined } }),
    /probe authorization/,
  );
  await assert.rejects(
    () => recordProbeOutcome({ file, outcome: outcome({ pathId: 'claude:claude-native:absent:high' }) }),
    /probe outcome names an unknown access path/,
  );
});
