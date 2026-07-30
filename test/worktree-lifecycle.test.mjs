import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { HELPER_FILES } from '../src/lib/bundle.mjs';

const run = promisify(execFile);
const SETUP = resolve('scripts/worktree-lifecycle/setup.py');
const TESTREPORTER_PROFILE = resolve('test/fixtures/worktree-lifecycle/testreporter.json');
const CAPABILITY_CENSUS = resolve('scripts/worktree-lifecycle/capabilities.json');

async function git(cwd, ...args) {
  return run('git', args, { cwd });
}

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'awkit-worktree-'));
  const repo = join(root, 'consumer');
  await mkdir(repo);
  await git(repo, 'init', '--initial-branch=main');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'user.name', 'Test User');
  await writeFile(join(repo, 'README.md'), '# fixture\n');
  await git(repo, 'add', 'README.md');
  await git(repo, 'commit', '-m', 'initial');
  return { root, repo };
}

test('generic consumer creates a seeded worktree in one call, without variables', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(repo, '.env'), 'API_TOKEN=hand-written\n');

  const profile = join(repo, 'workflow-capabilities.json');
  await writeFile(profile, JSON.stringify({
    version: 1,
    worktreeLifecycle: {
      enabled: true,
      worktreeRoot: '.sandboxes',
      branchTemplate: '{type}/{issue}-{slug}',
      pathTemplate: '{type}-{issue}-{slug}',
      mainBranches: ['main'],
      seed: { paths: ['.env'] },
    },
  }));

  const result = await run('python3', [
    SETUP,
    '--profile', profile,
    '--base', 'main',
    '123', 'portable', 'feat',
  ], { cwd: repo });

  const worktree = join(repo, '.sandboxes', 'feat-123-portable');
  assert.match(result.stdout, /Worktree ready/);
  assert.equal(await readFile(join(worktree, '.env'), 'utf8'), 'API_TOKEN=hand-written\n');
  await assert.rejects(readFile(join(worktree, '.dev-ports'), 'utf8'));
  assert.match((await git(worktree, 'branch', '--show-current')).stdout, /feat\/123-portable/);
});

test('frozen Testreporter profile copies declared paths verbatim and renders its variables', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  // A value the kit must not read, parse, or patch — it is copied as bytes.
  await writeFile(join(repo, '.env'), 'VITE_API_URL=http://localhost:3001\nSECRET=keep\n');

  const result = await run('python3', [
    SETUP,
    '--profile', TESTREPORTER_PROFILE,
    '--base', 'main',
    '1166', 'ports', 'feat',
  ], { cwd: repo });

  const worktree = join(repo, '.worktrees', 'feat-1166-ports');
  assert.match(result.stdout, /feat\/1166-ports/);
  assert.equal(
    await readFile(join(worktree, '.env'), 'utf8'),
    'VITE_API_URL=http://localhost:3001\nSECRET=keep\n',
  );
  assert.equal(
    await readFile(join(worktree, '.dev-ports'), 'utf8'),
    'VITE_DEV_PORT=7843\nBACKEND_PORT=5671\n',
  );
  // Declared, absent in the main checkout: named, never invented, never fatal.
  assert.match(result.stdout, /\.env\.local/);
  await assert.rejects(readFile(join(worktree, '.env.local'), 'utf8'));
});

test('a declared path the helper cannot copy rolls back the new worktree and branch', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(repo, 'config'));
  await writeFile(join(repo, 'config', 'nested.json'), '{}\n');
  const profile = join(repo, 'workflow-capabilities.json');
  await writeFile(profile, JSON.stringify({
    version: 1,
    worktreeLifecycle: {
      enabled: true,
      worktreeRoot: '.worktrees',
      branchTemplate: '{type}/{issue}-{slug}',
      pathTemplate: '{type}-{issue}-{slug}',
      seed: { paths: ['config'] },
    },
  }));

  await assert.rejects(run('python3', [
    SETUP,
    '--profile', profile,
    '--base', 'main',
    '321', 'rollback', 'feat',
  ], { cwd: repo }));

  assert.doesNotMatch((await git(repo, 'worktree', 'list')).stdout, /feat-321-rollback/);
  await assert.rejects(git(repo, 'show-ref', '--verify', 'refs/heads/feat/321-rollback'));
});

test('variable allocation skips browser-unsafe ports deterministically', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(repo, '.env'), 'FIXTURE=yes\n');

  await run('python3', [
    SETUP,
    '--profile', TESTREPORTER_PROFILE,
    '--base', 'main',
    '2005', 'unsafe-port', 'feat',
  ], { cwd: repo });

  assert.equal(
    await readFile(join(repo, '.worktrees', 'feat-2005-unsafe-port', '.dev-ports'), 'utf8'),
    'VITE_DEV_PORT=7243\nBACKEND_PORT=5071\n',
  );
});

// Adoption, not mandate: a worktree someone else created is first-class, and the
// helper never re-seeds over the values that worktree already carries.
test('an externally created worktree is adopted unchanged', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(repo, '.env'), 'VITE_API_URL=http://localhost:3001\n');

  const worktree = join(repo, '.worktrees', 'feat-1166-ports');
  await git(repo, 'worktree', 'add', '-b', 'feat/1166-ports', worktree, 'main');
  await writeFile(join(worktree, '.env'), 'VITE_API_URL=http://localhost:5671\n');

  const result = await run('python3', [
    SETUP,
    '--profile', TESTREPORTER_PROFILE,
    '--base', 'main',
    '1166', 'ports', 'feat',
  ], { cwd: repo });

  assert.match(result.stdout, /already exists/);
  assert.equal(
    await readFile(join(worktree, '.env'), 'utf8'),
    'VITE_API_URL=http://localhost:5671\n',
  );
  await assert.rejects(readFile(join(worktree, '.dev-ports'), 'utf8'));
});

test('shipped Worktree Lifecycle census accounts for the kept rows', async () => {
  // The 2026-07 hook review retired five of the eight historical rows (the
  // adapters without a named incident); setup, cleanup, and the write-target
  // guard remain.
  const census = JSON.parse(await readFile(CAPABILITY_CENSUS, 'utf8'));
  assert.equal(census.capabilities.length, 3);
  for (const capability of census.capabilities) {
    assert.ok(
      capability.primitives?.length > 0 || capability.naReason,
      `${capability.historicalPath} needs shared primitives or a concrete N/A reason`,
    );
    assert.ok(capability.artifact, `${capability.historicalPath} needs a shipped artifact`);
    await readFile(resolve(capability.artifact));
    for (const artifact of capability.supportingArtifacts ?? []) {
      await readFile(resolve(artifact));
    }
  }
});

test('portable setup core ships as one complete helper unit', () => {
  const shipped = new Set(HELPER_FILES.map(({ path }) => path));
  assert.equal(shipped.has('scripts/worktree-lifecycle/core.py'), true);
  assert.equal(shipped.has('scripts/worktree-lifecycle/setup.py'), true);
  assert.equal(shipped.has('scripts/worktree-lifecycle/classify.py'), true);
  assert.equal(shipped.has('scripts/worktree-lifecycle/capabilities.json'), true);
});

// ADR-0009: teardown authority is the repository's current state, so the shipped
// unit carries no session-teardown provenance CLI to bind a receipt to.
test('the shipped lifecycle unit ships no session-teardown provenance CLI', async () => {
  const shipped = new Set(HELPER_FILES.map(({ path }) => path));
  assert.equal(shipped.has('scripts/worktree-lifecycle/session.py'), false);
  await assert.rejects(readFile(resolve('scripts/worktree-lifecycle/session.py'), 'utf8'));
});
