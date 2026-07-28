import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROUTING_STATUS_DOCUMENT_VERSION,
  ROUTING_STATUS_EXIT_CODES,
  routingStatus,
  routingStatusExitCode,
} from '../src/commands/routing-status.mjs';
import { renderRoutingStatus } from '../src/cli.mjs';
import { ROUTE_DECISION_STATES } from '../src/lib/routingResolver.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/routing/status/', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const NOW = '2026-07-27T00:00:00.000Z';
const CLAUDE_ENV = Object.freeze({ CLAUDE_CODE_ENTRYPOINT: 'cli' });
/** The fixture composes from the global authorization: no project narrowing. */
const IDENTITY = Object.freeze({
  key: 'routing-status-fixture', value: 'routing-status-fixture',
  source: 'project-path', confidence: 'lower', markerPath: null,
});

const intent = (name) => join(FIXTURE, `intent-${name}.txt`);

function status(argv, options = {}) {
  return routingStatus({
    argv,
    env: CLAUDE_ENV,
    now: NOW,
    consumerRoot: FIXTURE,
    profileRoot: join(FIXTURE, 'agent-workflow-kit'),
    identity: IDENTITY,
    ...options,
  });
}

/** A writable copy of the fixture world, so one case can move one fact. */
async function fixtureCopy() {
  const root = await mkdtemp(join(tmpdir(), 'awk-routing-status-'));
  await cp(FIXTURE, root, { recursive: true });
  return {
    root,
    profileRoot: join(root, 'agent-workflow-kit'),
    storage: join(root, 'agent-workflow-kit', 'routing'),
  };
}

async function patchJson(file, patch) {
  const document = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, `${JSON.stringify(patch(document), null, 2)}\n`);
}

test('an intent file resolves into a stable machine shape naming both bests', async () => {
  const { document, exitCode } = await status([
    '--json', `--intent-file=${intent('development')}`,
  ]);

  assert.equal(exitCode, 0);
  assert.equal(document.schemaVersion, ROUTING_STATUS_DOCUMENT_VERSION);
  // The machine contract: one key set, whatever the outcome.
  assert.deepEqual(Object.keys(document).sort(), [
    'bestExecutable', 'bestOverall', 'blockers', 'costPerTask', 'diagnostics',
    'evidenceBacked', 'exitCode', 'intent', 'intentMigration', 'origin', 'outcome',
    'reason', 'revisions', 'schemaVersion', 'selected', 'state', 'status', 'surface',
  ]);
  assert.equal(document.outcome, 'ready');
  assert.equal(document.exitCode, 0);
  assert.equal(document.state, 'ready');
  assert.equal(document.origin, 'evidence');
  assert.equal(document.evidenceBacked, true);
  assert.deepEqual(document.surface, { id: 'claude-code', source: 'attested' });
  assert.equal(document.intent.workload, 'development');
  // Best overall is the evidence view; best executable is what would be dispatched.
  assert.equal(document.bestOverall.status, 'resolved');
  assert.equal(document.bestOverall.route.modelId, 'opus');
  assert.equal(document.bestExecutable.modelId, 'opus');
  assert.equal(document.bestExecutable.effort, 'high');
  assert.equal(document.bestExecutable.surfaceId, 'claude-code');
  assert.deepEqual(document.costPerTask, { amount: 2.5, currency: 'USD', unit: 'attempt' });
  assert.deepEqual(document.blockers, []);
  assert.equal(document.revisions.policy.startsWith('sha256-'), true);
  assert.equal(document.revisions.catalog, 'catalog-routing-status-fixture-r1');
  assert.equal(document.revisions.accessGraph, 'access-routing-status-fixture-r1');
  assert.deepEqual(document.diagnostics, []);
});

test('a pick no evidence covers is named as a Standard route, not as evidence', async () => {
  const { document, exitCode } = await status(['--json', `--intent-file=${intent('judgment')}`]);

  assert.equal(exitCode, 0);
  assert.equal(document.origin, 'standard');
  assert.equal(document.evidenceBacked, false);
  assert.equal(document.selected.workloadClass, 'judgment');
  assert.equal(document.selected.modelId, 'opus');
  // No benchmark owner publishes a cost for a Standard route: none is claimed.
  assert.equal(document.costPerTask, null);
  assert.equal(document.bestOverall.status, 'unavailable');
  assert.equal(document.bestOverall.route, null);
  assert.equal(document.bestExecutable.origin, 'standard');
});

test('every route decision state has its own stable exit code', async () => {
  for (const state of ROUTE_DECISION_STATES) {
    assert.equal(typeof routingStatusExitCode(state), 'number', `${state} needs an exit code`);
  }
  assert.deepEqual(ROUTING_STATUS_EXIT_CODES, {
    ready: 0,
    'invalid-request': 1,
    blocked: 2,
    'approval-required': 3,
    'verification-required': 4,
    failed: 5,
  });
  assert.throws(() => routingStatusExitCode('probably-fine'), /unknown routing status outcome/);

  const unattested = await fixtureCopy();
  const graph = join(unattested.storage, 'access-graph.json');
  await patchJson(graph, (document) => ({
    ...document,
    paths: document.paths.map((path) => ({ ...path, availability: 'unknown', attestation: null })),
  }));
  const supervised = await status([`--intent-file=${intent('development')}`], {
    profileRoot: unattested.profileRoot,
  });
  assert.equal(supervised.exitCode, 4);
  assert.equal(supervised.document.outcome, 'verification-required');
  // The same unproven access blocks an unattended run instead of verifying it.
  const afk = await status([`--intent-file=${intent('afk')}`], {
    profileRoot: unattested.profileRoot,
  });
  assert.equal(afk.exitCode, 2);
  assert.equal(afk.document.outcome, 'blocked');
  assert.ok(afk.document.blockers.some((blocker) => blocker.startsWith('afk-requires-attested')));

  const asking = await fixtureCopy();
  await patchJson(join(asking.storage, 'global', 'generation-1.json'), (document) => ({
    ...document,
    document: { ...document.document, switching: 'ask' },
  }));
  const approval = await status([`--intent-file=${intent('development')}`, '--surface=codex'], {
    env: {}, profileRoot: asking.profileRoot,
  });
  assert.equal(approval.exitCode, 3);
  assert.equal(approval.document.outcome, 'approval-required');

  await rm(unattested.root, { recursive: true, force: true });
  await rm(asking.root, { recursive: true, force: true });
});

test('missing routing infrastructure blocks with named blockers and redacted diagnostics', async () => {
  const bare = await fixtureCopy();
  await rm(join(bare.storage, 'evidence-catalog.json'));
  await rm(join(bare.storage, 'access-graph.json'));

  const { document, exitCode } = await status([`--intent-file=${intent('development')}`], {
    profileRoot: bare.profileRoot,
  });

  assert.equal(exitCode, 2);
  assert.equal(document.outcome, 'blocked');
  assert.deepEqual([...document.blockers].sort(), ['missing:accessGraph', 'missing:catalog']);
  assert.deepEqual(
    document.diagnostics.map(({ code }) => code).sort(),
    ['access-graph-missing', 'evidence-catalog-missing'],
  );
  // A diagnostic never leaks where a user's files live.
  for (const { detail } of document.diagnostics) {
    assert.equal(detail.includes(bare.root), false, detail);
    assert.equal(/[\\/]/.test(detail.replace(/<path>/g, '')), false, detail);
  }
  await rm(bare.root, { recursive: true, force: true });
});

test('an unreadable intent file is an invalid request whose detail is redacted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'awk-routing-intent-'));
  const file = join(directory, 'secret-project-intent.txt');
  await writeFile(file, 'not a routing intent block\n');

  const { document, exitCode } = await status([`--intent-file=${file}`]);

  assert.equal(exitCode, 1);
  assert.equal(document.outcome, 'invalid-request');
  assert.equal(document.state, null);
  assert.equal(document.diagnostics[0].code, 'intent-file-invalid');
  assert.equal(document.diagnostics[0].detail.includes(directory), false);
  assert.equal(document.diagnostics[0].detail.includes('<path>'), true);

  const missing = await status([`--intent-file=${join(directory, 'absent.txt')}`]);
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.document.diagnostics[0].code, 'intent-file-unreadable');
  assert.equal(missing.document.diagnostics[0].detail.includes(directory), false);

  const none = await status(['--json']);
  assert.equal(none.exitCode, 1);
  assert.equal(none.document.diagnostics[0].code, 'intent-file-required');
  await rm(directory, { recursive: true, force: true });
});

test('the surface is attested or named explicitly, and a conflict is rejected', async () => {
  const argv = [`--intent-file=${intent('development')}`];

  const unattested = await status(argv, { env: {} });
  assert.equal(unattested.exitCode, 1);
  assert.equal(unattested.document.diagnostics[0].code, 'surface-required');
  assert.equal(unattested.document.surface, null);

  const explicit = await status([...argv, '--surface', 'claude-code'], { env: {} });
  assert.equal(explicit.exitCode, 0);
  assert.deepEqual(explicit.document.surface, { id: 'claude-code', source: 'explicit' });

  // An attested surface plus a different explicit one: neither wins, the run stops.
  const conflict = await status([...argv, '--surface=codex']);
  assert.equal(conflict.exitCode, 1);
  assert.equal(conflict.document.outcome, 'invalid-request');
  assert.equal(conflict.document.surface, null);
  assert.equal(conflict.document.diagnostics[0].code, 'surface-conflict');
  assert.match(conflict.document.diagnostics[0].detail, /codex/);
  assert.match(conflict.document.diagnostics[0].detail, /claude-code/);

  const unknown = await status([...argv, '--surface=vim'], { env: {} });
  assert.equal(unknown.exitCode, 1);
  assert.equal(unknown.document.diagnostics[0].code, 'unknown-surface');
});

test('the human rendering names both bests, the origin, the cost and the revisions', async () => {
  const { document, exitCode } = await status([`--intent-file=${intent('development')}`]);
  const text = renderRoutingStatus(document);

  assert.equal(exitCode, 0);
  assert.match(text, /best overall: opus/);
  assert.match(text, /best executable: opus/);
  assert.match(text, /evidence-backed/);
  assert.match(text, /cost per task: 2.5 USD per attempt/);
  assert.match(text, /blockers: none/);
  assert.match(text, /policy sha256-/);

  const standard = await status([`--intent-file=${intent('judgment')}`]);
  assert.match(renderRoutingStatus(standard.document), /standard route/i);
});

test('the CLI wires routing status to stdout and to its own exit code', async () => {
  const consumer = await mkdtemp(join(tmpdir(), 'awk-routing-consumer-'));
  const script = `
    import { runCli } from ${JSON.stringify(`file://${CLI}`)};
    process.exitCode = await runCli({
      argv: ['routing', 'status', '--json', ${JSON.stringify(`--intent-file=${intent('development')}`)}],
      consumerRoot: ${JSON.stringify(consumer)},
      hasTTY: false,
    });
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: consumer,
    encoding: 'utf8',
    input: '',
    timeout: 20_000,
    env: {
      ...process.env,
      XDG_STATE_HOME: FIXTURE,
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CODEX_THREAD_ID: '',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.outcome, 'ready');
  assert.equal(document.bestExecutable.modelId, 'opus');
  // `--json` is a machine contract: nothing but the document reaches stdout.
  assert.equal(result.stdout.trim().startsWith('{'), true);
  await rm(consumer, { recursive: true, force: true });
});
