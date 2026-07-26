import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const SESSION = resolve('scripts/worktree-lifecycle/session.py');

async function command(file, args, cwd, options = {}) {
  return exec(file, args, { cwd, encoding: 'utf8', ...options });
}

async function git(cwd, ...args) {
  return command('git', args, cwd);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'awkit-session-teardown-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '--initial-branch=main');
  await git(repo, 'config', 'user.name', 'Test User');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'seed.txt'), 'seed\n');
  await mkdir(join(repo, 'docs/agents'), { recursive: true });
  await writeFile(join(repo, 'docs/agents/workflow-capabilities.json'), JSON.stringify({
    version: 1,
    worktreeLifecycle: {
      enabled: true,
      worktreeRoot: '.worktrees',
      branchTemplate: '{type}/{issue}-{slug}',
      pathTemplate: '{type}-{issue}-{slug}',
      branchRegex: '^(?:feat|fix|chore)/(?P<issue>\\d+)-',
      mainBranches: ['main'],
      protectedBranches: ['main'],
      setupSteps: [],
      scratchPatterns: [],
    },
  }));
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'seed');
  return { root, repo };
}

async function plantClaim(repo, anchor = '42', owner = 'run-alpha') {
  const payload = JSON.stringify({
    contractVersion: 1,
    anchor,
    owner,
    createdAt: '2026-07-26T00:00:00.000Z',
    sliceBranches: [],
  });
  await git(repo, 'tag', '-a', `wave-active/${anchor}`, '-m', payload);
}

async function fakeGh(root, name, { stdout = '[]\n', exitCode = 0 } = {}) {
  const path = join(root, name);
  await writeFile(
    path,
    `#!/usr/bin/env bash\nprintf '%s' '${stdout.replaceAll("'", "'\"'\"'")}'\nexit ${exitCode}\n`,
  );
  await chmod(path, 0o755);
  return path;
}

async function session(repo, action, ...args) {
  const result = await command('python3', [
    SESSION,
    action,
    '--anchor', '42',
    '--owner', 'run-alpha',
    ...args,
  ], repo);
  return JSON.parse(result.stdout);
}

test('session receipt removes only its patch-equivalent target and leaves a foreign twin untouched', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  const begun = await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '101', 'owned', 'feat');
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await git(repo, 'branch', 'feat/999-foreign-twin', ownedOid);

  await session(repo, 'seal');
  await writeFile(join(repo, 'coordinator.txt'), 'coordinator\n');
  await git(repo, 'add', 'coordinator.txt');
  await git(repo, 'commit', '-m', 'coordinator integration base');
  await git(repo, 'cherry-pick', ownedOid);

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, true);
  assert.equal(preview.targets[0].integration, 'patch-equivalent');

  const teardown = await session(repo, 'teardown', '--main', 'main', '--gh-command', 'false');
  assert.equal(teardown.removed, true);
  await assert.rejects(git(repo, 'show-ref', '--verify', 'refs/heads/feat/101-owned'));
  assert.match((await git(repo, 'show-ref', '--verify', 'refs/heads/feat/999-foreign-twin')).stdout, /refs\/heads\/feat\/999-foreign-twin/);
  const archived = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(archived.state, 'complete');
  assert.equal(archived.targets[0].recoveryOid, ownedOid);
});

test('an empty commit has no provable patch identity and stops teardown', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '102', 'empty', 'feat');
  await git(created.worktree, 'commit', '--allow-empty', '-m', 'metadata only');
  await session(repo, 'seal');

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.equal(preview.targets[0].integration, 'ambiguous');
  await assert.rejects(
    session(repo, 'teardown', '--main', 'main', '--gh-command', 'false'),
    /ambiguous patch identity/,
  );
  assert.match((await git(repo, 'show-ref', '--verify', 'refs/heads/feat/102-empty')).stdout, /feat\/102-empty/);
});

test('a non-ancestry merge commit is ambiguous and stops teardown', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '103', 'merge', 'feat');
  await git(created.worktree, 'switch', '-c', 'side/merge-input');
  await writeFile(join(created.worktree, 'side.txt'), 'side\n');
  await git(created.worktree, 'add', 'side.txt');
  await git(created.worktree, 'commit', '-m', 'side change');
  await git(created.worktree, 'switch', 'feat/103-merge');
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  await git(created.worktree, 'merge', '--no-ff', 'side/merge-input', '-m', 'merge side');
  await session(repo, 'seal');

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.equal(preview.targets[0].integration, 'ambiguous');
  assert.match(
    preview.targets[0].commits.map(({ reason }) => reason ?? '').join('\n'),
    /merge commit/,
  );
});

test('a cherry-picked mode change has one stable patch identity', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '104', 'mode', 'feat');
  await chmod(join(created.worktree, 'seed.txt'), 0o755);
  await git(created.worktree, 'add', 'seed.txt');
  await git(created.worktree, 'commit', '-m', 'make seed executable');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await writeFile(join(repo, 'coordinator.txt'), 'coordinator\n');
  await git(repo, 'add', 'coordinator.txt');
  await git(repo, 'commit', '-m', 'coordinator integration base');
  await git(repo, 'cherry-pick', ownedOid);

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, true);
  assert.equal(preview.targets[0].integration, 'patch-equivalent');
});

test('unique owned patch content remains a hard stop', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '105', 'unique', 'feat');
  await writeFile(join(created.worktree, 'unique.txt'), 'not integrated\n');
  await git(created.worktree, 'add', 'unique.txt');
  await git(created.worktree, 'commit', '-m', 'unique change');
  await session(repo, 'seal');

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.equal(preview.targets[0].integration, 'unique-patch');
  await assert.rejects(
    session(repo, 'teardown', '--main', 'main', '--gh-command', 'false'),
    /unique patch content/,
  );
});

test('an ancestry-merged owned target is reported separately and removable', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '106', 'ancestor', 'feat');
  await writeFile(join(created.worktree, 'ancestor.txt'), 'integrated\n');
  await git(created.worktree, 'add', 'ancestor.txt');
  await git(created.worktree, 'commit', '-m', 'ancestry change');
  await session(repo, 'seal');
  await git(repo, 'merge', '--no-ff', 'feat/106-ancestor', '-m', 'merge owned branch');

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, true);
  assert.equal(preview.targets[0].integration, 'ancestry-merged');
});

test('open PR evidence and PR lookup errors both fail closed', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  await git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'));

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '107', 'pr', 'feat');
  await writeFile(join(created.worktree, 'pr.txt'), 'integrated\n');
  await git(created.worktree, 'add', 'pr.txt');
  await git(created.worktree, 'commit', '-m', 'PR change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await writeFile(join(repo, 'coordinator.txt'), 'coordinator\n');
  await git(repo, 'add', 'coordinator.txt');
  await git(repo, 'commit', '-m', 'coordinator integration base');
  await git(repo, 'cherry-pick', ownedOid);

  const openGh = await fakeGh(root, 'gh-open', {
    stdout: '[{"number":12,"state":"OPEN","mergedAt":null}]\n',
  });
  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', openGh);
  assert.equal(preview.removable, false);
  assert.deepEqual(preview.targets[0].reasons, ['open PR']);

  const brokenGh = await fakeGh(root, 'gh-broken', { stdout: 'network down\n', exitCode: 2 });
  await assert.rejects(
    session(repo, 'inspect', '--main', 'main', '--gh-command', brokenGh),
    /cannot determine PR state/,
  );
});

test('create refuses a branch or worktree path that pre-existed the run', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  await git(repo, 'branch', 'feat/108-preexisting', 'main');

  await assert.rejects(
    session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '108', 'preexisting', 'feat'),
    /branch pre-existed this run/,
  );
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.deepEqual(receipt.targets, []);
});

test('failed setup rolls back the newly created target without recording ownership', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const profilePath = join(repo, 'docs/agents/workflow-capabilities.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.worktreeLifecycle.setupSteps = [{
    kind: 'command',
    command: ['node', '-e', 'process.exit(23)'],
  }];
  await writeFile(profilePath, JSON.stringify(profile));

  await assert.rejects(
    session(repo, 'create', '--profile', profilePath, '108', 'rollback', 'feat'),
    /failed/,
  );
  await assert.rejects(git(repo, 'show-ref', '--verify', 'refs/heads/feat/108-rollback'));
  assert.doesNotMatch((await git(repo, 'worktree', 'list')).stdout, /feat-108-rollback/);
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.deepEqual(receipt.targets, []);
});

test('a write after seal makes the owned worktree dirty and blocks cleanup', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '109', 'dirty', 'feat');
  await writeFile(join(created.worktree, 'owned.txt'), 'integrated\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await writeFile(join(repo, 'coordinator.txt'), 'coordinator\n');
  await git(repo, 'add', 'coordinator.txt');
  await git(repo, 'commit', '-m', 'coordinator integration base');
  await git(repo, 'cherry-pick', ownedOid);
  await writeFile(join(created.worktree, 'late.txt'), 'late\n');

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.match(preview.targets[0].reasons.join('\n'), /dirty worktree/);
});

test('a branch that becomes protected after creation is never removed', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '110', 'protected', 'feat');
  await writeFile(join(created.worktree, 'owned.txt'), 'integrated\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  await session(repo, 'seal');
  await git(repo, 'merge', '--no-ff', 'feat/110-protected', '-m', 'merge owned branch');

  const profilePath = join(repo, 'docs/agents/workflow-capabilities.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.worktreeLifecycle.protectedBranches.push('feat/110-protected');
  await writeFile(profilePath, JSON.stringify(profile));

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.match(preview.targets[0].reasons.join('\n'), /protected branch/);
});

test('a concurrent branch move after seal is an unexpected-OID hard stop', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  const begun = await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '111', 'moved', 'feat');
  await writeFile(join(created.worktree, 'owned.txt'), 'integrated\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await writeFile(join(repo, 'coordinator.txt'), 'coordinator\n');
  await git(repo, 'add', 'coordinator.txt');
  await git(repo, 'commit', '-m', 'coordinator integration base');
  await git(repo, 'cherry-pick', ownedOid);

  await git(created.worktree, 'commit', '--allow-empty', '-m', 'late move');
  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.match(preview.targets[0].reasons.join('\n'), /unexpected OID/);
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(receipt.targets[0].expectedOid, ownedOid);
  assert.equal(receipt.targets[0].removed, false);
});

test('receipt access is bound to the active claim owner, anchor, repository, and base OID', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await assert.rejects(
    command('python3', [
      SESSION, 'begin', '--anchor', '42', '--owner', 'run-beta', '--base', 'main',
    ], repo),
    /another or incoherent run/,
  );
  const begun = await session(repo, 'begin', '--base', 'main');
  await writeFile(join(repo, 'later.txt'), 'later\n');
  await git(repo, 'add', 'later.txt');
  await git(repo, 'commit', '-m', 'move main');
  await assert.rejects(
    session(repo, 'begin', '--base', 'main'),
    /different base OID/,
  );

  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  receipt.repoRoot = join(root, 'foreign-repo');
  await writeFile(begun.receipt, JSON.stringify(receipt));
  await assert.rejects(
    session(repo, 'seal'),
    /another or incoherent run/,
  );
});

test('a patch-id with multiple canonical-main matches is ambiguous', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '112', 'ambiguous', 'feat');
  await writeFile(join(created.worktree, 'repeat.txt'), 'repeat\n');
  await git(created.worktree, 'add', 'repeat.txt');
  await git(created.worktree, 'commit', '-m', 'repeatable patch');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await writeFile(join(repo, 'coordinator.txt'), 'coordinator\n');
  await git(repo, 'add', 'coordinator.txt');
  await git(repo, 'commit', '-m', 'coordinator integration base');
  await git(repo, 'cherry-pick', ownedOid);
  const firstApplication = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  await git(repo, 'revert', '--no-edit', firstApplication);
  await git(repo, 'cherry-pick', ownedOid);

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.equal(preview.targets[0].integration, 'ambiguous');
  assert.match(preview.targets[0].commits[0].reason, /not one-to-one/);
});

test('compare-and-delete preserves a concurrently moved branch and its recovery OID', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  const begun = await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '113', 'race', 'feat');
  await writeFile(join(created.worktree, 'race.txt'), 'integrated\n');
  await git(created.worktree, 'add', 'race.txt');
  await git(created.worktree, 'commit', '-m', 'race change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await writeFile(join(repo, 'coordinator.txt'), 'coordinator\n');
  await git(repo, 'add', 'coordinator.txt');
  await git(repo, 'commit', '-m', 'coordinator integration base');
  await git(repo, 'cherry-pick', ownedOid);
  const movedOid = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();

  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  const marker = join(root, 'moved.once');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2 $3" == "update-ref -d refs/heads/feat/113-race" && ! -e "$RACE_MARKER" ]]; then
  : > "$RACE_MARKER"
  "${realGit}" update-ref refs/heads/feat/113-race "$RACE_OID"
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);

  await assert.rejects(
    command('python3', [
      SESSION, 'teardown', '--anchor', '42', '--owner', 'run-alpha',
      '--main', 'main', '--gh-command', 'false',
    ], repo, {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        RACE_MARKER: marker,
        RACE_OID: movedOid,
      },
    }),
    /concurrent branch move/,
  );
  assert.equal(
    (await git(repo, 'rev-parse', 'refs/heads/feat/113-race')).stdout.trim(),
    movedOid,
  );
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(receipt.state, 'tearing-down');
  assert.equal(receipt.targets[0].recoveryOid, ownedOid);
});
