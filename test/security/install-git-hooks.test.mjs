import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { installGitHooks } from '../../scripts/security/install-git-hooks.mjs';

const run = promisify(execFile);

test('git hook wiring is idempotent in a consumer repository', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awkit-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await run('git', ['init', '--initial-branch=main'], { cwd: root });

  assert.deepEqual(await installGitHooks({ cwd: root }), {
    status: 'wired',
    hooksPath: '.githooks',
  });
  assert.deepEqual(await installGitHooks({ cwd: root }), {
    status: 'unchanged',
    hooksPath: '.githooks',
  });
  assert.equal((await run('git', ['config', '--get', 'core.hooksPath'], { cwd: root })).stdout.trim(), '.githooks');
});

test('real git configuration failures remain visible', async () => {
  const failure = Object.assign(new Error('config is read-only'), { code: 5 });
  await assert.rejects(
    installGitHooks({
      runGit: async (_cwd, args) => {
        if (args[0] === 'rev-parse') return 'true';
        if (args[0] === 'config' && args[1] === '--get') {
          throw Object.assign(new Error('unset'), { code: 1 });
        }
        throw failure;
      },
    }),
    failure,
  );
});
