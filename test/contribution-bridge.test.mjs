import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { init } from '../src/commands/init.mjs';
import { update } from '../src/commands/update.mjs';
import {
  beginContributionBridge, prepareContributionArtifact,
} from '../src/lib/contributionBridge.mjs';
import { reconcile } from '../src/lib/updateReconcile.mjs';
import {
  CONSUMER_MANIFEST_NAME, readManifest,
} from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { cleanup, makeEmptyDir, makeKit } from './helpers.mjs';

const CORE = 'scripts/example-core.mjs';

function releaseIdentities(version) {
  const identity = {
    name: '@ikon85/agent-workflow-kit',
    version,
    tarballIntegrity: 'sha512-fixture',
    manifestSha256: 'fixture-manifest',
  };
  return {
    installed: {
      name: identity.name, version, manifestSha256: identity.manifestSha256,
    },
    npm: { ...identity },
    github: { ...identity },
  };
}

test('only a modified declared Kit Core identity can enter contribution bridge state', async () => {
  const kit = await makeKit({ [CORE]: 'export const value = 1;\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });

    await assert.rejects(
      beginContributionBridge({ kitRoot: kit, consumerRoot: consumer, path: CORE }),
      /has no local Core change/,
    );

    await writeFile(join(consumer, CORE), 'export const value = 2;\n');
    const result = await beginContributionBridge({
      kitRoot: kit, consumerRoot: consumer, path: CORE,
    });
    assert.deepEqual(result, {
      path: CORE,
      state: 'contribution-bridge',
      bridge: {
        schemaVersion: 1,
        baseKitVersion: '0.1.0',
        baseSha256: sha256('export const value = 1;\n'),
        localSha256: sha256('export const value = 2;\n'),
      },
    });

    const manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    const tracked = manifest.installed.find(({ path }) => path === CORE);
    assert.equal(tracked.origin, 'consumer');
    assert.equal(tracked.ownershipState, 'contribution-bridge');
    assert.equal(tracked.installedSha256, sha256('export const value = 2;\n'));
    assert.deepEqual(tracked.contributionBridge, result.bridge);

    await assert.rejects(
      beginContributionBridge({ kitRoot: kit, consumerRoot: consumer, path: CORE }),
      /requires clean Kit ownership/,
    );
    await assert.rejects(
      beginContributionBridge({
        kitRoot: kit, consumerRoot: consumer, path: 'docs/not-declared.md',
      }),
      /not declared Kit Core/,
    );
  } finally {
    await cleanup(kit, consumer);
  }
});

test('preparation writes one bounded provenance artifact and blocks a stale upstream base', async () => {
  const kit = await makeKit({ [CORE]: 'export const value = 1;\n' });
  const consumer = await makeEmptyDir();
  const staleKit = await makeKit({ [CORE]: 'export const value = 3;\n' }, '0.2.0');
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, CORE), 'export const value = 2;\n');
    await mkdir(join(consumer, 'private'), { recursive: true });
    await writeFile(join(consumer, 'private/consumer-secret.txt'), 'do-not-export\n');
    await beginContributionBridge({ kitRoot: kit, consumerRoot: consumer, path: CORE });

    const output = '.agent-workflow-kit/contributions/example-core.json';
    const result = await prepareContributionArtifact({
      kitRoot: kit, consumerRoot: consumer, path: CORE, output,
    });
    assert.equal(result.output, output);
    const raw = await readFile(join(consumer, output), 'utf8');
    const artifact = JSON.parse(raw);
    assert.deepEqual(artifact, {
      schemaVersion: 1,
      kind: 'agent-workflow-kit/contribution',
      coreIdentity: {
        path: CORE,
        baseKitVersion: '0.1.0',
        baseSha256: sha256('export const value = 1;\n'),
        localSha256: sha256('export const value = 2;\n'),
      },
      diff: {
        format: 'line-diff-v1',
        text: '-export const value = 1;\n+export const value = 2;\n ',
      },
    });
    assert.doesNotMatch(raw, /consumer-secret|do-not-export|awk-consumer|private\//);
    assert.deepEqual(
      await prepareContributionArtifact({
        kitRoot: kit, consumerRoot: consumer, path: CORE, output,
      }),
      result,
    );

    await assert.rejects(
      prepareContributionArtifact({
        kitRoot: staleKit, consumerRoot: consumer, path: CORE, output,
      }),
      /stale upstream base/,
    );
  } finally {
    await cleanup(kit, staleKit, consumer);
  }
});

test('a matching upstream release retires bridge state without losing Project entries', async () => {
  const baseKit = await makeKit({ [CORE]: 'export const value = 1;\n' });
  const releasedKit = await makeKit({ [CORE]: 'export const value = 2;\n' }, '0.2.0');
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: baseKit, consumerRoot: consumer });
    const manifestPath = join(consumer, CONSUMER_MANIFEST_NAME);
    const before = await readManifest(manifestPath);
    before.installed.push({
      path: 'docs/project-only.md',
      kind: 'doc',
      installedSha256: sha256('project behavior\n'),
      origin: 'consumer',
      installRole: 'consumer',
    });
    await mkdir(dirname(join(consumer, 'docs/project-only.md')), { recursive: true });
    await writeFile(join(consumer, 'docs/project-only.md'), 'project behavior\n');
    await writeFile(join(consumer, CORE), 'export const value = 2;\n');
    await writeFile(manifestPath, `${JSON.stringify(before, null, 2)}\n`);
    await beginContributionBridge({
      kitRoot: baseKit, consumerRoot: consumer, path: CORE,
    });

    const preview = await reconcile({
      kitRoot: releasedKit, consumerRoot: consumer, dryRun: true,
    });
    assert.deepEqual(preview.bridgeRetired, [CORE]);

    const applied = await update({
      kitRoot: releasedKit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities('0.2.0'),
    });
    assert.equal(applied.state, 'applied', applied.error);
    assert.equal(applied.status, 'updated');
    assert.deepEqual(applied.bridgeRetired, [CORE]);
    const after = await readManifest(manifestPath);
    const core = after.installed.find(({ path }) => path === CORE);
    assert.equal(core.origin, 'kit');
    assert.equal(core.installedSha256, sha256('export const value = 2;\n'));
    assert.equal(core.ownershipState, undefined);
    assert.equal(core.contributionBridge, undefined);
    assert.equal(
      after.installed.find(({ path }) => path === 'docs/project-only.md').origin,
      'consumer',
    );
    assert.equal(
      await readFile(join(consumer, 'docs/project-only.md'), 'utf8'),
      'project behavior\n',
    );
  } finally {
    await cleanup(baseKit, releasedKit, consumer);
  }
});
