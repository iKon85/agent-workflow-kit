import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { init } from '../src/commands/init.mjs';
import { setOwnership } from '../src/commands/own.mjs';
import { reconcile } from '../src/lib/updateReconcile.mjs';
import {
  readManifest, writeManifest, CONSUMER_MANIFEST_NAME, PACKAGE_MANIFEST_NAME,
} from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { makeKit, makeEmptyDir, cleanup } from './helpers.mjs';

const P = '.claude/skills/to-prd/SKILL.md';
const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

async function makeCollisionFixture(path = 'docs/collision.md') {
  const kit = await makeKit({ [P]: 'kit v1\n', [path]: 'upstream bytes\n' });
  const consumer = await makeEmptyDir();
  await init({ kitRoot: kit, consumerRoot: consumer });
  const manifestPath = join(consumer, CONSUMER_MANIFEST_NAME);
  const manifest = await readManifest(manifestPath);
  manifest.installed = manifest.installed.filter((entry) => entry.path !== path);
  await writeManifest(manifestPath, manifest);
  await writeFile(join(consumer, path), 'existing consumer bytes\n');
  return { kit, consumer, manifestPath, path };
}

test('own and disown flip a tracked regular file origin', async () => {
  const kit = await makeKit({ [P]: 'kit bytes\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, P), 'consumer fork\n');

    await setOwnership({ consumerRoot: consumer, path: P, origin: 'consumer' });
    let manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(manifest.installed.find(({ path }) => path === P).origin, 'consumer');
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'consumer fork\n');

    await setOwnership({ consumerRoot: consumer, path: P, origin: 'kit' });
    manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(manifest.installed.find(({ path }) => path === P).origin, 'kit');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('reconcile skips consumer-owned paths in installable and deletion loops', async () => {
  const removed = '.claude/skills/removed/SKILL.md';
  const kit = await makeKit({ [P]: 'kit v1\n', [removed]: 'removed v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await setOwnership({ consumerRoot: consumer, path: P, origin: 'consumer' });
    await setOwnership({ consumerRoot: consumer, path: removed, origin: 'consumer' });
    await writeFile(join(consumer, P), 'consumer fork\n');
    await writeFile(join(kit, P), 'kit v2\n');
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files.find(({ path }) => path === P).sha256 = sha256('kit v2\n');
    pkg.files = pkg.files.filter(({ path }) => path !== removed);
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);
    let decisions = 0;

    const result = await reconcile({
      kitRoot: kit,
      consumerRoot: consumer,
      decide: () => { decisions += 1; return true; },
    });

    assert.deepEqual(result.consumerOwned, [P, removed]);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.keptDeleted, []);
    assert.equal(decisions, 0);
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'consumer fork\n');
    assert.equal(await readFile(join(consumer, removed), 'utf8'), 'removed v1\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a collision is previewed and can be kept as consumer-owned without overwriting', async () => {
  const collision = '.agents/skills/new/SKILL.md';
  const kit = await makeKit({ [P]: 'kit v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await mkdir(dirname(join(kit, collision)), { recursive: true });
    await writeFile(join(kit, collision), 'upstream bytes\n');
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files.push({
      path: collision, kind: 'skill', sha256: sha256('upstream bytes\n'), mode: 0o644,
      origin: 'kit',
    });
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);
    await mkdir(dirname(join(consumer, collision)), { recursive: true });
    await writeFile(join(consumer, collision), 'existing consumer bytes\n');

    const preview = await reconcile({ kitRoot: kit, consumerRoot: consumer, dryRun: true });
    assert.deepEqual(preview.collisions, [collision]);
    assert.deepEqual(preview.collisionResolutions, []);
    assert.equal(await readFile(join(consumer, collision), 'utf8'), 'existing consumer bytes\n');

    const applied = await reconcile({
      kitRoot: kit,
      consumerRoot: consumer,
      decide: (action, path) => {
        assert.deepEqual([action, path], ['collision', collision]);
        return 'keep-as-owned';
      },
    });
    const manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    const tracked = manifest.installed.find(({ path }) => path === collision);
    assert.equal(tracked.origin, 'consumer');
    assert.equal(tracked.installedSha256, sha256('existing consumer bytes\n'));
    assert.deepEqual(applied.collisions, []);
    assert.deepEqual(applied.collisionResolutions, [{
      path: collision,
      outcome: 'keep-as-owned',
      destinationSha256: sha256('existing consumer bytes\n'),
    }]);
    assert.deepEqual(applied.consumerOwned, [collision]);
    assert.equal(await readFile(join(consumer, collision), 'utf8'), 'existing consumer bytes\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('dry-run replays both collision outcomes with hash metadata and writes nothing', async () => {
  const keep = await makeCollisionFixture();
  const replace = await makeCollisionFixture();
  const keepManifestBefore = await readFile(keep.manifestPath);
  const replaceManifestBefore = await readFile(replace.manifestPath);
  try {
    const kept = await reconcile({
      kitRoot: keep.kit,
      consumerRoot: keep.consumer,
      dryRun: true,
      decide: () => 'keep-as-owned',
    });
    assert.deepEqual(kept.collisions, []);
    assert.deepEqual(kept.consumerOwned, [keep.path]);
    assert.deepEqual(kept.added, []);
    assert.equal(kept.manifestChanged, true);
    assert.deepEqual(kept.collisionResolutions, [{
      path: keep.path,
      outcome: 'keep-as-owned',
      destinationSha256: sha256('existing consumer bytes\n'),
    }]);

    const replaced = await reconcile({
      kitRoot: replace.kit,
      consumerRoot: replace.consumer,
      dryRun: true,
      decide: () => 'replace',
    });
    assert.deepEqual(replaced.collisions, []);
    assert.deepEqual(replaced.consumerOwned, []);
    assert.deepEqual(replaced.added, [replace.path]);
    assert.equal(replaced.manifestChanged, true);
    assert.deepEqual(replaced.collisionResolutions, [{
      path: replace.path,
      outcome: 'replace',
      destinationSha256: sha256('existing consumer bytes\n'),
    }]);

    assert.deepEqual(await readFile(keep.manifestPath), keepManifestBefore);
    assert.deepEqual(await readFile(replace.manifestPath), replaceManifestBefore);
    assert.equal(await readFile(join(keep.consumer, keep.path), 'utf8'), 'existing consumer bytes\n');
    assert.equal(await readFile(join(replace.consumer, replace.path), 'utf8'), 'existing consumer bytes\n');
  } finally {
    await cleanup(keep.kit, keep.consumer, replace.kit, replace.consumer);
  }
});

test('own fails loudly without mutating for unknown, repeated, or unsafe paths', async () => {
  const kit = await makeKit({ [P]: 'kit bytes\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await assert.rejects(
      setOwnership({ consumerRoot: consumer, path: 'unknown.md', origin: 'consumer' }),
      /unknown tracked path/,
    );
    await assert.rejects(
      setOwnership({ consumerRoot: consumer, path: P, origin: 'kit' }),
      /already kit-owned/,
    );

    const manifestPath = join(consumer, CONSUMER_MANIFEST_NAME);
    const manifest = await readManifest(manifestPath);
    const template = manifest.installed[0];
    manifest.installed.push(
      { ...template, path: '/absolute.md' },
      { ...template, path: '../outside.md' },
      { ...template, path: 'nested/../not-normalized.md' },
      { ...template, path: 'linked.md' },
    );
    await symlink(join(consumer, P), join(consumer, 'linked.md'));
    await writeManifest(manifestPath, manifest);
    const before = await readFile(manifestPath);

    for (const path of ['/absolute.md', '../outside.md', 'nested/../not-normalized.md', 'linked.md']) {
      await assert.rejects(
        setOwnership({ consumerRoot: consumer, path, origin: 'consumer' }),
        /unsafe consumer path/,
      );
    }
    assert.deepEqual(await readFile(manifestPath), before);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('collision containment rejects a symlink before hashing or adoption', async () => {
  const collision = 'docs/collision.md';
  const kit = await makeKit({ [P]: 'kit v1\n', [collision]: 'upstream bytes\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const manifestPath = join(consumer, CONSUMER_MANIFEST_NAME);
    const manifest = await readManifest(manifestPath);
    manifest.installed = manifest.installed.filter(({ path }) => path !== collision);
    await writeManifest(manifestPath, manifest);
    await rm(join(consumer, collision));
    await symlink(join(consumer, P), join(consumer, collision));

    await assert.rejects(
      reconcile({ kitRoot: kit, consumerRoot: consumer, dryRun: true }),
      /unsafe consumer path/,
    );
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a collision can explicitly replace existing bytes and rejects every other decision', async () => {
  const collision = 'docs/new.md';
  const replace = await makeCollisionFixture(collision);
  const invalid = await makeCollisionFixture(collision);
  try {
    const applied = await reconcile({
      kitRoot: replace.kit, consumerRoot: replace.consumer, decide: () => 'replace',
    });
    assert.deepEqual(applied.collisions, []);
    assert.deepEqual(applied.collisionResolutions, [{
      path: collision,
      outcome: 'replace',
      destinationSha256: sha256('existing consumer bytes\n'),
    }]);
    assert.deepEqual(applied.added, [collision]);
    assert.equal(await readFile(join(replace.consumer, collision), 'utf8'), 'upstream bytes\n');
    const manifest = await readManifest(join(replace.consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(manifest.installed.find(({ path }) => path === collision).origin, 'kit');

    await assert.rejects(
      reconcile({ kitRoot: invalid.kit, consumerRoot: invalid.consumer, decide: () => true }),
      /must select a valid explicit ownership route/,
    );
    assert.equal(await readFile(join(invalid.consumer, collision), 'utf8'), 'existing consumer bytes\n');
  } finally {
    await cleanup(replace.kit, replace.consumer, invalid.kit, invalid.consumer);
  }
});

test('CLI dispatches forks through ownership and bridges through provenance', async () => {
  const kit = await makeKit({ [P]: 'kit bytes\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await run(process.execPath, [CLI, 'own', P], { cwd: consumer });
    let manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    let tracked = manifest.installed.find(({ path }) => path === P);
    assert.equal(tracked.origin, 'consumer');
    assert.equal(tracked.ownershipState, 'explicit-fork');

    await run(process.execPath, [CLI, 'disown', P], { cwd: consumer });
    manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    tracked = manifest.installed.find(({ path }) => path === P);
    assert.equal(tracked.origin, 'kit');
    assert.equal(tracked.ownershipState, undefined);

    const source = await readFile(CLI, 'utf8');
    assert.match(source, /beginContributionBridge\(\{ kitRoot: KIT_ROOT, consumerRoot, path/);
    assert.match(source, /prepareContributionArtifact\(/);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('CLI keeps downstream collision and owned-diff seams wired', async () => {
  const source = await readFile(CLI, 'utf8');
  assert.match(source, /diff\(\{ kitRoot: KIT_ROOT, consumerRoot, owned \}\)/);
  assert.match(source, /decideUpdate\(action, path, yes, classification\)/);
  assert.match(source, /nonInteractiveUpdateDecision\(action\)/);
  assert.match(source, /'consumerOwned'[\s\S]*'collisions'/);
  assert.match(source, /'bridgeRetired'/);
});
