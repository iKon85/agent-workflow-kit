import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runMemoryLifecycle,
  setupMemoryLifecycle,
} from '../../scripts/memory-lifecycle/index.mjs';
import { init } from '../../src/commands/init.mjs';
import { reconcile } from '../../src/lib/updateReconcile.mjs';
import { cleanup, makeKit } from '../helpers.mjs';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test('explicit opt-in seeds missing policies once and adopts existing consumer content', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'memory-setup-'));
  const policyRoot = join(projectRoot, '.memory', 'active');
  await mkdir(policyRoot, { recursive: true });
  const existing = join(policyRoot, 'meta_decision_layer_choice.md');
  await writeFile(existing, 'consumer choice policy\n');

  const first = await setupMemoryLifecycle({
    projectRoot,
    templateRoot: join(REPO, 'assets', 'memory-templates'),
    decision: 'enable',
  });
  const profilePath = join(projectRoot, 'docs', 'agents', 'workflow-capabilities.json');
  const profileBefore = await readFile(profilePath, 'utf8');

  assert.deepEqual(first, {
    state: 'enabled',
    seeded: ['.memory/active/meta_memory_lifecycle.md'],
    adopted: ['.memory/active/meta_decision_layer_choice.md'],
  });
  assert.equal(await readFile(existing, 'utf8'), 'consumer choice policy\n');

  const second = await setupMemoryLifecycle({
    projectRoot,
    templateRoot: join(REPO, 'assets', 'memory-templates'),
  });
  assert.deepEqual(second, { state: 'enabled', seeded: [], adopted: [] });
  assert.equal(await readFile(profilePath, 'utf8'), profileBefore);

  const consumerDeleted = join(policyRoot, 'meta_memory_lifecycle.md');
  await rm(consumerDeleted);
  const explicitRerun = await setupMemoryLifecycle({
    projectRoot,
    templateRoot: join(REPO, 'assets', 'memory-templates'),
    decision: 'enable',
  });
  assert.deepEqual(explicitRerun, { state: 'enabled', seeded: [], adopted: [] });
  await assert.rejects(readFile(consumerDeleted, 'utf8'), { code: 'ENOENT' });
});

test('init, update, restore preview, and ordinary setup preserve an inactive profile byte-for-byte', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'memory-setup-'));
  const profilePath = join(projectRoot, 'docs', 'agents', 'workflow-capabilities.json');
  await mkdir(dirname(profilePath), { recursive: true });
  const profileBytes = JSON.stringify({
    schemaVersion: 7,
    consumerTopLevel: { keep: 'exactly' },
    memoryLifecycle: {
      enabled: false,
      consumerGrant: { keep: true },
      approvals: { restore: true, prune: false, custom: 'keep' },
    },
  }, null, 2) + '\n';
  await writeFile(profilePath, profileBytes);
  const firstKit = await makeKit({ 'scripts/example.mjs': 'export const version = 1;\n' });
  const nextKit = await makeKit({ 'scripts/example.mjs': 'export const version = 2;\n' }, '0.2.0');

  try {
    await init({ kitRoot: firstKit, consumerRoot: projectRoot });
    await reconcile({ kitRoot: nextKit, consumerRoot: projectRoot });
    assert.equal((await runMemoryLifecycle({ projectRoot })).state, 'disabled');
    assert.deepEqual(await setupMemoryLifecycle({ projectRoot }), {
      state: 'disabled',
      seeded: [],
      adopted: [],
    });
    assert.equal(await readFile(profilePath, 'utf8'), profileBytes);
  } finally {
    await cleanup(firstKit, nextKit, projectRoot);
  }
});

test('frozen Testreporter profile keeps unknown keys and enables all three memory rows explicitly', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'memory-setup-'));
  const profilePath = join(projectRoot, 'docs', 'agents', 'workflow-capabilities.json');
  const fixture = JSON.parse(await readFile(new URL(
    '../fixtures/memory-lifecycle/testreporter-capabilities.json',
    import.meta.url,
  )));
  await mkdir(dirname(profilePath), { recursive: true });
  await writeFile(profilePath, `${JSON.stringify(fixture, null, 2)}\n`);
  const archiveRoot = join(projectRoot, fixture.memoryLifecycle.archiveRoot);
  await mkdir(archiveRoot, { recursive: true });
  for (const { path } of fixture.memoryLifecycle.memories) {
    await writeFile(join(archiveRoot, path), `${path}\n`);
  }

  await setupMemoryLifecycle({
    projectRoot,
    templateRoot: join(REPO, 'assets', 'memory-templates'),
    decision: 'enable',
  });
  const enabled = JSON.parse(await readFile(profilePath, 'utf8'));
  const plan = await runMemoryLifecycle({ projectRoot });
  const enabledBytes = await readFile(profilePath, 'utf8');
  const restored = await runMemoryLifecycle({ projectRoot, apply: true });

  assert.equal(enabled.memoryLifecycle.enabled, true);
  assert.deepEqual(enabled.consumerTopLevel, { keep: 'exactly' });
  assert.deepEqual(enabled.memoryLifecycle.consumerLifecycleKey, { keep: true });
  assert.equal(enabled.memoryLifecycle.approvals.consumerApprovalKey, 'keep');
  assert.equal(enabled.memoryLifecycle.memories[0].consumerKey, 'keep');
  assert.equal(plan.actions.length, 3);
  assert.deepEqual(plan.actions.map(({ action }) => action), ['restore', 'restore', 'restore']);
  assert.deepEqual(restored.verdicts.map(({ verdict }) => verdict), [
    'restored',
    'restored',
    'restored',
  ]);
  assert.equal(await readFile(profilePath, 'utf8'), enabledBytes);
  for (const { path } of fixture.memoryLifecycle.memories) {
    assert.equal(await readFile(join(archiveRoot, path), 'utf8'), `${path}\n`);
  }
});

test('policy templates are consumer-neutral and define no kit-managed region', async () => {
  for (const name of [
    'meta_decision_layer_choice.md',
    'meta_memory_lifecycle.md',
  ]) {
    const body = await readFile(join(REPO, 'assets', 'memory-templates', name), 'utf8');
    assert.doesNotMatch(body, /Niko|Testreporter|#\d{2,}|append-managed/i);
  }
});

test('policy setup refuses a symlinked active root without writing outside the project', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'memory-setup-'));
  const foreignRoot = await mkdtemp(join(tmpdir(), 'memory-foreign-'));
  await mkdir(join(projectRoot, '.memory'), { recursive: true });
  await symlink(foreignRoot, join(projectRoot, '.memory', 'active'), 'dir');

  await assert.rejects(
    setupMemoryLifecycle({
      projectRoot,
      templateRoot: join(REPO, 'assets', 'memory-templates'),
      decision: 'enable',
    }),
    /symlink/i,
  );
  await assert.rejects(
    readFile(join(foreignRoot, 'meta_memory_lifecycle.md'), 'utf8'),
    { code: 'ENOENT' },
  );
});

test('setup-workflow documents the explicit opt-in contract identically on both surfaces', async () => {
  const claude = await readFile(join(REPO, '.claude', 'skills', 'setup-workflow', 'SKILL.md'), 'utf8');
  const codex = await readFile(join(REPO, '.agents', 'skills', 'setup-workflow', 'SKILL.md'), 'utf8');
  assert.equal(codex, claude);
  for (const token of [
    'node scripts/memory-lifecycle/setup.mjs --enable',
    'templatesSeeded',
    'preserve unknown profile',
    '`setup-workflow` performs no Memory Lifecycle write',
    'no kit-managed or `append-managed` region',
  ]) {
    assert.ok(claude.includes(token), `missing setup contract token: ${token}`);
  }
});
