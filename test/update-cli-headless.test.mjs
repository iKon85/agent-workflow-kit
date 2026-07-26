import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../src/commands/init.mjs';
import {
  CONSUMER_MANIFEST_NAME, PACKAGE_MANIFEST_NAME, readManifest, writeManifest,
} from '../src/lib/manifest.mjs';
import { nonInteractiveUpdateDecision } from '../src/lib/updateDecisions.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { cleanup, makeEmptyDir, makeKit } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const UPDATE = fileURLToPath(new URL('../src/commands/update.mjs', import.meta.url));
const P = '.claude/skills/to-prd/SKILL.md';

function releaseIdentities(version = '0.1.0') {
  const identity = {
    name: '@ikon85/agent-workflow-kit',
    version,
    tarballIntegrity: 'sha512-fixture',
    manifestSha256: 'fixture-manifest',
  };
  return {
    installed: { name: identity.name, version, manifestSha256: identity.manifestSha256 },
    npm: { ...identity },
    github: { ...identity },
  };
}

function runHeadless(args, { kit, consumer }) {
  const script = `
    import { runCli } from ${JSON.stringify(`file://${CLI}`)};
    import { update } from ${JSON.stringify(`file://${UPDATE}`)};
    const identities = ${JSON.stringify(releaseIdentities())};
    process.exitCode = await runCli({
      argv: ${JSON.stringify(args)},
      kitRoot: ${JSON.stringify(kit)},
      consumerRoot: ${JSON.stringify(consumer)},
      hasTTY: false,
      readUpdateRelease: async () => identities,
      updateCommand: (options) => update({ ...options, verify: async () => {} }),
    });
  `;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: consumer,
    encoding: 'utf8',
    input: '',
    timeout: 20_000,
  });
}

async function bumpKit(kit, content) {
  await writeFile(join(kit, P), content);
  const manifestPath = join(kit, PACKAGE_MANIFEST_NAME);
  const manifest = await readManifest(manifestPath);
  manifest.files.find(({ path }) => path === P).sha256 = sha256(content);
  await writeManifest(manifestPath, manifest);
}

test('headless update without flags fails cleanly before reading or writing consumer state', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, 'v2\n');
    const manifestPath = join(consumer, CONSUMER_MANIFEST_NAME);
    const before = await readFile(manifestPath);

    const result = runHeadless(['update'], { kit, consumer });

    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /interactive prompts need a TTY/i);
    assert.match(output, /--yes/);
    assert.match(output, /--keep-deleted/);
    assert.match(output, /--restore-deleted/);
    assert.doesNotMatch(output, /uv_tty_init|TTY initialization failed/i);
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v1\n');
    assert.deepEqual(await readFile(manifestPath), before);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('headless flagged update applies clean changes and restores upstream-deleted files on request', async () => {
  const removed = 'docs/removed.md';
  const kit = await makeKit({ [P]: 'v1\n', [removed]: 'legacy\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, 'v2\n');
    const manifestPath = join(kit, PACKAGE_MANIFEST_NAME);
    const manifest = await readManifest(manifestPath);
    manifest.files = manifest.files.filter(({ path }) => path !== removed);
    await writeManifest(manifestPath, manifest);

    const result = runHeadless(['update', '--yes', '--restore-deleted'], { kit, consumer });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v2\n');
    assert.equal(await readFile(join(consumer, removed), 'utf8'), 'legacy\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('headless flagged conflict fails closed and preserves consumer bytes', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, P), 'consumer edit\n');
    await bumpKit(kit, 'v2\n');
    const manifestPath = join(consumer, CONSUMER_MANIFEST_NAME);
    const beforeManifest = await readFile(manifestPath);

    const result = runHeadless(['update', '--yes', '--keep-deleted'], { kit, consumer });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /conflict \(not applied\)/);
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'consumer edit\n');
    assert.deepEqual(await readFile(manifestPath), beforeManifest);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('blanket deletion flags override only the safe delete decision', () => {
  assert.equal(nonInteractiveUpdateDecision('delete', { deleted: 'keep' }), true);
  assert.equal(nonInteractiveUpdateDecision('delete', { deleted: 'restore' }), false);
  assert.equal(nonInteractiveUpdateDecision('collision', { deleted: 'restore' }), undefined);
});
