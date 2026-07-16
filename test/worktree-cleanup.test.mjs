import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { HELPER_FILES } from '../src/lib/bundle.mjs';

const run = promisify(execFile);
const CLEANUP = resolve('scripts/worktree-lifecycle/cleanup.py');

async function git(cwd, ...args) {
  return run('git', args, { cwd });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'awkit-cleanup-'));
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'user.name', 'Test User');
  await writeFile(join(root, 'tracked.txt'), 'base\n');
  await writeFile(join(root, '.gitignore'), 'ANNAHMEN.md\n');
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  const profile = join(root, 'docs/agents/workflow-capabilities.json');
  await writeFile(profile, JSON.stringify({
    version: 1,
    worktreeLifecycle: {
      enabled: true,
      worktreeRoot: '.worktrees',
      branchTemplate: '{type}/{issue}-{slug}',
      pathTemplate: '{type}-{issue}-{slug}',
      branchRegex: '^(?:feat|fix)/(?P<issue>\\d+)-',
      mainBranches: ['main'],
      protectedBranches: ['main'],
      setupSteps: [],
    },
  }));
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');
  const worktree = join(root, '.worktrees', 'feat-88-cleanup');
  await git(root, 'worktree', 'add', '-b', 'feat/88-cleanup', worktree, 'main');
  return { root, profile, worktree };
}

test('cleanup refuses a dirty worktree without removing or mutating it', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, 'tracked.txt'), 'dirty\n');

  await assert.rejects(run('python3', [
    CLEANUP, '--profile', profile, '--remove', worktree,
  ], { cwd: root }), /dirty/);

  assert.match((await git(root, 'worktree', 'list')).stdout, /feat-88-cleanup/);
  assert.equal(await readFile(join(worktree, 'tracked.txt'), 'utf8'), 'dirty\n');
});

test('cleanup refuses a clean branch whose commit is not merged into main', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, 'feature.txt'), 'feature\n');
  await git(worktree, 'add', 'feature.txt');
  await git(worktree, 'commit', '-m', 'feature');

  await assert.rejects(run('python3', [
    CLEANUP, '--profile', profile, '--remove', worktree,
  ], { cwd: root }), /unmerged/);

  assert.match((await git(root, 'worktree', 'list')).stdout, /feat-88-cleanup/);
});

test('cleanup reads assumptions before removing a clean merged worktree', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, 'feature.txt'), 'feature\n');
  await git(worktree, 'add', 'feature.txt');
  await git(worktree, 'commit', '-m', 'feature');
  await git(root, 'merge', '--no-ff', 'feat/88-cleanup', '-m', 'merge feature');
  await writeFile(join(worktree, 'ANNAHMEN.md'), '- #99: carry this decision\n');

  const preview = JSON.parse((await run('python3', [
    CLEANUP, '--profile', profile, worktree,
  ], { cwd: root })).stdout);
  assert.equal(preview.removable, true);
  assert.match(preview.assumptions, /carry this decision/);

  const removed = JSON.parse((await run('python3', [
    CLEANUP, '--profile', profile, '--remove', worktree,
  ], { cwd: root })).stdout);
  assert.equal(removed.removed, true);
  assert.doesNotMatch((await git(root, 'worktree', 'list')).stdout, /feat-88-cleanup/);
  await assert.rejects(git(root, 'show-ref', '--verify', 'refs/heads/feat/88-cleanup'));
});

test('cleanup never removes the protected main checkout', async (t) => {
  const { root, profile } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(run('python3', [
    CLEANUP, '--profile', profile, '--remove', root,
  ], { cwd: root }), /protected/);

  assert.match((await git(root, 'branch', '--show-current')).stdout, /main/);
});

test('cleanup entry ships with the shared Worktree Lifecycle unit', () => {
  const shipped = new Set(HELPER_FILES.map(({ path }) => path));
  assert.equal(shipped.has('scripts/worktree-lifecycle/cleanup.py'), true);
});
