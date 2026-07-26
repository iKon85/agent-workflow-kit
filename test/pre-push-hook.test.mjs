import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';

const HOOK = resolve('.githooks/pre-push');
const ZERO_SHA = '0'.repeat(40);
const LOCAL_SHA = '1'.repeat(40);
const REMOTE_SHA = '2'.repeat(40);

async function runHook(stdin) {
  const root = await mkdtemp(join(tmpdir(), 'awkit-pre-push-'));
  const npm = join(root, 'npm');
  const log = join(root, 'npm.log');
  await writeFile(npm, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FAKE_NPM_LOG"\n');
  await chmod(npm, 0o755);

  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(HOOK, ['origin', 'git@github.com:iKon85/agent-workflow-kit.git'], {
      env: {
        ...process.env,
        FAKE_NPM_LOG: log,
        PATH: `${root}${delimiter}${process.env.PATH ?? ''}`,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });

  let npmCalls = [];
  try {
    npmCalls = (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await rm(root, { recursive: true, force: true });
  return { ...result, npmCalls };
}

const row = (localRef, localSha, remoteRef, remoteSha) =>
  `${localRef} ${localSha} ${remoteRef} ${remoteSha}\n`;

test('deletion-only feature ref updates skip the full product suite', async () => {
  const result = await runHook(
    row('(delete)', ZERO_SHA, 'refs/heads/fix/266-project-extension-readiness', REMOTE_SHA)
    + row('(delete)', ZERO_SHA, 'refs/heads/fix/245-worktree-sweep', REMOTE_SHA),
  );

  assert.equal(result.code, 0);
  assert.deepEqual(result.npmCalls, []);
  assert.match(result.stdout, /deletion-only/i);
});

test('mixed delete and code updates fail closed to the full suite', async () => {
  const result = await runHook(
    row('(delete)', ZERO_SHA, 'refs/heads/merged-feature', REMOTE_SHA)
    + row('refs/heads/fix/270-prepush-delete-only', LOCAL_SHA, 'refs/heads/fix/270-prepush-delete-only', REMOTE_SHA),
  );

  assert.equal(result.code, 0);
  assert.deepEqual(result.npmCalls, ['test']);
});

test('malformed and empty evidence fail closed to the full suite', async () => {
  for (const stdin of ['not a valid ref update\n', '']) {
    const result = await runHook(stdin);
    assert.equal(result.code, 0);
    assert.deepEqual(result.npmCalls, ['test']);
  }
});

test('ordinary updates and creates fail closed to the full suite', async () => {
  const inputs = [
    row('refs/heads/fix/270-prepush-delete-only', LOCAL_SHA, 'refs/heads/fix/270-prepush-delete-only', REMOTE_SHA),
    row('refs/heads/new-feature', LOCAL_SHA, 'refs/heads/new-feature', ZERO_SHA),
  ];

  for (const stdin of inputs) {
    const result = await runHook(stdin);
    assert.equal(result.code, 0);
    assert.deepEqual(result.npmCalls, ['test']);
  }
});

test('deletion-only evidence still rejects protected branch and tag deletion', async () => {
  const inputs = [
    row('(delete)', ZERO_SHA, 'refs/heads/main', REMOTE_SHA),
    row('(delete)', ZERO_SHA, 'refs/tags/v0.37.0', REMOTE_SHA),
  ];

  for (const stdin of inputs) {
    const result = await runHook(stdin);
    assert.notEqual(result.code, 0);
    assert.deepEqual(result.npmCalls, []);
    assert.match(result.stderr, /protected/i);
  }
});

test('protected deletion in a mixed push rejects before the product suite', async () => {
  const inputs = [
    row('(delete)', ZERO_SHA, 'refs/heads/main', REMOTE_SHA)
      + row('refs/heads/fix/271-review', LOCAL_SHA, 'refs/heads/fix/271-review', REMOTE_SHA),
    row('(delete)', ZERO_SHA, 'refs/tags/v0.37.0', REMOTE_SHA)
      + row('refs/heads/new-feature', LOCAL_SHA, 'refs/heads/new-feature', ZERO_SHA),
  ];

  for (const stdin of inputs) {
    const result = await runHook(stdin);
    assert.notEqual(result.code, 0);
    assert.deepEqual(result.npmCalls, []);
    assert.match(result.stderr, /protected/i);
  }
});
