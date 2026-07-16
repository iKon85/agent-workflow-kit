import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planMemoryLifecycle } from './index.mjs';

test('dry-run classifies each candidate once without writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-lifecycle-'));
  const activeRoot = join(root, 'active');
  const archiveRoot = join(root, 'archive');
  await mkdir(archiveRoot, { recursive: true });
  await writeFile(join(archiveRoot, 'returning.md'), 'archived memory\n');

  const plan = await planMemoryLifecycle({
    activeRoot,
    archiveRoot,
    candidates: ['new.md', 'returning.md'],
    approved: true,
  });

  assert.deepEqual(plan.actions.map(({ path, action }) => [path, action]), [
    ['new.md', 'create'],
    ['returning.md', 'restore'],
  ]);
  await assert.rejects(readFile(join(activeRoot, 'new.md'), 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(join(activeRoot, 'returning.md'), 'utf8'), { code: 'ENOENT' });
});
