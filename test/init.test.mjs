import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { init } from '../src/commands/init.mjs';
import { readManifest, CONSUMER_MANIFEST_NAME } from '../src/lib/manifest.mjs';
import { firstLineState } from '../src/lib/sentinel.mjs';
import { makeKit, makeEmptyDir, cleanup } from './helpers.mjs';

const exists = (p) => access(p).then(() => true, () => false);

test('init copies kit files, writes the consumer manifest, seeds doc stubs', async () => {
  const kit = await makeKit({ '.claude/skills/to-prd/SKILL.md': '# to-prd\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });

    assert.equal(await readFile(join(consumer, '.claude/skills/to-prd/SKILL.md'), 'utf8'), '# to-prd\n');

    const mf = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    const entry = mf.installed.find((e) => e.path === '.claude/skills/to-prd/SKILL.md');
    assert.ok(entry.installedSha256, 'records a hash');
    assert.equal(entry.origin, 'kit');

    // a stub target was seeded with the sentinel; board-sync.md was NOT created
    assert.equal(
      firstLineState(await readFile(join(consumer, 'docs/agents/issue-tracker.md'), 'utf8')),
      'stub'
    );
    assert.equal(await exists(join(consumer, 'docs/agents/board-sync.md')), false);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('init never clobbers a pre-existing untracked file (unless force)', async () => {
  const kit = await makeKit({ '.claude/skills/to-prd/SKILL.md': '# from kit\n' });
  const consumer = await makeEmptyDir();
  try {
    const dest = join(consumer, '.claude/skills/to-prd/SKILL.md');
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, '# user already had this\n');

    const r1 = await init({ kitRoot: kit, consumerRoot: consumer });
    assert.equal(await readFile(dest, 'utf8'), '# user already had this\n', 'preserved');
    assert.ok(r1.skipped.includes('.claude/skills/to-prd/SKILL.md'));

    await init({ kitRoot: kit, consumerRoot: consumer, force: true });
    assert.equal(await readFile(dest, 'utf8'), '# from kit\n', 'force overwrites');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('init is idempotent: re-run leaves filled stubs untouched', async () => {
  const kit = await makeKit({ '.claude/skills/to-prd/SKILL.md': '# to-prd\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const stub = join(consumer, 'docs/agents/domain.md');
    await writeFile(stub, '<!-- setup-workflow: state=filled -->\nfilled content\n');
    await init({ kitRoot: kit, consumerRoot: consumer });
    assert.equal(firstLineState(await readFile(stub, 'utf8')), 'filled', 'not re-seeded');
  } finally {
    await cleanup(kit, consumer);
  }
});
