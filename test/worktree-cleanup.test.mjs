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

async function fixture(seed) {
  const root = await mkdtemp(join(tmpdir(), 'awkit-cleanup-'));
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'user.name', 'Test User');
  await writeFile(join(root, 'tracked.txt'), 'base\n');
  await writeFile(join(root, '.gitignore'), 'ANNAHMEN.md\nPLAN*.md\n.env*\n');
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
      ...(seed ? { seed } : {}),
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
  ], { cwd: root }), /tracked-change/);

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

test('cleanup classifies ignored files as scratch and names them', async (t) => {
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

test('cleanup deletes a same-path scratch replacement — the documented residual risk', async (t) => {
  // ADR-0009 accepts this window deliberately: between assessment and deletion
  // a file could in principle be replaced. Pinning it here keeps the trade-off
  // visible instead of letting identity-freezing machinery grow back unnoticed.
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, 'PLAN.md'), '# assessed plan\n');
  await git(root, 'remote', 'add', 'origin', root);
  const count = join(root, 'mock-gh-replacement-count');
  const mockGh = join(root, 'mock-gh-replacement-race');
  await writeFile(mockGh, `#!/bin/sh
value="$(cat '${count}' 2>/dev/null || printf 0)"
value=$((value + 1))
printf '%s\\n' "$value" > '${count}'
if [ "$value" -eq 2 ]; then
  rm '${join(worktree, 'PLAN.md')}'
  printf '%s\\n' 'replacement' > '${join(worktree, 'PLAN.md')}'
fi
printf '%s\\n' '[]'
`);
  await run('chmod', ['+x', mockGh]);

  const removed = JSON.parse((await run('python3', [
    CLEANUP, '--profile', profile, '--gh-command', mockGh, '--remove', worktree,
  ], { cwd: root })).stdout);

  assert.equal(removed.removed, true);
  assert.deepEqual(removed.scratchFiles, ['PLAN.md']);
  assert.doesNotMatch((await git(root, 'worktree', 'list')).stdout, /feat-88-cleanup/);
});

test('cleanup rejects an escaping ignored symlink without touching its target', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'preserve\n');
  await run('ln', ['-s', outside, join(worktree, 'PLAN.md')]);

  const preview = JSON.parse((await run('python3', [
    CLEANUP, '--profile', profile, worktree,
  ], { cwd: root })).stdout);

  assert.equal(preview.removable, false);
  assert.match(preview.reasons.join('\n'), /ignored-symlink/);
  await assert.rejects(run('python3', [
    CLEANUP, '--profile', profile, '--remove', worktree,
  ], { cwd: root }), /absolute target/);
  assert.equal(await readFile(outside, 'utf8'), 'preserve\n');
  assert.match((await git(root, 'worktree', 'list')).stdout, /feat-88-cleanup/);
});

test('cleanup refuses an ignored .env the main checkout does not carry', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, '.env'), 'LOCAL_ONLY=1\n');
  await writeFile(join(worktree, 'PLAN.md'), '# preserve everything until .env is resolved\n');

  const preview = JSON.parse((await run('python3', [
    CLEANUP, '--profile', profile, worktree,
  ], { cwd: root })).stdout);

  assert.equal(preview.removable, false);
  assert.match(preview.reasons.join('\n'), /\[env-file\]/);
  await assert.rejects(run('python3', [
    CLEANUP, '--profile', profile, '--remove', worktree,
  ], { cwd: root }), /env-file/);
  assert.equal(await readFile(join(worktree, '.env'), 'utf8'), 'LOCAL_ONLY=1\n');
  assert.equal(
    await readFile(join(worktree, 'PLAN.md'), 'utf8'),
    '# preserve everything until .env is resolved\n',
  );
});

test('cleanup deletes a seed-declared .env and names the deletion the declaration authorized', async (t) => {
  // The consumer declared this file as what a fresh worktree carries, so the
  // declaration is the consent — the same authority .gitignore already carries.
  const { root, profile, worktree } = await fixture({ paths: ['.env'] });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'PORT=3000\n');
  await writeFile(join(worktree, '.env'), 'PORT=3101\n');

  const preview = JSON.parse((await run('python3', [
    CLEANUP, '--profile', profile, worktree,
  ], { cwd: root })).stdout);

  assert.equal(preview.removable, true);
  assert.deepEqual(preview.declaredDeletions, ['.env']);
  assert.deepEqual(preview.scratchFiles, ['.env']);
  assert.match(preview.classification, /declaration/);

  const removed = JSON.parse((await run('python3', [
    CLEANUP, '--profile', profile, '--remove', worktree,
  ], { cwd: root })).stdout);

  assert.equal(removed.removed, true);
  assert.deepEqual(removed.declaredDeletions, ['.env']);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'PORT=3000\n');
  assert.doesNotMatch((await git(root, 'worktree', 'list')).stdout, /feat-88-cleanup/);
});

test('a declaration for another path leaves the divergent .env blocking', async (t) => {
  const { root, profile, worktree } = await fixture({ paths: ['config/local.json'] });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'PORT=3000\n');
  await writeFile(join(worktree, '.env'), 'PORT=3101\n');

  const preview = JSON.parse((await run('python3', [
    CLEANUP, '--profile', profile, worktree,
  ], { cwd: root })).stdout);

  assert.equal(preview.removable, false);
  assert.deepEqual(preview.declaredDeletions, []);
  assert.match(preview.reasons.join('\n'), /\[env-file\]/);
  assert.match(preview.reasons.join('\n'), /\.env/);
  assert.equal(await readFile(join(worktree, '.env'), 'utf8'), 'PORT=3101\n');
});

test('cleanup rejects a worktree root replaced by a symlink after revalidation', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, 'PLAN.md'), '# local plan\n');
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'PLAN.md'), 'preserve outside\n');
  await git(root, 'remote', 'add', 'origin', root);
  const displaced = `${worktree}-displaced`;
  const callCount = join(root, 'mock-gh-root-symlink-count');
  const mockGh = join(root, 'mock-gh-root-symlink-race');
  await writeFile(mockGh, `#!/bin/sh
count="$(cat '${callCount}' 2>/dev/null || printf 0)"
count=$((count + 1))
printf '%s\\n' "$count" > '${callCount}'
if [ "$count" -eq 2 ]; then
  mv '${worktree}' '${displaced}'
  ln -s '${outside}' '${worktree}'
fi
printf '%s\\n' '[]'
`);
  await run('chmod', ['+x', mockGh]);

  await assert.rejects(run('python3', [
    CLEANUP, '--profile', profile, '--gh-command', mockGh, '--remove', worktree,
  ], { cwd: root }), /worktree root changed before removal/);

  assert.equal(await readFile(join(outside, 'PLAN.md'), 'utf8'), 'preserve outside\n');
  assert.equal(await readFile(join(displaced, 'PLAN.md'), 'utf8'), '# local plan\n');
});

test('cleanup rejects a worktree root replaced by another directory after revalidation', async (t) => {
  const { root, profile, worktree } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(worktree, 'PLAN.md'), '# local plan\n');
  await git(root, 'remote', 'add', 'origin', root);
  const displaced = `${worktree}-displaced`;
  const callCount = join(root, 'mock-gh-root-directory-count');
  const mockGh = join(root, 'mock-gh-root-directory-race');
  await writeFile(mockGh, `#!/bin/sh
count="$(cat '${callCount}' 2>/dev/null || printf 0)"
count=$((count + 1))
printf '%s\\n' "$count" > '${callCount}'
if [ "$count" -eq 2 ]; then
  mv '${worktree}' '${displaced}'
  mkdir '${worktree}'
  printf '%s\\n' 'preserve replacement' > '${join(worktree, 'PLAN.md')}'
fi
printf '%s\\n' '[]'
`);
  await run('chmod', ['+x', mockGh]);

  await assert.rejects(run('python3', [
    CLEANUP, '--profile', profile, '--gh-command', mockGh, '--remove', worktree,
  ], { cwd: root }), /worktree root changed before removal/);

  assert.equal(await readFile(join(worktree, 'PLAN.md'), 'utf8'), 'preserve replacement\n');
  assert.equal(await readFile(join(displaced, 'PLAN.md'), 'utf8'), '# local plan\n');
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
  const reasons = preview.reasons.join('\n');
  assert.match(reasons, /\[tracked-change\] 1 tracked change blocks teardown/);
  assert.match(reasons, /tracked\.txt/);
  assert.match(reasons, /\[untracked-files\] 1 untracked file in 1 directory is not ignored/);
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

test('read-only sweep reports detached HEAD commit age from the detached commit', async (t) => {
  const { root, profile } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldCommitEpoch = 946684800;
  await git(root, 'checkout', '-b', 'old-detached-source', 'main');
  await run('git', ['commit', '--allow-empty', '-m', 'historical detached head'], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    },
  });
  const oldCommit = (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
  await git(root, 'checkout', 'main');
  await git(root, 'branch', '-D', 'old-detached-source');
  const detached = join(root, '.worktrees', 'detached-historical');
  await git(root, 'worktree', 'add', '--detach', detached, oldCommit);

  const before = Math.floor(Date.now() / 1000);
  const report = JSON.parse((await run('python3', [
    CLEANUP, 'sweep', '--profile', profile,
  ], { cwd: root })).stdout);
  const after = Math.floor(Date.now() / 1000);
  const row = report.rows.find((candidate) => candidate.path === detached);

  assert.ok(row);
  assert.equal(row.branch, '');
  assert.ok(row.lastCommitAgeSeconds >= before - oldCommitEpoch);
  assert.ok(row.lastCommitAgeSeconds <= after - oldCommitEpoch);
  assert.notEqual(row.lastCommitAgeSeconds, 0);
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
