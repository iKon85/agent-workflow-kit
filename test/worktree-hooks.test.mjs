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
    setupSteps: [],
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

test('branch context adapter emits profile-derived branch and issue facts', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'switch', '-c', 'feat/87-rules');

  const { stdout } = await runHook(root, 'branch-context.py', {});
  const payload = JSON.parse(stdout);
  const context = payload.hookSpecificOutput.additionalContext;

  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(context, /feat\/87-rules/);
  assert.match(context, /Issue: #87/);
});

test('branch watch emits the new profile-derived branch after a switch command', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, 'switch', '-c', 'fix/87-watch');

  const result = await runHook(root, 'branch-watch.py', {
    tool_name: 'Bash',
    tool_input: { command: 'git switch fix/87-watch' },
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(result.code, 0);
  assert.match(payload.systemMessage, /fix\/87-watch/);
  assert.match(payload.systemMessage, /Issue: #87/);
});

test('edit guard blocks a tracked file on the protected main worktree', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runHook(root, 'enforce-worktree.py', {
    tool_name: 'Edit',
    tool_input: { file_path: join(root, 'tracked.txt') },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /tracked\.txt/);
  assert.match(result.stderr, /worktree/i);
});

test('edit guard allows ignored scratch on the protected main worktree', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scratch'));

  const result = await runHook(root, 'enforce-worktree.py', {
    tool_name: 'Write',
    tool_input: { file_path: join(root, 'scratch', 'note.txt') },
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
});

test('linked worktree cannot edit an absolute tracked target in the protected main checkout', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const linked = join(root, '.sandboxes', 'feat-87-linked');
  await git(root, 'worktree', 'add', '-b', 'feat/87-linked', linked, 'main');

  const result = await runHook(linked, 'enforce-worktree.py', {
    tool_name: 'Edit',
    tool_input: { file_path: join(root, 'tracked.txt') },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /tracked\.txt/);
});

test('cwd guard blocks verification from protected main when a linked worktree is active', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const linked = join(root, '.sandboxes', 'feat-87-cwd');
  await git(root, 'worktree', 'add', '-b', 'feat/87-cwd', linked, 'main');

  const result = await runHook(root, 'enforce-worktree-cwd.py', {
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /npm test/);
  assert.match(result.stderr, /feat-87-cwd/);
});

test('cwd guard allows verification inside the linked worktree and explicit targeting from main', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const linked = join(root, '.sandboxes', 'feat-87-cwd-ok');
  await git(root, 'worktree', 'add', '-b', 'feat/87-cwd-ok', linked, 'main');

  const inside = await runHook(linked, 'enforce-worktree-cwd.py', {
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });
  const targeted = await runHook(root, 'enforce-worktree-cwd.py', {
    tool_name: 'Bash',
    tool_input: { command: `git -C ${linked} commit -m test` },
  });

  assert.equal(inside.code, 0);
  assert.equal(targeted.code, 0);
});

test('discipline guard blocks issue branch creation in main while worktrees are active', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const linked = join(root, '.sandboxes', 'feat-87-existing');
  await git(root, 'worktree', 'add', '-b', 'feat/87-existing', linked, 'main');

  const result = await runHook(root, 'enforce-worktree-discipline.py', {
    tool_name: 'Bash',
    tool_input: { command: 'git switch -c feat/99-new-slice' },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /feat\/99-new-slice/);
  assert.match(result.stderr, /scripts\/worktree-lifecycle\/setup\.py/);
});

test('unsupported and malformed hook events are fail-open and repository-neutral', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const hooks = [
    'branch-context.py',
    'branch-watch.py',
    'enforce-worktree.py',
    'enforce-worktree-cwd.py',
    'enforce-worktree-discipline.py',
    'slice-handoff-hint.py',
  ];
  const before = (await git(root, 'status', '--porcelain')).stdout;

  for (const hook of hooks) {
    const malformed = await runHook(root, hook, '{not-json');
    const unsupported = await runHook(root, hook, { tool_name: 'Unknown', tool_input: {} });
    assert.equal(malformed.code, 0, hook);
    assert.equal(unsupported.code, 0, hook);
  }

  assert.equal((await git(root, 'status', '--porcelain')).stdout, before);
  await assert.rejects(access(join(root, '.claude/logs')));
});

test('all five adapters are thin, core-driven, and shipped from the same bundle', async () => {
  const hooks = [
    'branch-context.py',
    'branch-watch.py',
    'enforce-worktree.py',
    'enforce-worktree-cwd.py',
    'enforce-worktree-discipline.py',
  ];
  const shipped = new Set(HELPER_FILES.map(({ path }) => path));
  assert.equal(shipped.has('scripts/worktree-lifecycle/profile.py'), true);
  assert.equal(shipped.has('scripts/worktree-lifecycle/README.md'), true);

  for (const hook of hooks) {
    const source = await readFile(join(HOOKS, hook), 'utf8');
    assert.match(source, /load_worktree_lifecycle_core/);
    assert.doesNotMatch(source, /import re|git worktree|branchRegex/);
    assert.equal(shipped.has(`.claude/hooks/${hook}`), true, hook);
  }
});

test('frozen Testreporter profile preserves the five historical guard outcomes', async (t) => {
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
  const tracked = await runHook(root, 'enforce-worktree.py', {
    tool_name: 'Edit',
    tool_input: { file_path: join(root, 'tracked.txt') },
  });
  const linkedCwd = await runHook(linked, 'enforce-worktree-cwd.py', {
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });
  const ignored = await runHook(root, 'enforce-worktree.py', {
    tool_name: 'Write',
    tool_input: { file_path: join(root, 'scratch', 'note.txt') },
  });
  const switched = await runHook(linked, 'branch-watch.py', {
    tool_name: 'Bash',
    tool_input: { command: 'git switch feat/87-parity' },
  });

  assert.equal(maintenance.code, 0);
  assert.equal(tracked.code, 2);
  assert.equal(linkedCwd.code, 0);
  assert.equal(ignored.code, 0);
  assert.match(JSON.parse(switched.stdout).systemMessage, /feat\/87-parity/);
});

test('handoff advisory names the configured setup entry instead of a hardcoded script', async (t) => {
  const profile = structuredClone(GENERIC_PROFILE);
  profile.worktreeLifecycle.setupEntry = './tools/make-tree';
  const root = await fixture(profile);
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runHook(root, 'slice-handoff-hint.py', {
    prompt: 'Worktree: ./tools/make-tree 516 async-local-storage',
  });
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;

  assert.equal(result.code, 0);
  assert.match(context, /\.\/tools\/make-tree 516 async-local-storage/);
  assert.doesNotMatch(context, /setup-worktree\.sh/);
});
