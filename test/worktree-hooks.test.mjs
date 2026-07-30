import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { HELPER_FILES } from '../src/lib/bundle.mjs';

const run = promisify(execFile);
const HOOKS = resolve('.claude/hooks');
const TESTREPORTER_PROFILE = resolve('test/fixtures/worktree-lifecycle/testreporter.json');
const GENERIC_PROFILE = {
  version: 1,
  worktreeLifecycle: {
    enabled: true,
    worktreeRoot: '.sandboxes',
    branchTemplate: '{type}/{issue}-{slug}',
    pathTemplate: '{type}-{issue}-{slug}',
    branchRegex: '^(?:feat|fix|chore)/(?P<issue>\\d+)-',
    mainBranches: ['main'],
    protectedBranches: ['main'],
    setupEntry: 'python3 scripts/worktree-lifecycle/setup.py',
  },
};

async function git(cwd, ...args) {
  return run('git', args, { cwd });
}

async function fixture(profile = GENERIC_PROFILE) {
  const root = await mkdtemp(join(tmpdir(), 'awkit-hooks-'));
  await git(root, 'init', '--initial-branch=main');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'user.name', 'Test User');
  await writeFile(join(root, 'tracked.txt'), 'tracked\n');
  await writeFile(join(root, '.gitignore'), 'scratch/\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial');
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await writeFile(join(root, 'docs/agents/workflow-capabilities.json'), JSON.stringify(profile));
  await git(root, 'add', 'docs/agents/workflow-capabilities.json');
  await git(root, 'commit', '-m', 'profile');
  return root;
}

async function runHook(root, name, payload) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('python3', [join(HOOKS, name)], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

test('write-target guard blocks a new main-checkout file while a linked worktree is active', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const linked = join(root, '.sandboxes', 'feat-87-cwd');
  await git(root, 'worktree', 'add', '-b', 'feat/87-cwd', linked, 'main');

  const fromMain = await runHook(root, 'enforce-worktree-cwd.py', {
    tool_name: 'Write',
    tool_input: { file_path: join(root, 'notes.md') },
  });
  const fromLinked = await runHook(linked, 'enforce-worktree-cwd.py', {
    tool_name: 'Write',
    tool_input: { file_path: join(root, 'notes.md') },
  });

  for (const result of [fromMain, fromLinked]) {
    assert.equal(result.code, 2);
    assert.match(result.stderr, /notes\.md/);
    assert.match(result.stderr, /feat-87-cwd/);
  }
});

test('write-target guard judges the target, so out-of-repo and scratch writes pass', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const linked = join(root, '.sandboxes', 'feat-87-cwd-ok');
  await git(root, 'worktree', 'add', '-b', 'feat/87-cwd-ok', linked, 'main');
  await mkdir(join(root, 'scratch'));

  const outsideRepo = await runHook(root, 'enforce-worktree-cwd.py', {
    tool_name: 'Write',
    tool_input: { file_path: join(tmpdir(), 'wrapup-pr-body.md') },
  });
  const ignoredScratch = await runHook(root, 'enforce-worktree-cwd.py', {
    tool_name: 'Write',
    tool_input: { file_path: join(root, 'scratch', 'note.txt') },
  });
  const insideLinked = await runHook(linked, 'enforce-worktree-cwd.py', {
    tool_name: 'Edit',
    tool_input: { file_path: join(linked, 'tracked.txt') },
  });

  assert.equal(outsideRepo.code, 0);
  assert.equal(ignoredScratch.code, 0);
  assert.equal(insideLinked.code, 0);
});

test('no Bash command is judged by its command string any more', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const linked = join(root, '.sandboxes', 'feat-87-no-string');
  await git(root, 'worktree', 'add', '-b', 'feat/87-no-string', linked, 'main');

  // The #373 repro, the two substring-authorization arms (#411), the
  // `git -C` form the risky-command regex never matched (#412), and the
  // branch-creation form the retired discipline hook parsed — all of them
  // now leave the guard without an opinion instead of a wrong one.
  const commands = [
    "cat > /tmp/wrapup-pr-body.md <<'EOF'",
    'npm test',
    `git push --force origin main # see ${linked}`,
    `echo "${linked}" && git push --force origin main`,
    'git -C /srv/other-checkout push --force origin main',
    'git switch -c feat/99-new-slice',
  ];

  for (const command of commands) {
    const result = await runHook(root, 'enforce-worktree-cwd.py', {
      tool_name: 'Bash',
      tool_input: { command },
    });
    assert.equal(result.code, 0, command);
    assert.equal(result.stderr, '', command);
  }

  const source = await readFile(resolve('scripts/worktree-lifecycle/core.py'), 'utf8');
  assert.doesNotMatch(
    source,
    /targets_linked_worktree|risky_command_patterns|_BRANCH_CREATE_RE|_BRANCH_CHANGE_RE/,
  );
});

test('unsupported and malformed hook events are fail-open and repository-neutral', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = (await git(root, 'status', '--porcelain')).stdout;

  const malformed = await runHook(root, 'enforce-worktree-cwd.py', '{not-json');
  const unsupported = await runHook(root, 'enforce-worktree-cwd.py', {
    tool_name: 'Unknown',
    tool_input: {},
  });
  assert.equal(malformed.code, 0);
  assert.equal(unsupported.code, 0);

  assert.equal((await git(root, 'status', '--porcelain')).stdout, before);
  await assert.rejects(access(join(root, '.claude/logs')));
});

test('the write-target adapter is thin, core-driven, and shipped from the bundle', async () => {
  const shipped = new Set(HELPER_FILES.map(({ path }) => path));
  assert.equal(shipped.has('scripts/worktree-lifecycle/profile.py'), true);
  assert.equal(shipped.has('scripts/worktree-lifecycle/README.md'), true);

  const source = await readFile(join(HOOKS, 'enforce-worktree-cwd.py'), 'utf8');
  assert.match(source, /load_worktree_lifecycle_core/);
  assert.doesNotMatch(source, /import re|git worktree|branchRegex/);
  assert.equal(shipped.has('.claude/hooks/enforce-worktree-cwd.py'), true);

  // The 2026-07 hook review removed every lifecycle adapter without a named
  // incident; only the write-target guard remains in the shipped hook set.
  for (const retired of [
    '.claude/hooks/branch-context.py',
    '.claude/hooks/branch-watch.py',
    '.claude/hooks/enforce-worktree.py',
    '.claude/hooks/enforce-worktree-discipline.py',
    '.claude/hooks/slice-handoff-hint.py',
  ]) {
    assert.equal(shipped.has(retired), false, retired);
  }
});

test('frozen Testreporter profile preserves the historical guard outcomes', async (t) => {
  const profile = JSON.parse(await readFile(TESTREPORTER_PROFILE, 'utf8'));
  const root = await fixture(profile);
  t.after(() => rm(root, { recursive: true, force: true }));
  const linked = join(root, '.worktrees', 'feat-87-parity');
  await git(root, 'worktree', 'add', '-b', 'feat/87-parity', linked, 'main');
  await mkdir(join(root, 'scratch'));

  const maintenance = await runHook(root, 'enforce-worktree-cwd.py', {
    tool_name: 'Bash',
    tool_input: { command: 'git push origin --delete merged-branch' },
  });
  const mainTarget = await runHook(root, 'enforce-worktree-cwd.py', {
    tool_name: 'Write',
    tool_input: { file_path: join(root, 'notes.md') },
  });
  const linkedCwd = await runHook(linked, 'enforce-worktree-cwd.py', {
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });
  const ignored = await runHook(root, 'enforce-worktree-cwd.py', {
    tool_name: 'Write',
    tool_input: { file_path: join(root, 'scratch', 'note.txt') },
  });

  assert.equal(maintenance.code, 0);
  assert.equal(mainTarget.code, 2);
  assert.equal(linkedCwd.code, 0);
  assert.equal(ignored.code, 0);
});
