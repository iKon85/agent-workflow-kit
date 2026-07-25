import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { init } from '../src/commands/init.mjs';
import { update } from '../src/commands/update.mjs';
import {
  CONSUMER_MANIFEST_NAME, PACKAGE_MANIFEST_NAME, readManifest, writeManifest,
} from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { nonInteractiveUpdateDecision } from '../src/lib/updateDecisions.mjs';
import { cleanup, makeEmptyDir, makeKit } from './helpers.mjs';

const BASE = '.claude/skills/to-prd/SKILL.md';
const COLLISION = 'docs/new-collision.md';
const verify = async () => {};
const exists = (path) => access(path).then(() => true, () => false);

function releaseIdentities() {
  const identity = {
    name: '@ikon85/agent-workflow-kit', version: '0.1.0',
    tarballIntegrity: 'sha512-fixture', manifestSha256: 'fixture-manifest',
  };
  return {
    installed: { name: identity.name, version: identity.version, manifestSha256: identity.manifestSha256 },
    npm: { ...identity }, github: { ...identity },
  };
}

async function makeCollisionFixture(paths = [COLLISION]) {
  const kit = await makeKit({ [BASE]: 'base bytes\n' });
  const consumer = await makeEmptyDir();
  await init({ kitRoot: kit, consumerRoot: consumer });
  const pkgPath = join(kit, PACKAGE_MANIFEST_NAME);
  const pkg = await readManifest(pkgPath);
  for (const path of paths) {
    await mkdir(dirname(join(kit, path)), { recursive: true });
    await mkdir(dirname(join(consumer, path)), { recursive: true });
    await writeFile(join(kit, path), `kit bytes for ${path}\n`);
    await writeFile(join(consumer, path), `consumer bytes for ${path}\n`);
    pkg.files.push({
      path, kind: 'doc', sha256: sha256(`kit bytes for ${path}\n`),
      mode: 0o644, origin: 'kit',
    });
  }
  await writeManifest(pkgPath, pkg);
  return { kit, consumer, paths };
}

test('dry-run reports an existing untracked destination as a collision without overwriting it', async () => {
  const fixture = await makeCollisionFixture();
  try {
    const before = await readFile(join(fixture.consumer, COLLISION));
    const result = await update({
      kitRoot: fixture.kit, consumerRoot: fixture.consumer, dryRun: true,
      decide: () => { throw new Error('dry-run must not prompt'); },
    });

    assert.deepEqual(result.collisions, [COLLISION]);
    assert.deepEqual(result.added, []);
    assert.deepEqual(await readFile(join(fixture.consumer, COLLISION)), before);
  } finally {
    await cleanup(fixture.kit, fixture.consumer);
  }
});

test('an unclassified collision blocks repeatably with evidence and routes, never mutation', async () => {
  const fixture = await makeCollisionFixture();
  try {
    const manifestPath = join(fixture.consumer, CONSUMER_MANIFEST_NAME);
    const manifestBefore = await readFile(manifestPath);
    const bytesBefore = await readFile(join(fixture.consumer, COLLISION));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await update({
        kitRoot: fixture.kit,
        consumerRoot: fixture.consumer,
        releaseIdentities: releaseIdentities(),
        verify,
        decide: nonInteractiveUpdateDecision,
      });
      assert.equal(result.state, 'conflicted');
      assert.deepEqual(result.ownershipStates, [{
        path: COLLISION,
        state: 'ambiguous-collision',
        evidence: {
          packageDeclared: true,
          ledgerOrigin: 'absent',
          destination: 'present',
          projectExtension: 'absent',
        },
        routes: [
          { id: 'project-extension', action: `move Project data to docs/agents/skills/<skill>.md` },
          { id: 'contribution-bridge', action: 'register a temporary contribution-bridge' },
          { id: 'explicit-fork', action: 'register an explicit-fork with its own update line' },
          { id: 'clean-core', action: 'explicitly replace the destination with Kit Core' },
        ],
      }]);
      assert.match(result.report.recommendation, new RegExp(COLLISION));
      assert.match(result.report.recommendation, /contribution-bridge.*explicit-fork/);
      assert.deepEqual(await readFile(manifestPath), manifestBefore);
      assert.deepEqual(await readFile(join(fixture.consumer, COLLISION)), bytesBefore);
    }
  } finally {
    await cleanup(fixture.kit, fixture.consumer);
  }
});

test('an explicit contribution-bridge decision retains bytes and records its lifecycle', async () => {
  const fixture = await makeCollisionFixture();
  try {
    const bytesBefore = await readFile(join(fixture.consumer, COLLISION));
    const result = await update({
      kitRoot: fixture.kit,
      consumerRoot: fixture.consumer,
      releaseIdentities: releaseIdentities(),
      verify,
      decide: () => 'contribution-bridge',
    });

    assert.equal(result.state, 'applied', result.error);
    assert.deepEqual(await readFile(join(fixture.consumer, COLLISION)), bytesBefore);
    const manifest = await readManifest(join(fixture.consumer, CONSUMER_MANIFEST_NAME));
    assert.deepEqual(
      manifest.installed.find(({ path }) => path === COLLISION),
      {
        path: COLLISION,
        kind: 'doc',
        installedSha256: sha256(`consumer bytes for ${COLLISION}\n`),
        origin: 'consumer',
        installRole: 'consumer',
        ownershipState: 'contribution-bridge',
      },
    );
  } finally {
    await cleanup(fixture.kit, fixture.consumer);
  }
});

test('a versioned Project extension collision is classified and may be kept explicitly', async () => {
  const path = 'docs/agents/skills/tdd.md';
  const fixture = await makeCollisionFixture([path]);
  try {
    const body =
      '<!-- agent-workflow-kit: project-extension/v1; skill=tdd -->\n# Local TDD policy\n';
    await writeFile(join(fixture.consumer, path), body);
    const preview = await update({
      kitRoot: fixture.kit,
      consumerRoot: fixture.consumer,
      dryRun: true,
    });
    assert.equal(preview.ownershipStates[0].state, 'project-extension');
    assert.equal(preview.ownershipStates[0].evidence.projectExtension, 'schema-v1');

    const result = await update({
      kitRoot: fixture.kit,
      consumerRoot: fixture.consumer,
      releaseIdentities: releaseIdentities(),
      verify,
      decide: () => 'project-extension',
    });
    assert.equal(result.state, 'applied', result.error);
    assert.equal(await readFile(join(fixture.consumer, path), 'utf8'), body);
    const manifest = await readManifest(join(fixture.consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(
      manifest.installed.find((entry) => entry.path === path).ownershipState,
      'project-extension',
    );
    const second = await update({
      kitRoot: fixture.kit,
      consumerRoot: fixture.consumer,
      releaseIdentities: releaseIdentities(),
      verify,
    });
    assert.equal(second.state, 'applied');
    assert.equal(second.status, 'current');

    const invalid =
      '<!-- agent-workflow-kit: project-extension/v2; skill=tdd -->\n# Future\n';
    await writeFile(join(fixture.consumer, path), invalid);
    const ledgerBefore = await readFile(join(fixture.consumer, CONSUMER_MANIFEST_NAME));
    const blocked = await update({
      kitRoot: fixture.kit,
      consumerRoot: fixture.consumer,
      releaseIdentities: releaseIdentities(),
      verify,
    });
    assert.equal(blocked.state, 'conflicted');
    assert.match(blocked.report.recommendation, /extension=invalid/);
    assert.match(blocked.report.recommendation, /project-extension.*explicit-fork/);
    assert.equal(await readFile(join(fixture.consumer, path), 'utf8'), invalid);
    assert.deepEqual(
      await readFile(join(fixture.consumer, CONSUMER_MANIFEST_NAME)),
      ledgerBefore,
    );
  } finally {
    await cleanup(fixture.kit, fixture.consumer);
  }
});

test('keep-as-owned adopts existing bytes while replace installs kit bytes', async (t) => {
  for (const outcome of ['keep-as-owned', 'replace']) {
    await t.test(outcome, async () => {
      const fixture = await makeCollisionFixture();
      try {
        const result = await update({
          kitRoot: fixture.kit, consumerRoot: fixture.consumer,
          releaseIdentities: releaseIdentities(), verify,
          decide: (action, path) => {
            assert.deepEqual([action, path], ['collision', COLLISION]);
            return outcome;
          },
        });

        assert.equal(result.state, 'applied');
        assert.deepEqual(result.collisions, []);
        assert.deepEqual(result.collisionResolutions, [{
          path: COLLISION,
          outcome,
          destinationSha256: sha256(`consumer bytes for ${COLLISION}\n`),
        }]);
        const manifest = await readManifest(join(fixture.consumer, CONSUMER_MANIFEST_NAME));
        const installed = manifest.installed.find(({ path }) => path === COLLISION);
        if (outcome === 'keep-as-owned') {
          assert.equal(installed.origin, 'consumer');
          assert.equal(installed.installedSha256, sha256(`consumer bytes for ${COLLISION}\n`));
          assert.equal(
            await readFile(join(fixture.consumer, COLLISION), 'utf8'),
            `consumer bytes for ${COLLISION}\n`,
          );
        } else {
          assert.equal(installed.origin, 'kit');
          assert.deepEqual(result.added, [COLLISION]);
          assert.equal(
            await readFile(join(fixture.consumer, COLLISION), 'utf8'),
            `kit bytes for ${COLLISION}\n`,
          );
        }
      } finally {
        await cleanup(fixture.kit, fixture.consumer);
      }
    });
  }
});

test('resolved preview drives activation and the final report', async () => {
  const fixture = await makeCollisionFixture();
  try {
    const result = await update({
      kitRoot: fixture.kit, consumerRoot: fixture.consumer,
      releaseIdentities: releaseIdentities(), verify,
      decide: () => 'replace',
    });

    assert.deepEqual(result.history, [
      'checking', 'preview', 'awaiting_decision', 'staging', 'verifying', 'applied',
    ]);
    assert.deepEqual(result.collisions, []);
    assert.deepEqual(result.added, [COLLISION]);
    assert.deepEqual(result.report.paths.added, [COLLISION]);
    assert.equal(result.report.added, 1);
    assert.equal(await readFile(join(fixture.consumer, COLLISION), 'utf8'), `kit bytes for ${COLLISION}\n`);
  } finally {
    await cleanup(fixture.kit, fixture.consumer);
  }
});

test('a collision destination changed during verification aborts every ownership route', async (t) => {
  for (const outcome of ['keep-as-owned', 'contribution-bridge', 'explicit-fork', 'replace']) {
    await t.test(outcome, async () => {
      const fixture = await makeCollisionFixture();
      try {
        const manifestPath = join(fixture.consumer, CONSUMER_MANIFEST_NAME);
        const manifestBefore = await readFile(manifestPath);
        const result = await update({
          kitRoot: fixture.kit, consumerRoot: fixture.consumer,
          releaseIdentities: releaseIdentities(), decide: () => outcome,
          verify: async () => {
            await writeFile(join(fixture.consumer, COLLISION), 'late consumer bytes\n');
          },
        });

        assert.equal(result.state, 'failed');
        assert.match(result.error, /consumer changed during verification/);
        assert.equal(await readFile(join(fixture.consumer, COLLISION), 'utf8'), 'late consumer bytes\n');
        assert.deepEqual(await readFile(manifestPath), manifestBefore);
      } finally {
        await cleanup(fixture.kit, fixture.consumer);
      }
    });
  }
});

test('a collision candidate cannot resume under a different unproven resolution', async () => {
  const fixture = await makeCollisionFixture();
  const controller = new AbortController();
  try {
    const manifestPath = join(fixture.consumer, CONSUMER_MANIFEST_NAME);
    const manifestBefore = await readFile(manifestPath);
    const bytesBefore = await readFile(join(fixture.consumer, COLLISION));
    const interrupted = await update({
      kitRoot: fixture.kit, consumerRoot: fixture.consumer,
      releaseIdentities: releaseIdentities(), decide: () => 'replace', verify,
      signal: controller.signal,
      onState: (state) => { if (state === 'verifying') controller.abort(); },
    });
    assert.equal(interrupted.state, 'aborted');
    assert.equal(await exists(interrupted.candidateRoot), true);

    const resumed = await update({
      kitRoot: fixture.kit, consumerRoot: fixture.consumer,
      releaseIdentities: releaseIdentities(), decide: () => 'keep-as-owned', verify,
      resumeFrom: interrupted.candidateRoot,
    });

    assert.equal(resumed.state, 'failed');
    assert.match(resumed.error, /collision-bearing candidate cannot be resumed safely/);
    assert.deepEqual(await readFile(manifestPath), manifestBefore);
    assert.deepEqual(await readFile(join(fixture.consumer, COLLISION)), bytesBefore);
    assert.equal(await exists(interrupted.candidateRoot), false);
  } finally {
    await cleanup(fixture.kit, fixture.consumer);
  }
});

test('cancelling after an earlier collision decision applies nothing', async () => {
  const second = 'docs/second-collision.md';
  const fixture = await makeCollisionFixture([COLLISION, second]);
  try {
    const manifestPath = join(fixture.consumer, CONSUMER_MANIFEST_NAME);
    const manifestBefore = await readFile(manifestPath);
    const bytesBefore = new Map(await Promise.all(fixture.paths.map(async (path) => [
      path, await readFile(join(fixture.consumer, path)),
    ])));
    let prompts = 0;

    await assert.rejects(update({
      kitRoot: fixture.kit, consumerRoot: fixture.consumer,
      releaseIdentities: releaseIdentities(), verify,
      decide: () => {
        prompts += 1;
        if (prompts === 1) return 'replace';
        throw new Error('collision decision cancelled');
      },
    }), /collision decision cancelled/);

    assert.equal(prompts, 2);
    assert.deepEqual(await readFile(manifestPath), manifestBefore);
    for (const path of fixture.paths) {
      assert.deepEqual(await readFile(join(fixture.consumer, path)), bytesBefore.get(path));
    }
  } finally {
    await cleanup(fixture.kit, fixture.consumer);
  }
});
