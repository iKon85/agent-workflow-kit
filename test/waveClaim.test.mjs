import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { claimWave, readWaveClaim, releaseWaveClaim } from '../src/lib/waveClaim.mjs';

const run = promisify(execFile);

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'awkit-wave-claim-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await run('git', ['init', '--initial-branch=main'], { cwd: repo });
  await run('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  await run('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  await writeFile(join(repo, 'README.md'), '# fixture\n');
  await run('git', ['add', 'README.md'], { cwd: repo });
  await run('git', ['commit', '-m', 'initial'], { cwd: repo });
  return { root, repo };
}

test('competing sessions atomically claim one wave and expose the winner', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));

  const attempts = await Promise.all([
    claimWave({ repoRoot: repo, anchor: '167', owner: 'session-alpha', sliceBranches: ['feat/168'] }),
    claimWave({ repoRoot: repo, anchor: '167', owner: 'session-beta', sliceBranches: ['feat/169'] }),
  ]);

  assert.equal(attempts.filter(({ acquired }) => acquired).length, 1);
  const winner = attempts.find(({ acquired }) => acquired).claim;
  const loser = attempts.find(({ acquired }) => !acquired).claim;
  assert.equal(loser.owner, winner.owner);
  assert.deepEqual(await readWaveClaim({ repoRoot: repo, anchor: '167' }), winner);
});

test('only the recorded owner can remove a wave claim', async (t) => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));

  const { claim } = await claimWave({ repoRoot: repo, anchor: '167', owner: 'session-alpha' });
  assert.equal(await releaseWaveClaim({ repoRoot: repo, anchor: '167', owner: 'session-beta' }), false);
  assert.deepEqual(await readWaveClaim({ repoRoot: repo, anchor: '167' }), claim);
  assert.equal(await releaseWaveClaim({ repoRoot: repo, anchor: '167', owner: 'session-alpha' }), true);
  assert.equal(await readWaveClaim({ repoRoot: repo, anchor: '167' }), null);
});
