import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { init } from '../src/commands/init.mjs';
import { update } from '../src/commands/update.mjs';
import { diff } from '../src/commands/diff.mjs';
import { uninstall } from '../src/commands/uninstall.mjs';
import { readManifest, CONSUMER_MANIFEST_NAME, writeManifest, PACKAGE_MANIFEST_NAME } from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { makeKit, makeEmptyDir, cleanup } from './helpers.mjs';

const exists = (p) => access(p).then(() => true, () => false);
const P = '.claude/skills/to-prd/SKILL.md';
const H = '.claude/hooks/my-hook.py';

test('diff classifies an upstream change without writing', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(kit, P), 'v2\n');
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files.find((f) => f.path === P).sha256 = sha256('v2\n');
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);

    const r = await diff({ kitRoot: kit, consumerRoot: consumer });
    assert.ok(r.updated.includes(P));
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v1\n', 'diff wrote nothing');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('diff reports a legacy maintainer file without changing consumer bytes', async () => {
  const maintainerPath = 'scripts/kit-release.mjs';
  const kit = await makeKit({ [P]: 'v1\n', [maintainerPath]: 'release helper\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files.find(({ path }) => path === maintainerPath).installRole = 'maintainer';
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);
    const manifestBefore = await readFile(join(consumer, CONSUMER_MANIFEST_NAME));

    const result = await diff({ kitRoot: kit, consumerRoot: consumer });

    assert.deepEqual(result.keptDeleted, [maintainerPath]);
    assert.equal(await readFile(join(consumer, maintainerPath), 'utf8'), 'release helper\n');
    assert.deepEqual(await readFile(join(consumer, CONSUMER_MANIFEST_NAME)), manifestBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('uninstall removes unedited files and drops the manifest', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const r = await uninstall({ consumerRoot: consumer });
    assert.ok(r.removed.includes(P));
    assert.equal(await exists(join(consumer, P)), false);
    assert.equal(await exists(join(consumer, CONSUMER_MANIFEST_NAME)), false, 'manifest gone');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('uninstall retains user-edited files and keeps a marked manifest', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, P), 'my edits\n');
    const r = await uninstall({ consumerRoot: consumer });
    assert.ok(r.retained.includes(P));
    assert.equal(await exists(join(consumer, P)), true, 'edited file kept');
    const mf = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(mf.installed.find((e) => e.path === P).orphanedByUninstall, true);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('uninstall retains and classifies an edited legacy maintainer file', async () => {
  const maintainerPath = 'scripts/kit-release.mjs';
  const kit = await makeKit({ [P]: 'v1\n', [maintainerPath]: 'release helper\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, maintainerPath), 'consumer customization\n');
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files.find(({ path }) => path === maintainerPath).installRole = 'maintainer';
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);
    await init({ kitRoot: kit, consumerRoot: consumer });

    const result = await uninstall({ consumerRoot: consumer });

    assert.ok(result.retained.includes(maintainerPath));
    assert.equal(await readFile(join(consumer, maintainerPath), 'utf8'), 'consumer customization\n');
    const manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(manifest.installRole, 'consumer');
    const entry = manifest.installed.find(({ path }) => path === maintainerPath);
    assert.equal(entry.installRole, 'maintainer');
    assert.equal(entry.orphanedByUninstall, true);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('uninstall retains a hook file still referenced by settings.json (safety net)', async () => {
  const kit = await makeKit({ [P]: 'v1\n', [H]: 'hook code\n' });
  const consumer = await makeEmptyDir();
  try {
    // makeKit defaults non-skill paths to kind 'doc' — mark H as a hook so the
    // hookReferenced safety net in uninstall() actually engages.
    const pkg0 = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg0.files.find((f) => f.path === H).kind = 'hook';
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg0);

    await init({ kitRoot: kit, consumerRoot: consumer });
    // consumer wires the hook into settings.json (init already created .claude/)
    await writeFile(join(consumer, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: H }] }] } }));

    const r = await uninstall({ consumerRoot: consumer });
    assert.ok(r.retained.includes(H), 'hook retained because settings.json references it');
    assert.equal(await exists(join(consumer, H)), true, 'hook file not removed');
    const mf = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(mf.installed.find((e) => e.path === H).orphanedByUninstall, true);
  } finally {
    await cleanup(kit, consumer);
  }
});
