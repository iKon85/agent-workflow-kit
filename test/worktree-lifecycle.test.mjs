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

test('generic consumer creates a configured worktree without a port allocator', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));

  const profile = join(repo, 'workflow-capabilities.json');
  await writeFile(profile, JSON.stringify({
    version: 1,
    worktreeLifecycle: {
      enabled: true,
      worktreeRoot: '.sandboxes',
      branchTemplate: '{type}/{issue}-{slug}',
      pathTemplate: '{type}-{issue}-{slug}',
      mainBranches: ['main'],
      setupSteps: [
        {
          kind: 'command',
          command: ['node', '-e', "require('fs').writeFileSync('installed-by-yarn', 'yes\\n')"],
        },
      ],
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
  assert.equal(await readFile(join(worktree, 'installed-by-yarn'), 'utf8'), 'yes\n');
  await assert.rejects(readFile(join(worktree, '.dev-ports'), 'utf8'));
  assert.match((await git(worktree, 'branch', '--show-current')).stdout, /feat\/123-portable/);
});

test('reusing an exact clean legacy worktree backfills a conservative baseline', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(repo, '.gitignore'), '.sandboxes/\nbuild-cache/\n');
  await git(repo, 'add', '.gitignore');
  await git(repo, 'commit', '-m', 'ignore build cache');
  const profile = join(repo, 'workflow-capabilities.json');
  await writeFile(profile, JSON.stringify({
    worktreeLifecycle: {
      enabled: true,
      worktreeRoot: '.sandboxes',
      branchTemplate: '{type}/{issue}-{slug}',
      pathTemplate: '{type}-{issue}-{slug}',
      mainBranches: ['main'],
      setupSteps: [],
    },
  }));
  const args = [
    SETUP, '--profile', profile, '--base', 'main', '124', 'legacy', 'feat',
  ];
  await run('python3', args, { cwd: repo });
  const worktree = join(repo, '.sandboxes/feat-124-legacy');
  const gitDir = (await git(worktree, 'rev-parse', '--absolute-git-dir')).stdout.trim();
  await rm(join(gitDir, 'awkit-artifact-baseline-v1.json'));
  await mkdir(join(worktree, 'build-cache'));
  await writeFile(join(worktree, 'build-cache/existing.bin'), 'consumer\n');

  const reused = await run('python3', args, { cwd: repo });
  const baseline = JSON.parse(
    await readFile(join(gitDir, 'awkit-artifact-baseline-v1.json'), 'utf8'),
  );
  assert.match(reused.stdout, /already exists/);
  assert.deepEqual(baseline.initialIgnoredFiles, ['build-cache/existing.bin']);
  assert.deepEqual(baseline.initialUntrackedFiles, ['build-cache/existing.bin']);
});

test('reusing a dirty legacy worktree defers baseline backfill without stopping', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(repo, '.gitignore'), '.sandboxes/\n');
  await git(repo, 'add', '.gitignore');
  await git(repo, 'commit', '-m', 'ignore worktrees');
  const profile = join(repo, 'workflow-capabilities.json');
  await writeFile(profile, JSON.stringify({
    worktreeLifecycle: {
      enabled: true,
      worktreeRoot: '.sandboxes',
      branchTemplate: '{type}/{issue}-{slug}',
      pathTemplate: '{type}-{issue}-{slug}',
      mainBranches: ['main'],
      setupSteps: [],
    },
  }));
  const args = [
    SETUP, '--profile', profile, '--base', 'main', '125', 'dirty-legacy', 'feat',
  ];
  await run('python3', args, { cwd: repo });
  const worktree = join(repo, '.sandboxes/feat-125-dirty-legacy');
  const gitDir = (await git(worktree, 'rev-parse', '--absolute-git-dir')).stdout.trim();
  await rm(join(gitDir, 'awkit-artifact-baseline-v1.json'));
  await writeFile(join(worktree, 'README.md'), '# work in progress\n');

  const reused = await run('python3', args, { cwd: repo });

  assert.match(reused.stdout, /already exists/);
  await assert.rejects(readFile(join(gitDir, 'awkit-artifact-baseline-v1.json'), 'utf8'));
  assert.equal(await readFile(join(worktree, 'README.md'), 'utf8'), '# work in progress\n');

  await writeFile(join(worktree, 'README.md'), '# fixture\n');
  const retried = await run('python3', args, { cwd: repo });
  assert.match(retried.stdout, /already exists/);
  assert.equal(
    JSON.parse(await readFile(join(gitDir, 'awkit-artifact-baseline-v1.json'), 'utf8'))
      .initialUntrackedFiles.length,
    0,
  );
});

test('frozen Testreporter profile preserves branch, setup order, and deterministic port output', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(repo, '.env.fixture'), 'FIXTURE=yes\n');

  const result = await run('python3', [
    SETUP,
    '--profile', TESTREPORTER_PROFILE,
    '--base', 'main',
    '1166', 'ports', 'feat',
  ], { cwd: repo });

  const worktree = join(repo, '.worktrees', 'feat-1166-ports');
  assert.match(result.stdout, /feat\/1166-ports/);
  assert.equal(await readFile(join(worktree, '.env'), 'utf8'), 'FIXTURE=yes\n');
  assert.equal(
    await readFile(join(worktree, '.dev-ports'), 'utf8'),
    'VITE_DEV_PORT=7843\nBACKEND_PORT=5671\n',
  );
  assert.equal(await readFile(join(worktree, 'setup-order-ok'), 'utf8'), 'yes\n');
});

test('partial setup failure rolls back the new worktree and branch', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(repo, 'workflow-capabilities.json');
  await writeFile(profile, JSON.stringify({
    version: 1,
    worktreeLifecycle: {
      enabled: true,
      worktreeRoot: '.worktrees',
      branchTemplate: '{type}/{issue}-{slug}',
      pathTemplate: '{type}-{issue}-{slug}',
      setupSteps: [
        { kind: 'command', command: ['node', '-e', 'process.exit(23)'] },
      ],
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

test('profile port allocation skips browser-unsafe output ports deterministically', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(repo, '.env.fixture'), 'FIXTURE=yes\n');

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

test('shipped Worktree Lifecycle census accounts for all eight historical rows', async () => {
  const census = JSON.parse(await readFile(CAPABILITY_CENSUS, 'utf8'));
  assert.equal(census.capabilities.length, 8);
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
