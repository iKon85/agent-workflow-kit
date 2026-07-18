import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { init } from '../src/commands/init.mjs';
import {
  readManifest, writeManifest, CONSUMER_MANIFEST_NAME, PACKAGE_MANIFEST_NAME,
} from '../src/lib/manifest.mjs';
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

test('init installs only consumer-role files and records that role', async () => {
  const consumerPath = '.claude/skills/to-prd/SKILL.md';
  const maintainerPath = 'scripts/kit-release.mjs';
  const kit = await makeKit({
    [consumerPath]: '# to-prd\n',
    [maintainerPath]: 'import "./build-kit.mjs";\n',
  });
  const consumer = await makeEmptyDir();
  try {
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files.find(({ path }) => path === consumerPath).installRole = 'consumer';
    pkg.files.find(({ path }) => path === maintainerPath).installRole = 'maintainer';
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);

    await init({ kitRoot: kit, consumerRoot: consumer });

    assert.equal(await exists(join(consumer, maintainerPath)), false);
    const manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(manifest.installRole, 'consumer');
    assert.deepEqual(manifest.installed.map(({ path }) => path), [consumerPath]);
    assert.equal(manifest.installed[0].installRole, 'consumer');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('re-running init retains and classifies an edited legacy maintainer file', async () => {
  const maintainerPath = 'scripts/kit-release.mjs';
  const kit = await makeKit({
    '.claude/skills/to-prd/SKILL.md': '# to-prd\n',
    [maintainerPath]: 'release helper\n',
  });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, maintainerPath), 'consumer customization\n');
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files.find(({ path }) => path === maintainerPath).installRole = 'maintainer';
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);

    await init({ kitRoot: kit, consumerRoot: consumer });

    assert.equal(await readFile(join(consumer, maintainerPath), 'utf8'), 'consumer customization\n');
    const manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(
      manifest.installed.find(({ path }) => path === maintainerPath).installRole,
      'maintainer',
    );
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

test('re-running init preserves consumer-owned files and manifest entries, including with force', async () => {
  const path = '.claude/skills/to-prd/SKILL.md';
  const kit = await makeKit({ [path]: '# from kit\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const manifestPath = join(consumer, CONSUMER_MANIFEST_NAME);
    const manifest = await readManifest(manifestPath);
    const ownedEntry = manifest.installed.find((entry) => entry.path === path);
    ownedEntry.origin = 'consumer';
    await writeManifest(manifestPath, manifest);
    await writeFile(join(consumer, path), '# consumer-owned bytes\n');

    for (const force of [false, true]) {
      await init({ kitRoot: kit, consumerRoot: consumer, force });

      assert.equal(
        await readFile(join(consumer, path), 'utf8'),
        '# consumer-owned bytes\n',
        `consumer-owned bytes survive init${force ? ' --force' : ''}`,
      );
      const after = await readManifest(manifestPath);
      assert.deepEqual(
        after.installed.find((entry) => entry.path === path),
        ownedEntry,
        `consumer-owned manifest entry survives init${force ? ' --force' : ''}`,
      );
    }
  } finally {
    await cleanup(kit, consumer);
  }
});
