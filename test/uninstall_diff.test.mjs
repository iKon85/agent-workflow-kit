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
const Q = '.claude/skills/to-issues/SKILL.md';

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

test('diff and uninstall reject an invalid ledger before touching tracked bytes or manifest', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const manifestPath = join(consumer, CONSUMER_MANIFEST_NAME);
    const manifest = await readManifest(manifestPath);
    manifest.installed[0].installedSha256 = 'not-a-sha';
    await writeManifest(manifestPath, manifest);
    const manifestBefore = await readFile(manifestPath);
    const fileBefore = await readFile(join(consumer, P));

    await assert.rejects(
      diff({ kitRoot: kit, consumerRoot: consumer }),
      /invalid consumer manifest.*installedSha256.*restore/i,
    );
    await assert.rejects(
      uninstall({ consumerRoot: consumer }),
      /invalid consumer manifest.*installedSha256.*restore/i,
    );
    assert.deepEqual(await readFile(manifestPath), manifestBefore);
    assert.deepEqual(await readFile(join(consumer, P)), fileBefore);
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
    assert.equal(mf.readinessContractVersion, 1);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('retained-file uninstall preserves unknown manifest extensions and decisions', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const path = join(consumer, CONSUMER_MANIFEST_NAME);
    const manifest = await readManifest(path);
    await writeManifest(path, {
      ...manifest,
      readinessDecisions: { prodTarget: 'pending' },
      consumerExtension: 'keep-me',
    });
    await writeFile(join(consumer, P), 'edited\n');

    await uninstall({ consumerRoot: consumer });
    const after = await readManifest(path);
    assert.equal(after.consumerExtension, 'keep-me');
    assert.deepEqual(after.readinessDecisions, { prodTarget: 'pending' });
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

test('uninstall preserves a consumer-owned file but removes its ownership entry and an otherwise-empty manifest', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const manifestPath = join(consumer, CONSUMER_MANIFEST_NAME);
    const manifest = await readManifest(manifestPath);
    manifest.installed.find((entry) => entry.path === P).origin = 'consumer';
    await writeManifest(manifestPath, manifest);

    const result = await uninstall({ consumerRoot: consumer });

    assert.ok(result.retained.includes(P));
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v1\n');
    assert.equal(await exists(manifestPath), false, 'ownership tracking ended with no retained entries');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('uninstall detaches consumer-owned entries while keeping the manifest for an edited survivor', async () => {
  const kit = await makeKit({ [P]: 'owned\n', [Q]: 'kit\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const manifestPath = join(consumer, CONSUMER_MANIFEST_NAME);
    const manifest = await readManifest(manifestPath);
    manifest.installed.find((entry) => entry.path === P).origin = 'consumer';
    await writeManifest(manifestPath, manifest);
    await writeFile(join(consumer, Q), 'consumer edit\n');

    const result = await uninstall({ consumerRoot: consumer });

    assert.ok(result.retained.includes(P));
    assert.ok(result.retained.includes(Q));
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'owned\n');
    assert.equal(await readFile(join(consumer, Q), 'utf8'), 'consumer edit\n');
    const after = await readManifest(manifestPath);
    assert.deepEqual(after.installed.map((entry) => entry.path), [Q]);
    assert.equal(after.installed[0].orphanedByUninstall, true);
  } finally {
    await cleanup(kit, consumer);
  }
});
