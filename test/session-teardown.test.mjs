import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod, copyFile, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile,
} from 'node:fs/promises';
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
  await writeFile(join(repo, '.gitignore'), '.worktrees/\ndist-kit/\n');
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
    wrapup: {
      landingGeneratedArtifactPatterns: ['dist-kit/**'],
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

async function mutatingGh(root, name, trigger, mutation, triggerStdout = '[]') {
  const path = join(root, name);
  const count = join(root, `${name}.count`);
  await writeFile(
    path,
    `#!/usr/bin/env bash
value=0
if [[ -f "$GH_COUNT_FILE" ]]; then value="$(cat "$GH_COUNT_FILE")"; fi
value=$((value + 1))
printf '%s' "$value" > "$GH_COUNT_FILE"
if [[ "$value" -eq "$GH_TRIGGER" ]]; then
  eval "$GH_MUTATION"
  printf '%s' "$GH_TRIGGER_STDOUT"
  exit 0
fi
printf '%s' '[]'
`,
  );
  await chmod(path, 0o755);
  return {
    path,
    env: {
      ...process.env,
      GH_COUNT_FILE: count,
      GH_TRIGGER: String(trigger),
      GH_MUTATION: mutation,
      GH_TRIGGER_STDOUT: triggerStdout,
    },
  };
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
  const createdReceipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.match(createdReceipt.targets[0].artifactBaselineDigest, /^[0-9a-f]{64}$/);
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
  assert.equal(
    (await git(repo, 'for-each-ref', '--format=%(refname)', 'refs/agent-workflow-kit/session-owned')).stdout,
    '',
  );
  assert.match((await git(repo, 'show-ref', '--verify', 'refs/heads/feat/999-foreign-twin')).stdout, /refs\/heads\/feat\/999-foreign-twin/);
  const archived = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(archived.state, 'complete');
  assert.equal(archived.targets[0].recoveryOid, ownedOid);
});

test('normal teardown hard-stops when its ownership proof disappears', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const created = await session(
    repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json',
    '127', 'missing-proof', 'feat',
  );
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  await git(repo, 'update-ref', '-d', receipt.targets[0].proofRef);

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.match(preview.targets[0].reasons.join('\n'), /ownership proof/);
  await assert.rejects(
    session(repo, 'teardown', '--main', 'main', '--gh-command', 'false'),
    /ownership proof/,
  );
  assert.match(
    (await git(repo, 'show-ref', '--verify', `refs/heads/${created.branch}`)).stdout,
    /feat\/127-missing-proof/,
  );
});

test('session teardown accepts only generated files absent from its creation baseline', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '114', 'generated', 'feat');
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await mkdir(join(created.worktree, 'dist-kit'), { recursive: true });
  await writeFile(join(created.worktree, 'dist-kit/package.tgz'), 'generated\n');
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, true);
  assert.deepEqual(preview.targets[0].scratchFiles, ['dist-kit/package.tgz']);
  await session(repo, 'teardown', '--main', 'main', '--gh-command', 'false');
  assert.equal(await git(repo, 'show-ref', '--verify', 'refs/heads/main').then(() => true), true);
});

test('session teardown preserves a same-path replacement after its frozen preview', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '134', 'artifact-race', 'feat');
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await mkdir(join(created.worktree, 'dist-kit'), { recursive: true });
  const generated = join(created.worktree, 'dist-kit/package.tgz');
  await writeFile(generated, 'generator-owned\n');
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);
  await git(repo, 'init', '--bare', join(root, 'remote.git'));
  await git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'));
  const fake = await mutatingGh(
    root,
    'mutate-artifact-on-revalidate',
    2,
    `rm -f '${generated}'; printf '%s\\n' 'user replacement' > '${generated}'`,
  );

  await assert.rejects(
    command('python3', [
      SESSION, 'teardown', '--anchor', '42', '--owner', 'run-alpha',
      '--main', 'main', '--gh-command', fake.path,
    ], repo, { env: fake.env }),
    /teardown inventory changed|scratch evidence changed|identity changed/,
  );
  assert.equal(await readFile(generated, 'utf8'), 'user replacement\n');
  assert.match(
    (await git(repo, 'show-ref', '--verify', `refs/heads/${created.branch}`)).stdout,
    /artifact-race/,
  );
});

test('a missing session artifact baseline is a cleanup hard stop', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '121', 'missing-baseline', 'feat');
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);
  const gitDir = (await git(created.worktree, 'rev-parse', '--absolute-git-dir')).stdout.trim();
  await rm(join(gitDir, 'awkit-artifact-baseline-v1.json'));

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.match(preview.targets[0].reasons.join('\n'), /artifact provenance baseline/);
});

test('a mutated session artifact baseline is a cleanup hard stop', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '122', 'mutated-baseline', 'feat');
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);
  const gitDir = (await git(created.worktree, 'rev-parse', '--absolute-git-dir')).stdout.trim();
  const baselinePath = join(gitDir, 'awkit-artifact-baseline-v1.json');
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  baseline.sha256 = '0'.repeat(64);
  await writeFile(baselinePath, JSON.stringify(baseline));

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.match(preview.targets[0].reasons.join('\n'), /artifact provenance baseline/);
});

test('a removed receipt target that is recreated is a hard stop', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  const begun = await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '115', 'recreated', 'feat');
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);
  await session(repo, 'teardown', '--main', 'main', '--gh-command', 'false');

  const archived = JSON.parse(await readFile(begun.receipt, 'utf8'));
  await git(repo, 'branch', archived.targets[0].branch, archived.targets[0].recoveryOid);
  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.match(preview.targets[0].reasons.join('\n'), /removed target was recreated/);
});

test('a missing worktree directory with stale Git registration is a hard stop', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '116', 'stale', 'feat');
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);
  await rm(created.worktree, { recursive: true });

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.match(preview.targets[0].reasons.join('\n'), /directory is missing.*registration remains/);
});

test('later-target dirt stops immediately while completed target recovery stays resumable', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  await git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'));

  const begun = await session(repo, 'begin', '--base', 'main');
  const first = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '117', 'first', 'feat');
  const second = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '118', 'second', 'feat');
  for (const [created, name] of [[first, 'first'], [second, 'second']]) {
    await writeFile(join(created.worktree, `${name}.txt`), `${name}\n`);
    await git(created.worktree, 'add', `${name}.txt`);
    await git(created.worktree, 'commit', '-m', `${name} change`);
  }
  const firstOid = (await git(first.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  const secondOid = (await git(second.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', firstOid);
  await git(repo, 'cherry-pick', secondOid);

  const gh = await mutatingGh(
    root,
    'gh-dirty-later',
    10,
    `printf '%s\\n' late > '${join(second.worktree, 'late.txt')}'`,
  );
  await assert.rejects(
    command('python3', [
      SESSION, 'teardown', '--anchor', '42', '--owner', 'run-alpha',
      '--main', 'main', '--gh-command', gh.path,
    ], repo, { env: gh.env }),
    /dirty worktree/,
  );

  await assert.rejects(git(repo, 'show-ref', '--verify', 'refs/heads/feat/117-first'));
  assert.match(
    (await git(repo, 'show-ref', '--verify', 'refs/heads/feat/118-second')).stdout,
    /feat\/118-second/,
  );
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(receipt.state, 'tearing-down');
  assert.equal(receipt.targets[0].removed, true);
  assert.equal(receipt.targets[0].recoveryOid, firstOid);
  assert.equal(receipt.targets[1].removed, false);
  assert.equal(receipt.targets[1].recoveryOid, secondOid);
});

test('a PR opened after worktree removal stops the compare-delete and preserves recovery', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  await git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'));

  const begun = await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '119', 'late-pr', 'feat');
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);

  const gh = await mutatingGh(
    root,
    'gh-open-after-worktree',
    5,
    ':',
    '[{"number":19,"state":"OPEN","mergedAt":null}]',
  );
  await assert.rejects(
    command('python3', [
      SESSION, 'teardown', '--anchor', '42', '--owner', 'run-alpha',
      '--main', 'main', '--gh-command', gh.path,
    ], repo, { env: gh.env }),
    /(?:target changed before mutation: .*open PR|open PR before branch cleanup)/,
  );
  assert.match(
    (await git(repo, 'show-ref', '--verify', 'refs/heads/feat/119-late-pr')).stdout,
    /feat\/119-late-pr/,
  );
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(receipt.state, 'tearing-down');
  assert.equal(receipt.targets[0].removed, false);
  assert.equal(receipt.targets[0].recoveryOid, ownedOid);
});

test('a broken symlink injected after assessment stops final ref cleanup', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  await git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'));
  await session(repo, 'begin', '--base', 'main');
  const created = await session(
    repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json',
    '135', 'late-symlink', 'feat',
  );
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);
  const displaced = `${created.worktree}-displaced`;
  const gh = await mutatingGh(
    root,
    'gh-late-symlink',
    6,
    `mv '${created.worktree}' '${displaced}'; ln -s missing-foreign '${created.worktree}'`,
  );

  await assert.rejects(
    command('python3', [
      SESSION, 'teardown', '--anchor', '42', '--owner', 'run-alpha',
      '--main', 'main', '--gh-command', gh.path,
    ], repo, { env: gh.env }),
    /worktree identity changed before branch cleanup/,
  );
  assert.match(
    (await git(repo, 'show-ref', '--verify', `refs/heads/${created.branch}`)).stdout,
    /late-symlink/,
  );
});

test('a replacement worktree root never inherits the receipt identity', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);

  await session(repo, 'begin', '--base', 'main');
  const created = await session(repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json', '120', 'root-race', 'feat');
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);

  const displaced = `${created.worktree}-displaced`;
  await rename(created.worktree, displaced);
  await mkdir(created.worktree);
  await copyFile(join(displaced, '.git'), join(created.worktree, '.git'));
  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.match(preview.targets[0].reasons.join('\n'), /worktree root identity changed/);
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

test('atomic ownership acquisition leaves a racing foreign branch untouched', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "update-ref --stdin" ]]; then
  payload="$(cat)"
  if [[ "$payload" == *"create refs/heads/feat/124-foreign-race "* ]]; then
    "${realGit}" branch feat/124-foreign-race HEAD
  fi
  printf '%s\\n' "$payload" | "${realGit}" "$@"
  exit $?
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);

  await assert.rejects(
    command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', 'docs/agents/workflow-capabilities.json',
      '--gh-command', 'false', '124', 'foreign-race', 'feat',
    ], repo, { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } }),
    /ref-acquisition/,
  );
  assert.match(
    (await git(repo, 'show-ref', '--verify', 'refs/heads/feat/124-foreign-race')).stdout,
    /feat\/124-foreign-race/,
  );
  assert.equal(
    (await git(repo, 'for-each-ref', '--format=%(refname)', 'refs/agent-workflow-kit/session-owned')).stdout,
    '',
  );
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.deepEqual(receipt.targets, []);
  assert.equal(receipt.recoveredTargets[0].branch, 'feat/124-foreign-race');
  assert.equal(receipt.recoveredTargets[0].acquisitionState, 'failed');
  assert.match(
    (await git(repo, 'show-ref', '--verify', 'refs/heads/feat/124-foreign-race')).stdout,
    /feat\/124-foreign-race/,
  );
  const sealed = await session(repo, 'seal');
  assert.equal(sealed.state, 'sealed');
});

test('branch acquisition atomically verifies the active claim', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "update-ref --stdin" ]]; then
  "${realGit}" tag -f -a wave-active/42 -m '{"contractVersion":1,"anchor":"42","owner":"foreign-race"}'
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);
  await assert.rejects(
    command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', 'docs/agents/workflow-capabilities.json',
      '133', 'claim-race', 'feat',
    ], repo, { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } }),
    /ref-acquisition/,
  );
  await assert.rejects(git(repo, 'show-ref', '--verify', 'refs/heads/feat/133-claim-race'));
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(receipt.targets[0].acquisitionState, 'failed');
});

test('an exact clean foreign worktree without the proof ref is never adopted', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  const foreignPath = join(repo, '.worktrees', 'feat-125-foreign-worktree');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "update-ref --stdin" ]]; then
  payload="$(cat)"
  if [[ "$payload" == *"create refs/heads/feat/125-foreign-worktree "* ]]; then
    "${realGit}" worktree add "$FOREIGN_PATH" -b feat/125-foreign-worktree HEAD
  fi
  printf '%s\\n' "$payload" | "${realGit}" "$@"
  exit $?
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);

  await assert.rejects(
    command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', 'docs/agents/workflow-capabilities.json',
      '--gh-command', 'false', '125', 'foreign-worktree', 'feat',
    ], repo, {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FOREIGN_PATH: foreignPath,
      },
    }),
    /ref-acquisition/,
  );
  assert.equal((await git(foreignPath, 'status', '--porcelain')).stdout, '');
  assert.match((await git(repo, 'worktree', 'list')).stdout, /feat-125-foreign-worktree/);
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.deepEqual(receipt.targets, []);
  assert.equal(receipt.recoveredTargets[0].branch, 'feat/125-foreign-worktree');
});

test('a failed acquisition never adopts a racing branch and matching proof ref', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "update-ref --stdin" ]]; then
  payload="$(cat)"
  if [[ "$payload" == *"create refs/heads/feat/129-proof-collision "* ]]; then
    oid="$(printf '%s\\n' "$payload" | awk '$1 == "create" && $2 ~ /^refs\\/heads/ { print $3 }')"
    proof="$(printf '%s\\n' "$payload" | awk '$1 == "create" && $2 ~ /^refs\\/agent-workflow-kit/ { print $2 }')"
    "${realGit}" update-ref refs/heads/feat/129-proof-collision "$oid"
    "${realGit}" update-ref "$proof" "$oid"
  fi
  printf '%s\\n' "$payload" | "${realGit}" "$@"
  exit $?
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);

  await assert.rejects(
    command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', 'docs/agents/workflow-capabilities.json',
      '--gh-command', 'false', '129', 'proof-collision', 'feat',
    ], repo, { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` } }),
    /ref-acquisition/,
  );
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(receipt.targets[0].acquisitionState, 'failed');
  assert.match(
    (await git(repo, 'show-ref', '--verify', 'refs/heads/feat/129-proof-collision')).stdout,
    /proof-collision/,
  );
  assert.equal(
    (await git(repo, 'rev-parse', receipt.targets[0].proofRef)).stdout.trim(),
    receipt.targets[0].createdOid,
  );
});

test('invalid branch text is rejected before any ownership journal or transaction', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  await assert.rejects(
    session(
      repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json',
      '128', 'bad\ncreate refs/heads/foreign', 'feat',
    ),
    /valid branch name/,
  );
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.deepEqual(receipt.targets, []);
});

test('create never runs setup through a symlink-substituted worktree root', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const profilePath = join(repo, 'docs/agents/workflow-capabilities.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.worktreeLifecycle.setupSteps = [{
    kind: 'command',
    command: ['sh', '-c', 'printf setup-ran > setup-ran-in-foreign.txt'],
  }];
  await writeFile(profilePath, JSON.stringify(profile));
  await session(repo, 'begin', '--base', 'main');
  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "worktree add" ]]; then
  target="$3"
  "${realGit}" "$@"
  status=$?
  if [[ "$status" -eq 0 ]]; then
    mv "$target" "$target.original"
    ln -s "$MAIN_REPO" "$target"
  fi
  exit "$status"
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);

  await assert.rejects(
    command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', 'docs/agents/workflow-capabilities.json',
      '--gh-command', 'false', '135', 'root-symlink', 'feat',
    ], repo, {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAIN_REPO: repo,
      },
    }),
    /root-journal/,
  );
  await assert.rejects(readFile(join(repo, 'setup-ran-in-foreign.txt'), 'utf8'));
  assert.equal(
    (await git(repo, 'status', '--porcelain', '--', 'setup-ran-in-foreign.txt')).stdout,
    '',
  );
});

test('create never adopts a substituted real directory with a copied backlink', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const profilePath = join(repo, 'docs/agents/workflow-capabilities.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.worktreeLifecycle.setupSteps = [{
    kind: 'command',
    command: ['sh', '-c', 'printf setup-ran > setup-ran-in-replacement.txt'],
  }];
  await writeFile(profilePath, JSON.stringify(profile));
  await session(repo, 'begin', '--base', 'main');
  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "worktree add" ]]; then
  target="$3"
  "${realGit}" "$@"
  status=$?
  if [[ "$status" -eq 0 ]]; then
    mv "$target" "$target.original"
    mkdir "$target"
    cp "$target.original/.git" "$target/.git"
  fi
  exit "$status"
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);
  const target = join(repo, '.worktrees', 'feat-136-root-directory');

  await assert.rejects(
    command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', 'docs/agents/workflow-capabilities.json',
      '--gh-command', 'false', '136', 'root-directory', 'feat',
    ], repo, {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    }),
    /root-journal/,
  );
  await assert.rejects(readFile(join(target, 'setup-ran-in-replacement.txt'), 'utf8'));
  await assert.rejects(readFile(join(repo, 'setup-ran-in-replacement.txt'), 'utf8'));
});

test('create never follows a substituted worktree parent after ref acquisition', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const profilePath = join(repo, 'docs/agents/workflow-capabilities.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.worktreeLifecycle.setupSteps = [{
    kind: 'command',
    command: ['sh', '-c', 'printf setup-ran > setup-ran-in-foreign-parent.txt'],
  }];
  await writeFile(profilePath, JSON.stringify(profile));
  await session(repo, 'begin', '--base', 'main');
  await mkdir(join(repo, '.worktrees'), { recursive: true });
  const foreign = join(root, 'foreign-parent');
  await mkdir(foreign);
  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "update-ref --stdin" && ! -f "$RACE_MARKER" ]]; then
  payload="$(cat)"
  printf '%s\\n' "$payload" | "${realGit}" "$@"
  status=$?
  if [[ "$status" -eq 0 ]]; then
    : > "$RACE_MARKER"
    mv "$MAIN_REPO/.worktrees" "$MAIN_REPO/.worktrees.original"
    ln -s "$FOREIGN_PARENT" "$MAIN_REPO/.worktrees"
  fi
  exit "$status"
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);

  await assert.rejects(
    command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', 'docs/agents/workflow-capabilities.json',
      '--gh-command', 'false', '137', 'parent-symlink', 'feat',
    ], repo, {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAIN_REPO: repo,
        FOREIGN_PARENT: foreign,
        RACE_MARKER: join(root, 'parent-race-fired'),
      },
    }),
    /root-preparation/,
  );
  await assert.rejects(readFile(join(foreign, 'setup-ran-in-foreign-parent.txt'), 'utf8'));
  assert.deepEqual(await readdir(foreign), []);
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
    command: [
      'node', '-e',
      "require('fs').writeFileSync('setup-owned.txt','owned\\n');process.exit(23)",
    ],
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

test('a branch-only worktree-add remainder is compare-deleted from provisional ownership', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "worktree add" ]]; then
  "${realGit}" branch "$5" "$6"
  printf '%s\\n' 'SECRET_BRANCH_ONLY_CANARY' >&2
  exit 91
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);

  let failure;
  try {
    await command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', 'docs/agents/workflow-capabilities.json',
      '--gh-command', 'false', '116', 'branch-only', 'feat',
    ], repo, {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.doesNotMatch(`${failure.stdout}${failure.stderr}${failure.message}`, /SECRET_BRANCH_ONLY_CANARY/);
  await assert.rejects(git(repo, 'show-ref', '--verify', 'refs/heads/feat/116-branch-only'));
  assert.equal(
    (await git(repo, 'for-each-ref', '--format=%(refname)', 'refs/agent-workflow-kit/session-owned')).stdout,
    '',
  );
  const receiptText = await readFile(begun.receipt, 'utf8');
  assert.doesNotMatch(receiptText, /SECRET_BRANCH_ONLY_CANARY|"failure":/);
  const receipt = JSON.parse(receiptText);
  assert.deepEqual(receipt.targets, []);
  assert.equal(receipt.recoveredTargets.at(-1).failureClass, 'worktree-add');
});

test('recovery rechecks PR and claim immediately before its first mutation', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  await git(repo, 'remote', 'add', 'origin', join(root, 'remote.git'));
  const begun = await session(repo, 'begin', '--base', 'main');
  const created = await session(
    repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json',
    '126', 'recovery-gates', 'feat',
  );
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  receipt.targets[0].state = 'recovery-pending';
  receipt.targets[0].setupCreatedFiles = [];
  receipt.targets[0].setupTrackedEvidence = {
    paths: [],
    worktreeDiffSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    indexDiffSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  };
  receipt.targets[0].evidenceState = 'complete';
  await writeFile(begun.receipt, JSON.stringify(receipt));

  const openGh = await fakeGh(root, 'gh-open-recovery', {
    stdout: '[{"number":26,"state":"OPEN","mergedAt":null}]',
  });
  await assert.rejects(
    session(repo, 'recover', '--branch', created.branch, '--gh-command', openGh),
    /open PR during creation recovery/,
  );
  assert.equal((await git(created.worktree, 'status', '--porcelain')).stdout, '');

  const claimRace = await mutatingGh(
    root,
    'gh-claim-race',
    1,
    'git tag -d wave-active/42 >/dev/null',
  );
  await assert.rejects(
    command('python3', [
      SESSION, 'recover', '--anchor', '42', '--owner', 'run-alpha',
      '--branch', created.branch, '--gh-command', claimRace.path,
    ], repo, { env: claimRace.env }),
    /active wave claim is missing/,
  );
  assert.match(
    (await git(repo, 'show-ref', '--verify', `refs/heads/${created.branch}`)).stdout,
    new RegExp(created.branch.replaceAll('/', '\\/')),
  );
  assert.match((await git(repo, 'worktree', 'list')).stdout, /feat-126-recovery-gates/);
});

test('a real worktree add followed by wrapper failure is recovered from Git backlinks', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "worktree add" ]]; then
  "${realGit}" "$@" || exit $?
  printf '%s\\n' 'SECRET_POST_ADD_CANARY' >&2
  exit 92
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);

  let failure;
  try {
    await command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', 'docs/agents/workflow-capabilities.json',
      '--gh-command', 'false', '117', 'post-add', 'feat',
    ], repo, {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.doesNotMatch(`${failure.stdout}${failure.stderr}${failure.message}`, /SECRET_POST_ADD_CANARY/);
  await assert.rejects(git(repo, 'show-ref', '--verify', 'refs/heads/feat/117-post-add'));
  assert.doesNotMatch((await git(repo, 'worktree', 'list')).stdout, /feat-117-post-add/);
  const receiptText = await readFile(begun.receipt, 'utf8');
  assert.doesNotMatch(receiptText, /SECRET_POST_ADD_CANARY|"failure":/);
  assert.deepEqual(JSON.parse(receiptText).targets, []);
});

test('failed setup freezes tracked and symlink identity without leaking command stderr', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const profilePath = join(repo, 'docs/agents/workflow-capabilities.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.worktreeLifecycle.setupSteps = [
    {
      kind: 'command',
      command: ['node', '-e', "require('fs').writeFileSync('seed.txt','setup\\n')"],
    },
    { kind: 'command', command: ['git', 'add', 'seed.txt'] },
    {
      kind: 'command',
      command: [
        'node', '-e',
        "require('fs').symlinkSync('private-target','setup-link');"
          + "process.stderr.write('SECRET_SETUP_CANARY\\n');process.exit(23)",
      ],
    },
  ];
  await writeFile(profilePath, JSON.stringify(profile));

  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1" == "restore" ]]; then
  exit 93
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);

  let failure;
  try {
    await command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', profilePath, '--gh-command', 'false',
      '120', 'tracked-symlink', 'feat',
    ], repo, {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.doesNotMatch(`${failure.stdout}${failure.stderr}${failure.message}`, /SECRET_SETUP_CANARY/);

  let receiptText = await readFile(begun.receipt, 'utf8');
  assert.doesNotMatch(receiptText, /SECRET_SETUP_CANARY|"failure":/);
  let receipt = JSON.parse(receiptText);
  const target = receipt.targets[0];
  assert.equal(target.evidenceState, 'complete');
  assert.deepEqual(target.setupTrackedEvidence.paths, ['seed.txt']);
  assert.equal(target.setupCreatedFiles[0].kind, 'symlink');
  await writeFile(join(target.worktree, 'seed.txt'), 'later change\n');
  await assert.rejects(
    session(repo, 'recover', '--branch', target.branch, '--gh-command', 'false'),
    /tracked setup changes changed/,
  );

  await writeFile(join(target.worktree, 'seed.txt'), 'setup\n');
  const recovered = await session(
    repo, 'recover', '--branch', target.branch, '--gh-command', 'false',
  );
  assert.equal(recovered.recovered, true);
  await assert.rejects(git(repo, 'show-ref', '--verify', `refs/heads/${target.branch}`));
  receiptText = await readFile(begun.receipt, 'utf8');
  receipt = JSON.parse(receiptText);
  assert.deepEqual(receipt.targets, []);
  assert.doesNotMatch(receiptText, /SECRET_SETUP_CANARY|"failure":/);
});

test('incomplete evidence capture remains retryable after the worktree is made exact-clean', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const profilePath = join(repo, 'docs/agents/workflow-capabilities.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.worktreeLifecycle.setupSteps = [{
    kind: 'command',
    command: [
      'node', '-e',
      "require('fs').writeFileSync('setup-owned.txt','owned\\n');"
        + "process.stderr.write('SECRET_CAPTURE_CANARY\\n');process.exit(23)",
    ],
  }];
  await writeFile(profilePath, JSON.stringify(profile));
  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1" == "diff" ]]; then
  printf '%s\\n' 'SECRET_DIFF_CANARY' >&2
  exit 94
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);

  let failure;
  try {
    await command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', profilePath, '--gh-command', 'false',
      '122', 'pending-evidence', 'feat',
    ], repo, {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.doesNotMatch(
    `${failure.stdout}${failure.stderr}${failure.message}`,
    /SECRET_(?:CAPTURE|DIFF)_CANARY/,
  );
  let receiptText = await readFile(begun.receipt, 'utf8');
  assert.doesNotMatch(receiptText, /SECRET_(?:CAPTURE|DIFF)_CANARY|"failure":/);
  let receipt = JSON.parse(receiptText);
  const target = receipt.targets[0];
  assert.equal(target.state, 'recovery-pending');
  assert.equal(target.evidenceState, 'pending');
  assert.equal(target.evidenceFailureClass, 'identity-capture');

  await rm(join(target.worktree, 'setup-owned.txt'));
  await session(repo, 'recover', '--branch', target.branch, '--gh-command', 'false');
  receiptText = await readFile(begun.receipt, 'utf8');
  receipt = JSON.parse(receiptText);
  assert.deepEqual(receipt.targets, []);
  assert.equal(receipt.recoveredTargets.at(-1).evidenceState, 'complete');
  assert.equal('evidenceFailureClass' in receipt.recoveredTargets.at(-1), false);
});

test('failed setup preserves recovery ownership when exact rollback is interrupted', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const profilePath = join(repo, 'docs/agents/workflow-capabilities.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.worktreeLifecycle.setupSteps = [{
    kind: 'command',
    command: [
      'node', '-e',
      "require('fs').writeFileSync('setup-owned.txt','owned\\n');process.exit(23)",
    ],
  }];
  await writeFile(profilePath, JSON.stringify(profile));

  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  const marker = join(root, 'remove.failed');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "worktree remove" && ! -e "$ROLLBACK_MARKER" ]]; then
  : > "$ROLLBACK_MARKER"
  exit 91
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);

  await assert.rejects(
    command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', profilePath, '118', 'recovery', 'feat',
    ], repo, {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        ROLLBACK_MARKER: marker,
      },
    }),
    /failed/,
  );

  let receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(receipt.targets.length, 1);
  assert.equal(receipt.targets[0].state, 'recovery-pending');
  assert.equal(receipt.targets[0].branch, 'feat/118-recovery');
  assert.match(receipt.targets[0].artifactBaselineDigest, /^[0-9a-f]{64}$/);

  const worktree = receipt.targets[0].worktree;
  await writeFile(join(worktree, 'foreign-after-failure.txt'), 'foreign\n');
  await assert.rejects(
    session(
      repo,
      'recover',
      '--branch', 'feat/118-recovery',
      '--gh-command', 'false',
    ),
    /foreign untracked files/,
  );
  receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(receipt.targets[0].state, 'recovery-pending');
  await rm(join(worktree, 'foreign-after-failure.txt'));

  await writeFile(join(worktree, 'setup-owned.txt'), 'foreign replacement\n');
  await assert.rejects(
    session(
      repo,
      'recover',
      '--branch', 'feat/118-recovery',
      '--gh-command', 'false',
    ),
    /identity changed/,
  );
  receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(receipt.targets[0].state, 'recovery-pending');
  await rm(join(worktree, 'setup-owned.txt'));

  const recovered = await session(
    repo,
    'recover',
    '--branch', 'feat/118-recovery',
    '--gh-command', 'false',
  );
  assert.equal(recovered.recovered, true);
  await assert.rejects(git(repo, 'show-ref', '--verify', 'refs/heads/feat/118-recovery'));
  assert.doesNotMatch((await git(repo, 'worktree', 'list')).stdout, /feat-118-recovery/);
  receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.deepEqual(receipt.targets, []);
  assert.equal(receipt.recoveredTargets.at(-1).branch, 'feat/118-recovery');
});

test('recovery refuses a concurrently moved ref and preserves its pending receipt', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const profilePath = join(repo, 'docs/agents/workflow-capabilities.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.worktreeLifecycle.setupSteps = [{
    kind: 'command',
    command: [
      'node', '-e',
      "require('fs').writeFileSync('setup-owned.txt','owned\\n');process.exit(23)",
    ],
  }];
  await writeFile(profilePath, JSON.stringify(profile));

  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  const marker = join(root, 'remove.failed');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "worktree remove" && ! -e "$ROLLBACK_MARKER" ]]; then
  : > "$ROLLBACK_MARKER"
  exit 91
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);
  await assert.rejects(
    command('python3', [
      SESSION, 'create', '--anchor', '42', '--owner', 'run-alpha',
      '--profile', profilePath, '119', 'moved-recovery', 'feat',
    ], repo, {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        ROLLBACK_MARKER: marker,
      },
    }),
  );

  await writeFile(join(repo, 'later.txt'), 'later\n');
  await git(repo, 'add', 'later.txt');
  await git(repo, 'commit', '-m', 'later main');
  const movedOid = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim();
  await git(
    repo,
    'update-ref',
    'refs/heads/feat/119-moved-recovery',
    movedOid,
  );

  await assert.rejects(
    session(
      repo,
      'recover',
      '--branch', 'feat/119-moved-recovery',
      '--gh-command', 'false',
    ),
    /unexpected OID/,
  );
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(receipt.targets[0].state, 'recovery-pending');
  assert.equal(
    (await git(repo, 'rev-parse', 'refs/heads/feat/119-moved-recovery')).stdout.trim(),
    movedOid,
  );
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

test('a substituted receipt proof ref is rejected before inspection or mutation', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const created = await session(
    repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json',
    '130', 'proof-substitution', 'feat',
  );
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  receipt.targets[0].proofRef = 'refs/heads/main';
  await writeFile(begun.receipt, JSON.stringify(receipt));
  await assert.rejects(
    session(repo, 'inspect', '--main', 'main', '--gh-command', 'false'),
    /proof identity is incoherent/,
  );
  assert.match(
    (await git(repo, 'show-ref', '--verify', `refs/heads/${created.branch}`)).stdout,
    /proof-substitution/,
  );
});

test('a committed ref deletion is resumable before the removed flag is journaled', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const created = await session(
    repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json',
    '131', 'commit-resume', 'feat',
  );
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);
  await session(repo, 'teardown', '--main', 'main', '--gh-command', 'false');
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  receipt.state = 'tearing-down';
  receipt.targets[0].removed = false;
  receipt.targets[0].teardownPhase = 'ref-deletion-pending';
  await writeFile(begun.receipt, JSON.stringify(receipt));

  const resumed = await session(repo, 'teardown', '--main', 'main', '--gh-command', 'false');
  assert.equal(resumed.state, 'complete');
  assert.equal(resumed.targets[0].removed, true);
});

test('a broken symlink at a resumable removed target is a nofollow hard stop', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const created = await session(
    repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json',
    '132', 'broken-resume', 'feat',
  );
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);
  await session(repo, 'teardown', '--main', 'main', '--gh-command', 'false');
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  receipt.state = 'tearing-down';
  receipt.targets[0].removed = false;
  receipt.targets[0].teardownPhase = 'ref-deletion-pending';
  await writeFile(begun.receipt, JSON.stringify(receipt));
  await mkdir(join(repo, '.worktrees'), { recursive: true });
  await command('ln', ['-s', 'missing-foreign-target', created.worktree], repo);

  const preview = await session(repo, 'inspect', '--main', 'main', '--gh-command', 'false');
  assert.equal(preview.removable, false);
  assert.match(preview.targets[0].reasons.join('\n'), /root type changed/);
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

test('prepared ref locks prevent branch reattachment or movement during worktree removal', async (t) => {
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
  const marker = join(root, 'move.result');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "worktree remove" && ! -e "$RACE_MARKER" ]]; then
  if "${realGit}" update-ref refs/heads/feat/113-race "$RACE_OID"; then
    printf moved > "$RACE_MARKER"
  else
    printf locked > "$RACE_MARKER"
  fi
fi
exec "${realGit}" "$@"
`);
  await chmod(join(fakeBin, 'git'), 0o755);

  await command('python3', [
    SESSION, 'teardown', '--anchor', '42', '--owner', 'run-alpha',
    '--main', 'main', '--gh-command', 'false',
  ], repo, {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      RACE_MARKER: marker,
      RACE_OID: movedOid,
    },
  });
  assert.equal(await readFile(marker, 'utf8'), 'locked');
  await assert.rejects(git(repo, 'show-ref', '--verify', 'refs/heads/feat/113-race'));
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(receipt.state, 'complete');
  assert.equal(receipt.targets[0].recoveryOid, ownedOid);
});

test('prepared deletion atomically verifies canonical main before removal', async (t) => {
  const { root, repo } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await plantClaim(repo);
  const begun = await session(repo, 'begin', '--base', 'main');
  const created = await session(
    repo, 'create', '--profile', 'docs/agents/workflow-capabilities.json',
    '134', 'main-race', 'feat',
  );
  await writeFile(join(created.worktree, 'owned.txt'), 'owned\n');
  await git(created.worktree, 'add', 'owned.txt');
  await git(created.worktree, 'commit', '-m', 'owned change');
  const ownedOid = (await git(created.worktree, 'rev-parse', 'HEAD')).stdout.trim();
  await session(repo, 'seal');
  await git(repo, 'cherry-pick', ownedOid);
  const realGit = (await command('sh', ['-c', 'command -v git'], repo)).stdout.trim();
  const fakeBin = join(root, 'fake-bin');
  const marker = join(root, 'main.moved');
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, 'git'), `#!/usr/bin/env bash
if [[ "$1 $2" == "update-ref --stdin" && ! -e "$MAIN_RACE_MARKER" ]]; then
  : > "$MAIN_RACE_MARKER"
  printf late > late-main.txt
  "${realGit}" add late-main.txt
  "${realGit}" commit -m 'late main move' >/dev/null
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
        MAIN_RACE_MARKER: marker,
      },
    }),
    /locked worktree\/ref cleanup stopped/,
  );
  assert.match(
    (await git(repo, 'show-ref', '--verify', `refs/heads/${created.branch}`)).stdout,
    /main-race/,
  );
  const receipt = JSON.parse(await readFile(begun.receipt, 'utf8'));
  assert.equal(
    (await git(repo, 'rev-parse', receipt.targets[0].proofRef)).stdout.trim(),
    receipt.targets[0].createdOid,
  );
  assert.match((await git(repo, 'worktree', 'list')).stdout, /feat-134-main-race/);
});
