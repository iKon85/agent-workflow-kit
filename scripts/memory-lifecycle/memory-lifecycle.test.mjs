import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeMemoryLifecycle,
  planMemoryLifecycle,
  runMemoryLifecycle,
} from './index.mjs';

test('dry-run classifies each candidate once without writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-lifecycle-'));
  const activeRoot = join(root, 'active');
  const archiveRoot = join(root, 'archive');
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(join(archiveRoot, 'returning.md'), 'archived memory\n');

  const plan = await planMemoryLifecycle({
    activeRoot,
    archiveRoot,
    candidates: ['new.md', 'returning.md'],
    approved: true,
  });

  assert.deepEqual(plan.actions.map(({ path, action }) => [path, action]), [
    ['new.md', 'create'],
    ['returning.md', 'restore'],
  ]);
  await assert.rejects(readFile(join(activeRoot, 'new.md'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(join(activeRoot, 'returning.md'), 'utf8'), { code: 'ENOENT' });
});

test('dry-run refuses unsafe roots, collisions, outside paths, and unapproved restores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-lifecycle-'));
  const activeRoot = join(root, 'active');
  const archiveRoot = join(root, 'archive');
  await mkdir(activeRoot, { recursive: true });
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(join(activeRoot, 'collision.md'), 'active\n');
  await writeFile(join(archiveRoot, 'collision.md'), 'different archive\n');
  await writeFile(join(archiveRoot, 'approval.md'), 'archived\n');

  const plan = await planMemoryLifecycle({
    activeRoot,
    archiveRoot,
    candidates: ['../foreign.md', 'collision.md', 'approval.md'],
  });
  assert.deepEqual(plan.actions.map(({ action }) => action), ['refuse', 'refuse', 'refuse']);

  const linkedActive = join(root, 'linked-active');
  await symlink(activeRoot, linkedActive, 'dir');
  const symlinkPlan = await planMemoryLifecycle({
    activeRoot: linkedActive,
    archiveRoot,
    candidates: ['safe.md'],
    approved: true,
  });
  assert.equal(symlinkPlan.actions[0].action, 'refuse');
});

test('execute restores without removing the archive and writes a content-free receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-lifecycle-'));
  const activeRoot = join(root, 'active');
  const archiveRoot = join(root, 'archive');
  const receiptRoot = join(root, 'receipts');
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(join(archiveRoot, 'returning.md'), 'private memory contents\n');

  const result = await executeMemoryLifecycle({
    activeRoot,
    archiveRoot,
    receiptRoot,
    candidates: ['returning.md'],
    approved: true,
    source: { kitVersion: '1.2.3', bundleVersion: 'bundle-abc' },
  });

  assert.equal(await readFile(join(activeRoot, 'returning.md'), 'utf8'), 'private memory contents\n');
  assert.equal(await readFile(join(archiveRoot, 'returning.md'), 'utf8'), 'private memory contents\n');
  assert.equal(result.verdicts[0].verdict, 'restored');
  const [receiptName] = await readdir(receiptRoot);
  const receiptText = await readFile(join(receiptRoot, receiptName), 'utf8');
  const receipt = JSON.parse(receiptText);
  assert.equal(receipt.schemaVersion, 1);
  assert.deepEqual(receipt.source, { kitVersion: '1.2.3', bundleVersion: 'bundle-abc' });
  assert.match(receipt.verdicts[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(!receiptText.includes('private memory contents'));
});

test('rerun preserves restored memory and never overwrites or duplicates its receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-lifecycle-'));
  const activeRoot = join(root, 'active');
  const archiveRoot = join(root, 'archive');
  const receiptRoot = join(root, 'receipts');
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(join(archiveRoot, 'stable.md'), 'stable\n');
  const options = {
    activeRoot,
    archiveRoot,
    receiptRoot,
    candidates: ['stable.md'],
    approved: true,
    source: { kitVersion: '1.2.3', bundleVersion: 'bundle-abc' },
  };

  const first = await executeMemoryLifecycle(options);
  const receiptBefore = await readFile(first.receiptPath, 'utf8');
  const second = await executeMemoryLifecycle(options);

  assert.equal(second.verdicts[0].verdict, 'skipped');
  assert.equal(second.receiptPath, null);
  assert.deepEqual(await readdir(receiptRoot), [first.receiptPath.split('/').at(-1)]);
  assert.equal(await readFile(first.receiptPath, 'utf8'), receiptBefore);
});

test('disabled and duplicate candidates produce one explicit skip verdict per path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-lifecycle-'));
  const plan = await planMemoryLifecycle({
    activeRoot: join(root, 'active'),
    archiveRoot: join(root, 'archive'),
    candidates: [
      { path: 'later.md', enabled: false },
      { path: 'later.md', enabled: false },
    ],
    approved: true,
  });

  assert.deepEqual(plan.actions, [{
    path: 'later.md',
    action: 'skip',
    reason: 'candidate is disabled by consumer policy',
  }]);
});

test('missing or disabled consumer profile is a no-write disabled result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-lifecycle-'));

  assert.deepEqual(await runMemoryLifecycle({ projectRoot: root }), {
    state: 'disabled',
    dryRun: true,
    actions: [],
  });
  await assert.rejects(readFile(join(root, '.memory'), 'utf8'), { code: 'ENOENT' });
});

test('frozen Testreporter parity profile classifies all three native memory rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-lifecycle-'));
  const fixture = JSON.parse(await readFile(new URL(
    '../../test/fixtures/memory-lifecycle/testreporter-parity.json',
    import.meta.url,
  )));
  const activeRoot = join(root, fixture.activeRoot);
  const archiveRoot = join(root, fixture.archiveRoot);
  await mkdir(archiveRoot, { recursive: true });
  for (const { path } of fixture.memories) {
    await writeFile(join(archiveRoot, path), `${path}\n`);
  }

  const plan = await planMemoryLifecycle({
    activeRoot,
    archiveRoot,
    candidates: fixture.memories,
    approved: fixture.approvals.restore,
  });

  assert.equal(plan.actions.length, 3);
  assert.deepEqual(plan.actions.map(({ action }) => action), ['restore', 'restore', 'restore']);
});
