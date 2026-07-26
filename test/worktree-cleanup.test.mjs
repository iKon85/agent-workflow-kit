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
  await writeFile(join(root, '.gitignore'), 'ANNAHMEN.md\nPLAN*.md\n');
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
      scratchPatterns: ['PLAN.md', 'PLAN-REVIEW-LOG.md'],
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

test('cleanup classifies profile-declared untracked scratch as removable and names it', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, 'PLAN.md'), '# local plan\n');

  const preview = JSON.parse((await run('python3', [
    CLEANUP, '--profile', profile, worktree,
  ], { cwd: root })).stdout);

  assert.equal(preview.removable, true);
  assert.deepEqual(preview.scratchFiles, ['PLAN.md']);
  assert.deepEqual(preview.reasons, []);
});

test('explicit cleanup removes a merged worktree whose only dirt is reported scratch', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, 'PLAN.md'), '# local plan\n');

  const removed = JSON.parse((await run('python3', [
    CLEANUP, '--profile', profile, '--remove', worktree,
  ], { cwd: root })).stdout);

  assert.deepEqual(removed.scratchFiles, ['PLAN.md']);
  assert.equal(removed.removed, true);
  assert.doesNotMatch((await git(root, 'worktree', 'list')).stdout, /feat-88-cleanup/);
});

test('cleanup rechecks before mutation and preserves late tracked and non-scratch work', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, 'PLAN.md'), '# local plan\n');
  await git(root, 'remote', 'add', 'origin', root);
  const mockGh = join(root, 'mock-gh-race');
  await writeFile(mockGh, `#!/bin/sh
printf '%s\\n' 'late tracked edit' > '${join(worktree, 'tracked.txt')}'
printf '%s\\n' 'late note' > '${join(worktree, 'notes.txt')}'
printf '%s\\n' '[]'
`);
  await run('chmod', ['+x', mockGh]);

  await assert.rejects(run('python3', [
    CLEANUP, '--profile', profile, '--gh-command', mockGh, '--remove', worktree,
  ], { cwd: root }), /cleanup changed before removal/);

  assert.equal(await readFile(join(worktree, 'PLAN.md'), 'utf8'), '# local plan\n');
  assert.equal(await readFile(join(worktree, 'tracked.txt'), 'utf8'), 'late tracked edit\n');
  assert.equal(await readFile(join(worktree, 'notes.txt'), 'utf8'), 'late note\n');
  assert.match((await git(root, 'worktree', 'list')).stdout, /feat-88-cleanup/);
});

test('cleanup rejects a concurrent scratch addition before deleting the previewed file', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, 'PLAN.md'), '# local plan\n');
  await git(root, 'remote', 'add', 'origin', root);
  const mockGh = join(root, 'mock-gh-scratch-race');
  await writeFile(mockGh, `#!/bin/sh
printf '%s\\n' 'late scratch' > '${join(worktree, 'PLAN-REVIEW-LOG.md')}'
printf '%s\\n' '[]'
`);
  await run('chmod', ['+x', mockGh]);

  await assert.rejects(run('python3', [
    CLEANUP, '--profile', profile, '--gh-command', mockGh, '--remove', worktree,
  ], { cwd: root }), /inventory no longer matches preview/);

  assert.equal(await readFile(join(worktree, 'PLAN.md'), 'utf8'), '# local plan\n');
  assert.equal(
    await readFile(join(worktree, 'PLAN-REVIEW-LOG.md'), 'utf8'),
    'late scratch\n',
  );
});

test('cleanup rejects a profile-matched scratch symlink without touching its target', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'preserve\n');
  await run('ln', ['-s', outside, join(worktree, 'PLAN.md')]);

  await assert.rejects(run('python3', [
    CLEANUP, '--profile', profile, '--remove', worktree,
  ], { cwd: root }), /not a regular file/);

  assert.equal(await readFile(outside, 'utf8'), 'preserve\n');
  assert.match((await git(root, 'worktree', 'list')).stdout, /feat-88-cleanup/);
});

test('cleanup refuses untracked non-scratch and tracked modifications separately', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, 'PLAN.md'), '# local plan\n');
  await writeFile(join(worktree, 'notes.txt'), 'not declared scratch\n');
  await writeFile(join(worktree, 'tracked.txt'), 'real work\n');

  const preview = JSON.parse((await run('python3', [
    CLEANUP, '--profile', profile, worktree,
  ], { cwd: root })).stdout);

  assert.equal(preview.removable, false);
  assert.deepEqual(preview.scratchFiles, ['PLAN.md']);
  assert.match(preview.reasons.join('\n'), /tracked modifications: tracked\.txt/);
  assert.match(preview.reasons.join('\n'), /untracked non-scratch: notes\.txt/);
});

test('cleanup refuses an open PR using the same external fact as sweep', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'remote', 'add', 'origin', root);
  const mockGh = join(root, 'mock-gh-open');
  await writeFile(mockGh, "#!/bin/sh\nprintf '%s\\n' '[{\"number\":245,\"state\":\"OPEN\",\"mergedAt\":null}]'\n");
  await run('chmod', ['+x', mockGh]);

  const preview = JSON.parse((await run('python3', [
    CLEANUP, '--profile', profile, '--gh-command', mockGh, worktree,
  ], { cwd: root })).stdout);

  assert.equal(preview.removable, false);
  assert.match(preview.reasons.join('\n'), /open PR/);
});

test('read-only sweep accounts for linked worktrees and local branches without mutation', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, 'feature.txt'), 'feature\n');
  await git(worktree, 'add', 'feature.txt');
  await git(worktree, 'commit', '-m', 'feature');
  await git(root, 'branch', 'fix/99-local-only', 'main');
  await git(root, 'branch', 'fix/77-merged-remote', 'main');
  await git(root, 'remote', 'add', 'origin', root);
  await git(root, 'fetch', 'origin');

  const mockGh = join(root, 'mock-gh');
  await writeFile(mockGh, `#!/bin/sh
case "$*" in
  *feat/88-cleanup*) printf '%s\\n' '[{"number":245,"state":"OPEN","mergedAt":null}]' ;;
  *) printf '%s\\n' '[]' ;;
esac
`);
  await run('chmod', ['+x', mockGh]);
  const before = (await git(root, 'status', '--porcelain=v1')).stdout;
  const worktreesBefore = (await git(root, 'worktree', 'list', '--porcelain')).stdout;
  const refsBefore = (await git(root, 'show-ref')).stdout;

  const report = JSON.parse((await run('python3', [
    CLEANUP, 'sweep', '--profile', profile, '--gh-command', mockGh,
  ], { cwd: root })).stdout);

  assert.equal(report.worktreeCount, 2);
  assert.equal(report.localBranchCount, 4);
  assert.equal(report.rows.filter((row) => row.kind === 'worktree').length, 2);
  assert.equal(report.rows.filter((row) => row.kind === 'branch').length, 2);
  const linked = report.rows.find((row) => row.branch === 'feat/88-cleanup');
  assert.equal(linked.issue, '88');
  assert.equal(linked.prState, 'open');
  assert.equal(linked.mergedIntoMain, false);
  assert.equal(linked.removable, false);
  assert.match(linked.reasons.join('\n'), /open PR/);
  assert.match(linked.verdictReason, /open PR/);
  assert.equal(typeof linked.lastCommitAgeSeconds, 'number');
  assert.equal(typeof report.mergedRemoteBranchCount, 'number');
  assert.equal((await git(root, 'status', '--porcelain=v1')).stdout, before);
  assert.equal((await git(root, 'worktree', 'list', '--porcelain')).stdout, worktreesBefore);
  assert.equal((await git(root, 'show-ref')).stdout, refsBefore);
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

test('cleanup never bypasses worktree safety with force removal', async () => {
  const source = await readFile(CLEANUP, 'utf8');
  assert.doesNotMatch(source, /worktree["', ]+remove["', ]+--force|--force/);
});
