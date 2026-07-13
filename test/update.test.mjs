import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { init } from '../src/commands/init.mjs';
import { update } from '../src/commands/update.mjs';
import { makeKit, makeEmptyDir, cleanup } from './helpers.mjs';
import { PACKAGE_MANIFEST_NAME, readManifest, writeManifest } from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';

const exists = (p) => access(p).then(() => true, () => false);
const P = '.claude/skills/to-prd/SKILL.md';
const H = '.claude/hooks/my-hook.py';

// re-write a kit file + its package-manifest hash to simulate an upstream change
async function bumpKit(kitRoot, path, content) {
  await writeFile(join(kitRoot, path), content);
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  pkg.files.find((f) => f.path === path).sha256 = sha256(content);
  await writeManifest(join(kitRoot, PACKAGE_MANIFEST_NAME), pkg);
}

test('update overwrites an unmodified file when upstream changed', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'v2\n');
    const r = await update({ kitRoot: kit, consumerRoot: consumer, now: 'T' });
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v2\n');
    assert.ok(r.updated.includes(P));
  } finally {
    await cleanup(kit, consumer);
  }
});

test('update does NOT clobber a user-edited file; backs it up and reports conflict', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, P), 'user edit\n');       // user modifies
    await bumpKit(kit, P, 'v2\n');                           // upstream also changes
    const r = await update({ kitRoot: kit, consumerRoot: consumer, now: 'T' });
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'user edit\n', 'kept user version');
    assert.ok(r.conflicts.find((c) => c.path === P), 'reported conflict');
    assert.equal(await exists(join(consumer, P + '.T.bak')), true, 'backup written');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('update offers to delete an upstream-removed, unmodified file (decide gates it)', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    // drop the file from the kit package manifest (upstream removed it)
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files = pkg.files.filter((f) => f.path !== P);
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);

    const noDelete = await update({ kitRoot: kit, consumerRoot: consumer, now: 'T', decide: () => false });
    assert.equal(await exists(join(consumer, P)), true, 'kept when decide=false');

    const r = await update({ kitRoot: kit, consumerRoot: consumer, now: 'T', decide: () => true });
    assert.equal(await exists(join(consumer, P)), false, 'removed when decide=true');
    assert.ok(r.deleted.includes(P));
  } finally {
    await cleanup(kit, consumer);
  }
});

test('update never deletes an upstream-removed hook still referenced by settings.json, even when decide=true', async () => {
  const kit = await makeKit({ [P]: 'v1\n', [H]: 'hook code\n' });
  const consumer = await makeEmptyDir();
  try {
    // makeKit defaults non-skill paths to kind 'doc' — mark H as a hook so the
    // hookReferenced safety net in update() actually engages.
    const pkg0 = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg0.files.find((f) => f.path === H).kind = 'hook';
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg0);

    await init({ kitRoot: kit, consumerRoot: consumer });
    // consumer wires the hook into settings.json (init already created .claude/)
    await writeFile(join(consumer, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: H }] }] } }));

    // upstream removes the hook from the package
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files = pkg.files.filter((f) => f.path !== H);
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);

    const r = await update({ kitRoot: kit, consumerRoot: consumer, now: 'T', decide: () => true });
    assert.equal(await exists(join(consumer, H)), true, 'hook survives because settings.json still references it');
    assert.ok(r.keptDeleted.includes(H));
    assert.equal(r.deleted.includes(H), false);
  } finally {
    await cleanup(kit, consumer);
  }
});
