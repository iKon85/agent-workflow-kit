/**
 * The host bridge per (surface, transport): the census, the security boundary,
 * and the readback that proves which pair the host actually applied.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cleanup, makeEmptyDir } from './helpers.mjs';
import { AGENT_SURFACE_REGISTRY } from '../src/lib/agentSurfaceRegistry.mjs';
import { loadRoutingInventory } from '../src/lib/routingInventory.mjs';
import {
  CHILD_ENV_ALLOWLIST,
  assertArgvSafe,
  assertBoundedCwd,
  childEnvironment,
  createBridgedRoutingAdapter,
  hostTransportCensus,
} from '../src/lib/routingAdapters/hostBridge.mjs';
import { CLAUDE_CLI_HOST, claudeProjectSlug } from '../src/lib/routingAdapters/claude.mjs';
import { CODEX_CLI_HOST } from '../src/lib/routingAdapters/codex.mjs';

const TASK = 'Bridge slice 22b — this text must never reach argv: --model opus --effort max';
const RUN_ID = '6b1f2c34-9a5e-4d78-8b21-0f3c5d7e9a10';
const THREAD_ID = '019fa77c-3db2-72b1-aa7e-1ba26ccb99dc';

/** Cross-provider by construction: each surface reaches the other host's models. */
const CLAUDE_OVER_CODEX = Object.freeze({
  surfaceId: 'codex', providerId: 'anthropic', modelId: 'opus',
  effort: 'high', transportId: 'claude-cli',
});
const CODEX_OVER_CLAUDE = Object.freeze({
  surfaceId: 'claude-code', providerId: 'openai', modelId: 'gpt-5.6-sol',
  effort: 'high', transportId: 'codex-cli',
});

const routingInventory = await loadRoutingInventory();

function capabilityInventory(route) {
  const control = (applied) => ({
    method: 'per-spawn', enforced: true, precedence: 'explicit-argument', applied,
  });
  return {
    contractVersion: 1,
    observedAt: '2026-07-28T00:00:00.000Z',
    host: { id: 'host-bridge-fixture', version: '1' },
    spawnSchema: { type: 'object', properties: { model: {}, reasoning_effort: {} } },
    paths: [{
      id: `${route.surfaceId}/${route.transportId}`,
      surfaceId: route.surfaceId,
      providerId: route.providerId,
      modelId: route.modelId,
      transportId: route.transportId,
      detected: true, callable: true, permitted: true,
      model: control(route.modelId), effort: control(route.effort),
    }],
  };
}

function harness(route, options = {}) {
  const calls = [];
  const adapter = createBridgedRoutingAdapter({
    surfaceId: route.surfaceId,
    capabilityInventory: capabilityInventory(route),
    routingInventory,
    task: options.task ?? TASK,
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot ?? options.cwd,
    home: options.home,
    runId: RUN_ID,
    env: options.env ?? {},
    runChild: async (command, argv, spawnOptions) => {
      calls.push({ command, argv, options: spawnOptions });
      return options.runChild ? options.runChild({ command, argv }) : { stdout: '', stderr: '' };
    },
  });
  return { adapter, calls, dispatch: async () => (await adapter.prepare(route)).dispatch() };
}

async function writeTranscript(home, cwd, { model, effort }) {
  const dir = join(home, '.claude', 'projects', claudeProjectSlug(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${RUN_ID}.jsonl`), [
    JSON.stringify({ type: 'user', effort, sessionId: RUN_ID }),
    JSON.stringify({ type: 'assistant', message: { model } }),
  ].join('\n') + '\n');
}

async function writeRollout(home, { model, effort }) {
  const dir = join(home, '.codex', 'sessions', '2026', '07', '28');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-2026-07-28T10-00-00-${THREAD_ID}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: THREAD_ID } }),
    JSON.stringify({ type: 'turn_context', payload: { model, effort } }),
  ].join('\n') + '\n');
}

const codexStdout = (...extra) => [
  JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID }), ...extra,
].join('\n') + '\n';

const rejects = (promise, message) =>
  assert.rejects(promise, (error) => error.message === message);

test('the census accounts for every registry (surface, transport) pair', () => {
  const census = hostTransportCensus();
  const registryPairs = AGENT_SURFACE_REGISTRY
    .flatMap((surface) => surface.adapter.transports.map((t) => `${surface.id}/${t}`));

  assert.deepEqual(census.map((e) => `${e.surfaceId}/${e.transportId}`).sort(),
    [...registryPairs].sort());
  assert.equal(census.filter((e) => e.status === 'bridged').length, 2);
  assert.equal(census.filter((e) => e.status === 'unavailable').length, 2);
  for (const entry of census.filter((e) => e.status === 'unavailable')) {
    assert.ok(entry.reason && entry.evidence && entry.observedAt);
  }
  // Verify-spike 18c: the in-session Agent primitive has no effort axis at all.
  assert.deepEqual(
    census.find((e) => e.surfaceId === 'claude-code' && e.transportId === 'native').status,
    'unavailable',
  );
});

test('the census fails closed on a transport with neither bridge nor attestation', () => {
  const registry = [{
    id: 'claude-code',
    adapter: { transports: ['native', 'codex-cli', 'telepathy'] },
  }];
  assert.throws(() => hostTransportCensus({ registry }), /telepathy/);
});

test('a bridged dispatch passes the task on stdin and never in argv', async () => {
  const home = await makeEmptyDir();
  const cwd = await makeEmptyDir();
  await writeTranscript(home, cwd, { model: 'claude-opus-5', effort: 'high' });
  const h = harness(CLAUDE_OVER_CODEX, { home, cwd });

  const result = await h.dispatch();

  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.equal(call.command, 'claude');
  assert.ok(Array.isArray(call.argv) && call.argv.every((a) => typeof a === 'string'));
  assert.ok(!call.argv.some((a) => a.includes(TASK)), 'task text leaked into argv');
  assert.equal(call.options.stdin, TASK);
  assert.equal(call.options.shell, undefined);
  assert.deepEqual(call.argv.filter((a, i) => ['--model', '--effort', '--session-id']
    .includes(call.argv[i - 1])), ['opus', RUN_ID, 'high']);
  assert.equal(result.taskId, RUN_ID);
  assert.equal(result.attestationStrength, 'provider-attested');
  await cleanup(home, cwd);
});

test('a pair the pinned inventory does not carry never reaches the host', async () => {
  const cases = [
    [{ ...CLAUDE_OVER_CODEX, modelId: 'opus-9-imaginary' },
      'host bridge pair is not in the pinned inventory'],
    [{ ...CLAUDE_OVER_CODEX, modelId: 'haiku' },
      'host bridge effort is outside the model effort domain'],
    [{ ...CODEX_OVER_CLAUDE, modelId: 'gpt-5.6-luna', effort: 'ultra' },
      'host bridge effort is outside the model effort domain'],
  ];
  for (const [route, message] of cases) {
    const cwd = await makeEmptyDir();
    const h = harness(route, { home: cwd, cwd });
    await rejects(h.dispatch(), message);
    assert.equal(h.calls.length, 0, `${message}: the host was spawned anyway`);
    await cleanup(cwd);
  }
});

test('a cwd outside the authorized workspace is refused before the spawn', async () => {
  const workspaceRoot = await makeEmptyDir();
  const outside = await makeEmptyDir();
  assert.equal(assertBoundedCwd(join(workspaceRoot, 'pkg'), workspaceRoot),
    join(workspaceRoot, 'pkg'));
  assert.throws(() => assertBoundedCwd(outside, workspaceRoot),
    /host bridge cwd is outside the authorized workspace/);

  const h = harness(CLAUDE_OVER_CODEX, { home: workspaceRoot, cwd: outside, workspaceRoot });
  await rejects(h.dispatch(), 'host bridge cwd is outside the authorized workspace');
  assert.equal(h.calls.length, 0);
  await cleanup(workspaceRoot, outside);
});

test('the child environment is an allowlist, not the credential-rich parent', async () => {
  const home = await makeEmptyDir();
  const cwd = await makeEmptyDir();
  await writeTranscript(home, cwd, { model: 'claude-opus-5', effort: 'high' });
  const env = {
    PATH: '/usr/bin', HOME: home, ANTHROPIC_API_KEY: 'sk-secret',
    OPENAI_API_KEY: 'sk-other', GH_TOKEN: 'ghp-secret',
  };
  const h = harness(CLAUDE_OVER_CODEX, { home, cwd, env });

  await h.dispatch();

  assert.deepEqual(Object.keys(h.calls[0].options.env).sort(), ['HOME', 'PATH']);
  assert.deepEqual(childEnvironment(env), { PATH: '/usr/bin', HOME: home });
  assert.ok(!CHILD_ENV_ALLOWLIST.some((name) => /KEY|TOKEN|SECRET/.test(name)));
  await cleanup(home, cwd);
});

test('a host failure is redacted to a closed reason before it can be logged', async () => {
  const cwd = await makeEmptyDir();
  const h = harness(CLAUDE_OVER_CODEX, {
    home: cwd,
    cwd,
    runChild: () => {
      throw new Error(`spawn claude: ANTHROPIC_API_KEY=sk-secret leaked from ${cwd}`);
    },
  });

  await assert.rejects(h.dispatch(), (error) => {
    assert.equal(error.message, 'host bridge child exited with a failure');
    assert.ok(!error.message.includes('sk-secret') && !error.message.includes(cwd));
    return true;
  });
  await cleanup(cwd);
});

test('an argv that carries the task text or destroys the readback is refused', () => {
  assert.throws(() => assertArgvSafe(CLAUDE_CLI_HOST, ['--model', `opus ${TASK}`], TASK),
    /host bridge refuses task text in argv/);
  assert.throws(() => assertArgvSafe(CODEX_CLI_HOST, ['exec', '--ephemeral', '-'], TASK),
    /host bridge refuses an argument that destroys the readback channel/);
  assert.throws(() => assertArgvSafe({ ...CLAUDE_CLI_HOST, command: 'claude -p | tee log' }, [], TASK),
    /host bridge refuses a shell invocation/);
  assert.throws(() => assertArgvSafe(CLAUDE_CLI_HOST, '--model opus', TASK),
    /host bridge refuses a shell invocation/);
});

test('the Claude readback identifies a server-returned alias and blocks a mismatch', async () => {
  const home = await makeEmptyDir();
  const cwd = await makeEmptyDir();
  await writeTranscript(home, cwd, { model: 'claude-opus-5', effort: 'high' });
  assert.equal((await harness(CLAUDE_OVER_CODEX, { home, cwd }).dispatch()).taskId, RUN_ID);

  await writeTranscript(home, cwd, { model: 'claude-opus-5', effort: 'low' });
  await rejects(harness(CLAUDE_OVER_CODEX, { home, cwd }).dispatch(),
    'host bridge applied pair differs from the requested pair');

  await writeTranscript(home, cwd, { model: 'claude-sonnet-5', effort: 'high' });
  await rejects(harness(CLAUDE_OVER_CODEX, { home, cwd }).dispatch(),
    'host bridge could not read back the applied pair');
  await cleanup(home, cwd);
});

test('the Codex readback reads the rollout turn_context and is only client-attested', async () => {
  const home = await makeEmptyDir();
  const cwd = await makeEmptyDir();
  await writeRollout(home, { model: 'gpt-5.6-sol', effort: 'high' });
  const h = harness(CODEX_OVER_CLAUDE, { home, cwd, runChild: () => ({ stdout: codexStdout() }) });

  const result = await h.dispatch();

  assert.equal(h.calls[0].command, 'codex');
  assert.ok(!h.calls[0].argv.includes('--ephemeral'));
  assert.ok(h.calls[0].argv.includes('-c'));
  assert.ok(h.calls[0].argv.includes('model_reasoning_effort="high"'));
  assert.equal(result.taskId, THREAD_ID);
  assert.equal(result.attestationStrength, 'client-attested');
  await cleanup(home, cwd);
});

test('a soft Codex model-metadata degradation blocks instead of reading as a clean run', async () => {
  const home = await makeEmptyDir();
  const cwd = await makeEmptyDir();
  await writeRollout(home, { model: 'gpt-5.6-sol', effort: 'high' });
  const degraded = JSON.stringify({
    type: 'item.completed',
    item: { type: 'error', message: 'Model metadata for gpt-5.6-sol not found. Defaulting to fallback metadata' },
  });
  const h = harness(CODEX_OVER_CLAUDE, {
    home, cwd, runChild: () => ({ stdout: codexStdout(degraded) }),
  });

  await rejects(h.dispatch(), 'host bridge run was degraded by the host');
  await cleanup(home, cwd);
});

test('an attested-unavailable transport carries no dispatcher at all', async () => {
  const cwd = await makeEmptyDir();
  const route = { ...CLAUDE_OVER_CODEX, transportId: 'native' };
  const h = harness(route, { home: cwd, cwd });

  await rejects(h.adapter.prepare(route), 'transport has no approved dispatcher: native');
  await cleanup(cwd);
});
