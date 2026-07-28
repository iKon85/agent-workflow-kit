import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { surfaceById } from '../src/lib/agentSurfaceRegistry.mjs';
import { buildAccessGraph, resolveAccessRoute } from '../src/lib/routingAccessGraph.mjs';
import {
  readAccessGraphDocument,
  recordProbeOutcome,
} from '../src/lib/routingAccessGraphStore.mjs';
import { loadRoutingInventory } from '../src/lib/routingInventory.mjs';
import {
  attestHostCapabilities,
  buildHostCapabilityInventory,
  hostCapabilityPathId,
  inventoryEffortDomains,
  refreshAccessGraph,
} from '../src/lib/routingHostCapabilities.mjs';

const OBSERVED_AT = '2026-07-28T00:00:00.000Z';
const EXPIRES_AT = '2026-07-29T00:00:00.000Z';

/** The one pinned pair the fixtures observe end to end. */
const OPUS_PAIR = Object.freeze({ providerId: 'anthropic', modelId: 'opus', effort: 'high' });
const OPUS_PATH_ID = 'claude-code:native:opus:high';

const PROBE = Object.freeze({
  id: 'capability-probe:minimal',
  sideEffectFree: true,
  cost: { amount: 0.002, currency: 'USD', unit: 'probe' },
});

const AUTHORIZATION = Object.freeze({
  id: 'probe-authorization-1',
  actor: 'account-owner',
  grantedAt: OBSERVED_AT,
});

/** A fully observed host route: every fact the surface adapter needs to verify. */
const routeFacts = (modelId, effort) => ({
  callable: true,
  permitted: true,
  model: { enforced: true, precedence: 'explicit-argument', applied: modelId },
  effort: { enforced: true, precedence: 'explicit-argument', applied: effort },
});

const claudeEvidence = (routes = { [OPUS_PATH_ID]: routeFacts('opus', 'high') }) =>
  ({ observedAt: OBSERVED_AT, expiresAt: EXPIRES_AT, routes });

const codexEvidence = (spawnSchema, routes) => ({
  observedAt: OBSERVED_AT,
  expiresAt: EXPIRES_AT,
  host: { id: 'codex', version: '1.0.0-fixture' },
  spawnSchema,
  routes,
});

const pinnedPair = (surface, provider, modelId, effort, detectedSurface = true) =>
  ({ surface, provider, modelId, effort, detectedSurface, access: 'unknown' });

const CLAUDE_PAIR = pinnedPair('claude-code', 'anthropic', 'opus', 'high');
const CODEX_PAIR = pinnedPair('codex', 'openai', 'gpt-5.6-sol', 'low');

const storeFile = async () =>
  join(await mkdtemp(join(tmpdir(), 'awk-host-capabilities-')), 'access-graph.json');

const detectEverything = async () => true;

const refresh = (file, hostEvidence) =>
  refreshAccessGraph({ file, hostEvidence, commandAvailable: detectEverything });

test('the producer emits one path per inventory pair and registry transport', () => {
  const pairs = [CLAUDE_PAIR, CODEX_PAIR];

  const capabilities = buildHostCapabilityInventory({ pairs });

  assert.equal(capabilities.contractVersion, 1);
  assert.deepEqual(
    capabilities.paths.map((path) => path.id),
    pairs.flatMap((pair) => surfaceById(pair.surface).adapter.transports.map((transportId) =>
      hostCapabilityPathId({
        surfaceId: pair.surface, transportId, modelId: pair.modelId, effort: pair.effort,
      }))),
  );
  for (const path of capabilities.paths) {
    const { enforcement } = surfaceById(path.surfaceId).adapter;
    assert.equal(path.model.method, enforcement.model, 'the model method is read from the registry');
    assert.equal(path.effort.method, enforcement.effort, 'the effort method is read from the registry');
    assert.equal(path.providerId, path.surfaceId === 'codex' ? 'openai' : 'anthropic');
  }
});

test('the Claude surface gets no claude-cli transport path — issue #372', () => {
  const capabilities = buildHostCapabilityInventory({ pairs: [CLAUDE_PAIR, CODEX_PAIR] });
  const transportsOf = (surfaceId) => capabilities.paths
    .filter((path) => path.surfaceId === surfaceId).map((path) => path.transportId);

  assert.equal(transportsOf('claude-code').includes('claude-cli'), false);
  // Positive control: the apparatus does report a claude-cli path where the
  // registry lists one, so the absence above measures the registry, not the test.
  assert.equal(transportsOf('codex').includes('claude-cli'), true);
});

test('an undetected surface relays no callable or permitted claim', () => {
  const routes = { [OPUS_PATH_ID]: routeFacts('opus', 'high') };
  const hostEvidence = { 'claude-code': claudeEvidence(routes) };
  const observed = (detectedSurface) => buildHostCapabilityInventory({
    pairs: [{ ...CLAUDE_PAIR, detectedSurface }],
    hostEvidence,
  }).paths.find((path) => path.id === OPUS_PATH_ID);

  const undetected = observed(false);
  assert.equal(undetected.detected, false);
  assert.equal(undetected.callable, 'unknown');
  assert.equal(undetected.permitted, 'unknown');
  assert.equal(undetected.model.applied, 'unknown');

  // Positive control: the same claim on a detected surface does come through.
  const detected = observed(true);
  assert.equal(detected.detected, true);
  assert.equal(detected.callable, true);
  assert.equal(detected.permitted, true);
});

test('an unobserved host fact leaves the path unattested and out of the graph', () => {
  const capabilities = buildHostCapabilityInventory({ pairs: [CLAUDE_PAIR] });

  const attested = attestHostCapabilities({
    capabilities,
    hostEvidence: { 'claude-code': claudeEvidence({}) },
    revision: 'host-capability-fixture',
  });

  assert.equal(attested.attestations.length, capabilities.paths.length);
  for (const record of attested.attestations) {
    assert.equal(record.attested, false);
    assert.ok(record.attestationFailures.includes('transport is not callable'));
    assert.ok(record.attestationFailures.includes('effort applied value is unverified'));
  }
  assert.deepEqual(buildAccessGraph({ attestations: attested.attestations }).paths, []);
});

test('a surface the host evidence never mentions contributes no attestation', () => {
  const capabilities = buildHostCapabilityInventory({ pairs: [CLAUDE_PAIR, CODEX_PAIR] });

  const attested = attestHostCapabilities({
    capabilities,
    hostEvidence: { 'claude-code': claudeEvidence() },
    revision: 'host-capability-fixture',
  });

  assert.deepEqual(attested.unobservedSurfaces, ['codex']);
  assert.deepEqual([...new Set(attested.attestations.map((record) => record.surfaceId))],
    ['claude-code']);
});

test('the module asserts no host capability of its own', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../src/lib/routingHostCapabilities.mjs', import.meta.url)), 'utf8',
  );
  const asserted = /(callable|permitted|enforced|verified|attested)\s*:\s*true/;

  assert.equal(asserted.test(source), false);
  // Positive control: the pattern does catch an asserted capability.
  assert.equal(asserted.test('callable: true'), true);
});

test('the Codex envelope reaches the Codex adapter — a schema without selectors attests nothing', () => {
  const routes = Object.fromEntries(surfaceById('codex').adapter.transports.map((transportId) => [
    hostCapabilityPathId({
      surfaceId: 'codex',
      transportId,
      modelId: CODEX_PAIR.modelId,
      effort: CODEX_PAIR.effort,
    }),
    routeFacts(CODEX_PAIR.modelId, CODEX_PAIR.effort),
  ]));
  const attest = (spawnSchema) => {
    const hostEvidence = { codex: codexEvidence(spawnSchema, routes) };
    return attestHostCapabilities({
      capabilities: buildHostCapabilityInventory({ pairs: [CODEX_PAIR], hostEvidence }),
      hostEvidence,
      revision: 'host-capability-fixture',
    }).attestations.map((record) => record.attested);
  };

  assert.deepEqual(attest({ properties: { message: {} } }), [false, false]);
  // Positive control: a schema that does expose both selectors attests the pair.
  assert.deepEqual(attest({ properties: { model: {}, model_reasoning_effort: {} } }), [true, true]);
});

test('a pair naming a surface the registry does not know fails closed', () => {
  assert.throws(
    () => buildHostCapabilityInventory({ pairs: [pinnedPair('ghost', 'anthropic', 'opus', 'high')] }),
    /no surface: ghost/,
  );
  assert.throws(() => buildHostCapabilityInventory({ pairs: null }), /must be an array/);
});

test('the pinned effort domains cover every model, effort axis or not', async () => {
  const domains = inventoryEffortDomains(await loadRoutingInventory());

  assert.deepEqual(domains['anthropic:opus'], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(domains['anthropic:haiku'], [null]);
});

test('a refresh writes a readable graph and an unchanged rerun writes nothing', async () => {
  const file = await storeFile();

  const first = await refresh(file, { 'claude-code': claudeEvidence() });

  assert.equal(first.changed, true);
  assert.deepEqual(first.unobservedSurfaces, ['codex']);
  assert.equal(first.detectedSurfaces.length, 2);
  assert.ok(first.capabilities.paths.length > first.graph.paths.length);

  const stored = await readAccessGraphDocument(file);
  assert.equal(stored.revision, first.revision);
  assert.deepEqual(stored.graph.paths.map((path) => path.id), [OPUS_PATH_ID]);
  for (const path of stored.graph.paths) {
    assert.equal(path.availability, 'unknown');
    assert.equal(path.attestation, null);
  }

  const repeated = await refresh(file, { 'claude-code': claudeEvidence() });
  assert.equal(repeated.changed, false, 'an unchanged refresh must not churn the revision');
  assert.equal(repeated.revision, first.revision);
});

test('a refresh with no observed host writes an honest empty graph', async () => {
  const file = await storeFile();

  const result = await refresh(file, {});

  assert.deepEqual(result.graph.paths, []);
  assert.deepEqual(result.unobservedSurfaces, ['claude-code', 'codex']);
  assert.ok(result.capabilities.paths.length > 0, 'the producer still enumerates every path');
  assert.equal((await readAccessGraphDocument(file)).revision, result.revision);
});

test('a written path resolves as verification-required, and blocked when AFK', async () => {
  const file = await storeFile();

  const { graph } = await refresh(file, { 'claude-code': claudeEvidence() });

  assert.deepEqual(resolveAccessRoute(graph, OPUS_PAIR), {
    state: 'verification-required', path: graph.paths[0], reason: `access-unknown:${OPUS_PATH_ID}`,
  });
  assert.deepEqual(resolveAccessRoute(graph, OPUS_PAIR, { afk: true }), {
    state: 'blocked', path: graph.paths[0], reason: `afk-requires-attested-access:${OPUS_PATH_ID}`,
  });
});

test('a recorded availability survives the next refresh', async () => {
  const file = await storeFile();
  await refresh(file, { 'claude-code': claudeEvidence() });

  const probed = await recordProbeOutcome({
    file,
    outcome: {
      pathId: OPUS_PATH_ID,
      probe: PROBE,
      authorization: AUTHORIZATION,
      result: 'succeeded',
      observedAt: OBSERVED_AT,
      expiresAt: EXPIRES_AT,
    },
  });
  assert.equal(probed.availability, 'available');

  const rebuilt = await refresh(file, { 'claude-code': claudeEvidence() });

  assert.equal(rebuilt.changed, false);
  assert.equal(rebuilt.graph.paths[0].availability, 'available');
  assert.equal(rebuilt.graph.paths[0].attestation.probeId, PROBE.id);
  assert.deepEqual(resolveAccessRoute(rebuilt.graph, OPUS_PAIR).state, 'ready');
});
