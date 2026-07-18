import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { diff } from '../src/commands/diff.mjs';
import { init } from '../src/commands/init.mjs';
import { setOwnership } from '../src/commands/own.mjs';
import {
  CONSUMER_MANIFEST_NAME, PACKAGE_MANIFEST_NAME, readManifest, writeManifest,
} from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { cleanup, makeEmptyDir, makeKit } from './helpers.mjs';

const OWNED = 'docs/owned.md';
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

async function ownedFixture(content = 'kit v1\n') {
  const kit = await makeKit({ [OWNED]: content });
  const consumer = await makeEmptyDir();
  await init({ kitRoot: kit, consumerRoot: consumer });
  await setOwnership({ consumerRoot: consumer, path: OWNED, origin: 'consumer' });
  return { kit, consumer };
}

async function setUpstream({ kit }, content) {
  await writeFile(join(kit, OWNED), content);
  const manifestPath = join(kit, PACKAGE_MANIFEST_NAME);
  const manifest = await readManifest(manifestPath);
  manifest.files.find(({ path }) => path === OWNED).sha256 = sha256(content);
  await writeManifest(manifestPath, manifest);
}

async function removeUpstream({ kit }) {
  const manifestPath = join(kit, PACKAGE_MANIFEST_NAME);
  const manifest = await readManifest(manifestPath);
  manifest.files = manifest.files.filter(({ path }) => path !== OWNED);
  await writeManifest(manifestPath, manifest);
}

test('diff --owned reports a text file changed upstream with its line diff', async () => {
  const fixture = await ownedFixture();
  try {
    await writeFile(join(fixture.consumer, OWNED), 'consumer fork\n');
    await setUpstream(fixture, 'kit v2\n');

    const result = await diff({ ...fixture, kitRoot: fixture.kit, consumerRoot: fixture.consumer, owned: true });

    assert.deepEqual(result.ownedDiffs, [{
      path: OWNED,
      state: 'changed-upstream',
      binary: false,
      diff: '-consumer fork\n+kit v2\n ',
    }]);
  } finally {
    await cleanup(fixture.kit, fixture.consumer);
  }
});

test('diff --owned reports when an owned path was removed upstream', async () => {
  const fixture = await ownedFixture();
  try {
    await removeUpstream(fixture);

    const result = await diff({ kitRoot: fixture.kit, consumerRoot: fixture.consumer, owned: true });

    assert.deepEqual(result.ownedDiffs, [{ path: OWNED, state: 'removed-upstream' }]);
  } finally {
    await cleanup(fixture.kit, fixture.consumer);
  }
});

test('diff --owned reports when an owned path is missing locally', async () => {
  const fixture = await ownedFixture();
  try {
    await rm(join(fixture.consumer, OWNED));

    const result = await diff({ kitRoot: fixture.kit, consumerRoot: fixture.consumer, owned: true });

    assert.deepEqual(result.ownedDiffs, [{ path: OWNED, state: 'missing-locally' }]);
  } finally {
    await cleanup(fixture.kit, fixture.consumer);
  }
});

test('diff --owned reports identical owned and upstream files without content', async () => {
  const fixture = await ownedFixture();
  try {
    const result = await diff({ kitRoot: fixture.kit, consumerRoot: fixture.consumer, owned: true });

    assert.deepEqual(result.ownedDiffs, [{ path: OWNED, state: 'identical' }]);
  } finally {
    await cleanup(fixture.kit, fixture.consumer);
  }
});

test('diff --owned revalidates containment after owning and never reads a swapped symlink', async () => {
  const fixture = await ownedFixture();
  const outside = await makeEmptyDir();
  const secret = 'EXTERNAL-SECRET-MUST-NOT-BE-READ';
  try {
    const target = join(outside, 'secret.txt');
    await writeFile(target, secret);
    await rm(join(fixture.consumer, OWNED));
    await symlink(target, join(fixture.consumer, OWNED));

    const result = await diff({ kitRoot: fixture.kit, consumerRoot: fixture.consumer, owned: true });

    assert.deepEqual(result.ownedDiffs, [{ path: OWNED, state: 'unsafe-path' }]);
    assert.doesNotMatch(JSON.stringify(result.ownedDiffs), new RegExp(secret));
  } finally {
    await cleanup(fixture.kit, fixture.consumer, outside);
  }
});

test('diff --owned reports binary size and hash without exposing content', async () => {
  const fixture = await ownedFixture();
  const local = Buffer.from('LOCAL\0PRIVATE');
  const upstream = Buffer.from('UPSTREAM\0PRIVATE');
  try {
    await writeFile(join(fixture.consumer, OWNED), local);
    await setUpstream(fixture, upstream);

    const result = await diff({ kitRoot: fixture.kit, consumerRoot: fixture.consumer, owned: true });

    assert.deepEqual(result.ownedDiffs, [{
      path: OWNED,
      state: 'changed-upstream',
      binary: true,
      local: { size: local.length, sha256: sha256(local) },
      upstream: { size: upstream.length, sha256: sha256(upstream) },
    }]);
    const rendered = JSON.stringify(result.ownedDiffs);
    assert.doesNotMatch(rendered, /LOCAL|UPSTREAM|PRIVATE|diff/);
  } finally {
    await cleanup(fixture.kit, fixture.consumer);
  }
});

test('CLI renders owned details only when --owned is requested', async () => {
  const consumer = await makeEmptyDir();
  try {
    const pkg = await readManifest(join(REPO, PACKAGE_MANIFEST_NAME));
    const packageEntry = pkg.files[0];
    await mkdir(dirname(join(consumer, packageEntry.path)), { recursive: true });
    await writeFile(join(consumer, packageEntry.path), 'consumer-only CLI marker\n');
    await writeManifest(join(consumer, CONSUMER_MANIFEST_NAME), {
      kitVersion: pkg.kitVersion,
      installRole: 'consumer',
      installed: [{
        ...packageEntry,
        installedSha256: sha256('original bytes are irrelevant for owned paths'),
        origin: 'consumer',
        installRole: 'consumer',
      }],
    });

    const normal = await run(process.execPath, [CLI, 'diff'], { cwd: consumer });
    const peek = await run(process.execPath, [CLI, 'diff', '--owned'], { cwd: consumer });

    assert.match(normal.stdout, /consumerOwned: 1/);
    assert.doesNotMatch(normal.stdout, /changed-upstream|consumer-only CLI marker/);
    assert.match(peek.stdout, new RegExp(`changed-upstream ${packageEntry.path.replaceAll('.', '\\.')}`));
    assert.match(peek.stdout, /-consumer-only CLI marker/);
  } finally {
    await cleanup(consumer);
  }
});
