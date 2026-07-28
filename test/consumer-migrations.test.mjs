import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../src/commands/init.mjs';
import { update } from '../src/commands/update.mjs';
import { diff } from '../src/commands/diff.mjs';
import {
  CONSUMER_MIGRATION_SCHEMA_VERSION, evaluateConsumerAdvisories, evaluateConsumerMigrations,
  readShippedConsumerMigrationRegistry, renderConsumerAdvisory, renderRequiredMigration,
  validateConsumerMigrationRegistry,
} from '../src/lib/consumerMigrations.mjs';
import { PACKAGE_MANIFEST_NAME, readManifest, writeManifest } from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { cleanup, makeEmptyDir, makeKit } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const UPDATE = fileURLToPath(new URL('../src/commands/update.mjs', import.meta.url));
const REGISTRY = fileURLToPath(new URL('../src/consumer-migrations.json', import.meta.url));
const P = '.claude/skills/to-prd/SKILL.md';
const POLICY_PATH = 'docs/agents/workflow-capabilities.json';
const KIT_VERSION = '0.38.0';

// The registry is a mechanism, not a list of live requirements: the green slate
// removed the only registered migration (ADR-0009 §6). The mechanism therefore
// proves itself against a synthetic registry, never against shipped data.
const SAMPLE_MIGRATION = 'example-consumer-decision';
const SAMPLE_DECISION = 'exampleCapability.exampleDecision';
const SAMPLE_REGISTRY = {
  schemaVersion: 1,
  migrations: [{
    id: SAMPLE_MIGRATION,
    requiredFrom: KIT_VERSION,
    title: 'Example consumer decision',
    workflow: 'setup-workflow',
    decision: SAMPLE_DECISION,
    detect: {
      type: 'json-key',
      path: POLICY_PATH,
      key: ['exampleCapability', 'exampleDecision'],
    },
    consequence: 'The workflow fails closed until the decision is committed.',
    remediation: 'Run setup-workflow and commit the decision it writes.',
  }],
};

const verify = async () => {};

function releaseIdentities(version = KIT_VERSION) {
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

async function bumpKit(kit, content) {
  await writeFile(join(kit, P), content);
  const manifestPath = join(kit, PACKAGE_MANIFEST_NAME);
  const manifest = await readManifest(manifestPath);
  manifest.files.find(({ path }) => path === P).sha256 = sha256(content);
  await writeManifest(manifestPath, manifest);
}

async function writeConsumerPolicy(consumer, document) {
  const target = join(consumer, POLICY_PATH);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
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

test('the shipped registry separates required migrations from retired-key advisories', async () => {
  const registry = await readShippedConsumerMigrationRegistry();

  assert.equal(registry.schemaVersion, CONSUMER_MIGRATION_SCHEMA_VERSION);
  assert.deepEqual([...registry.migrations], []);
  assert.deepEqual(
    registry.advisories.map(({ id, retiredIn, detect }) => ({
      id, retiredIn, path: detect.path, key: detect.key,
    })),
    [
      {
        id: 'retired-worktree-scratch-patterns',
        retiredIn: '0.44.0',
        path: POLICY_PATH,
        key: ['worktreeLifecycle', 'scratchPatterns'],
      },
      {
        id: 'retired-wrapup-generated-artifact-patterns',
        retiredIn: '0.44.0',
        path: POLICY_PATH,
        key: ['wrapup', 'landingGeneratedArtifactPatterns'],
      },
    ],
  );
});

test('retired teardown keys are advisory only and render as safe consumer-owned cleanup', async () => {
  const consumer = await makeEmptyDir();
  try {
    await writeConsumerPolicy(consumer, {
      worktreeLifecycle: { scratchPatterns: ['PLAN.md'] },
      wrapup: { landingGeneratedArtifactPatterns: ['dist/**'] },
    });

    const advisories = await evaluateConsumerAdvisories({
      consumerRoot: consumer,
      kitVersion: '0.44.1',
    });

    assert.deepEqual(
      advisories.map(({ id, state, key }) => ({ id, state, key })),
      [
        {
          id: 'retired-worktree-scratch-patterns',
          state: 'advisory',
          key: 'worktreeLifecycle.scratchPatterns',
        },
        {
          id: 'retired-wrapup-generated-artifact-patterns',
          state: 'advisory',
          key: 'wrapup.landingGeneratedArtifactPatterns',
        },
      ],
    );
    for (const advisory of advisories) {
      assert.match(renderConsumerAdvisory(advisory), /safe to delete/);
      assert.match(renderConsumerAdvisory(advisory), new RegExp(advisory.key));
    }
  } finally {
    await cleanup(consumer);
  }
});

test('registry validation rejects an unknown detector, version, or duplicate id', () => {
  const [entry] = SAMPLE_REGISTRY.migrations;
  assert.throws(
    () => validateConsumerMigrationRegistry({ schemaVersion: 2, migrations: [] }),
    /consumer migration registry: unsupported schemaVersion/,
  );
  assert.throws(
    () => validateConsumerMigrationRegistry({
      schemaVersion: 1,
      migrations: [{ ...entry, detect: { ...entry.detect, type: 'run-command' } }],
    }),
    /unsupported detector/,
  );
  assert.throws(
    () => validateConsumerMigrationRegistry({ schemaVersion: 1, migrations: [entry, entry] }),
    /duplicate migration id/,
  );
  assert.throws(
    () => validateConsumerMigrationRegistry({
      schemaVersion: 1,
      migrations: [{ ...entry, detect: { ...entry.detect, path: '../escape.json' } }],
    }),
    /unsafe consumer path/,
  );
  assert.deepEqual(
    validateConsumerMigrationRegistry({ schemaVersion: 1, migrations: [entry] }).migrations.length,
    1,
  );
});

test('a missing or undecided registered decision is pending, an explicit one is resolved', async () => {
  const consumer = await makeEmptyDir();
  const evaluate = () => evaluateConsumerMigrations({
    consumerRoot: consumer, kitVersion: KIT_VERSION, registry: SAMPLE_REGISTRY,
  });
  try {
    const pendingWithoutFile = await evaluate();
    assert.deepEqual(pendingWithoutFile.map(({ id }) => id), [SAMPLE_MIGRATION]);
    assert.equal(pendingWithoutFile[0].state, 'pending');
    assert.equal(pendingWithoutFile[0].reason, 'missing-file');
    assert.equal(pendingWithoutFile[0].decision, SAMPLE_DECISION);
    assert.equal(pendingWithoutFile[0].path, POLICY_PATH);
    assert.equal(pendingWithoutFile[0].workflow, 'setup-workflow');

    await writeConsumerPolicy(consumer, { worktreeLifecycle: { enabled: true } });
    const pendingWithoutDecision = await evaluate();
    assert.deepEqual(pendingWithoutDecision.map(({ id }) => id), [SAMPLE_MIGRATION]);
    assert.equal(pendingWithoutDecision[0].reason, 'missing-decision');

    // An explicit empty list is a committed decision, not an absent one.
    await writeConsumerPolicy(consumer, {
      worktreeLifecycle: { enabled: true },
      exampleCapability: { exampleDecision: [] },
    });
    assert.deepEqual(await evaluate(), []);
  } finally {
    await cleanup(consumer);
  }
});

test('a migration stays silent below the kit version that introduced it', async () => {
  const consumer = await makeEmptyDir();
  const evaluate = (kitVersion) => evaluateConsumerMigrations({
    consumerRoot: consumer, kitVersion, registry: SAMPLE_REGISTRY,
  });
  try {
    assert.deepEqual(await evaluate('0.37.9'), []);
    assert.equal((await evaluate('1.4.0')).length, 1);
  } finally {
    await cleanup(consumer);
  }
});

test('one rendering names the workflow, the profile, and the exact decision', () => {
  assert.equal(
    renderRequiredMigration({
      id: SAMPLE_MIGRATION,
      workflow: 'setup-workflow',
      path: POLICY_PATH,
      decision: SAMPLE_DECISION,
    }),
    `required migration: ${SAMPLE_MIGRATION} · setup-workflow · ${POLICY_PATH}`
      + ` · ${SAMPLE_DECISION}`,
  );
});

test('preview of a consumer with nothing registered owes no migration', async () => {
  const kit = await makeKit({ [P]: 'v1\n' }, KIT_VERSION);
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, 'v2\n');

    const preview = await diff({ kitRoot: kit, consumerRoot: consumer });

    assert.equal(preview.state, 'preview');
    assert.deepEqual(preview.requiredMigrations, []);
    assert.deepEqual(preview.report.requiredMigrations, preview.requiredMigrations);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('applying reports the migration state and never writes the policy', async () => {
  const kit = await makeKit({ [P]: 'v1\n' }, KIT_VERSION);
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeConsumerPolicy(consumer, { worktreeLifecycle: { enabled: true } });
    const policyBefore = await readFile(join(consumer, POLICY_PATH));
    await bumpKit(kit, 'v2\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify,
    });

    assert.equal(result.state, 'applied');
    assert.equal(result.status, 'updated');
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v2\n');
    assert.deepEqual(result.report.requiredMigrations, []);
    assert.deepEqual(await readFile(join(consumer, POLICY_PATH)), policyBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('update and diff report retired keys without changing the consumer profile', async () => {
  const targetVersion = '0.44.1';
  const kit = await makeKit({ [P]: 'v1\n' }, targetVersion);
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeConsumerPolicy(consumer, {
      worktreeLifecycle: { enabled: true, scratchPatterns: ['PLAN.md'] },
      wrapup: { landingGeneratedArtifactPatterns: ['dist/**'] },
    });
    const policyBefore = await readFile(join(consumer, POLICY_PATH));
    await bumpKit(kit, 'v2\n');

    const preview = await diff({ kitRoot: kit, consumerRoot: consumer });
    const applied = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(targetVersion),
      verify,
    });

    assert.deepEqual(preview.requiredMigrations, []);
    assert.deepEqual(applied.report.requiredMigrations, []);
    assert.deepEqual(
      preview.advisories.map(({ key }) => key),
      [
        'worktreeLifecycle.scratchPatterns',
        'wrapup.landingGeneratedArtifactPatterns',
      ],
    );
    assert.deepEqual(preview.report.advisories, preview.advisories);
    assert.deepEqual(applied.report.advisories, preview.advisories);
    assert.deepEqual(await readFile(join(consumer, POLICY_PATH)), policyBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('headless JSON and rendered update paths expose the same migration state', async () => {
  const kit = await makeKit({ [P]: 'v1\n' }, KIT_VERSION);
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, 'v2\n');

    const rendered = runHeadless(['update', '--yes'], { kit, consumer });
    assert.equal(rendered.status, 0, `${rendered.stdout}${rendered.stderr}`);
    assert.doesNotMatch(rendered.stdout, /required migration:/);

    await bumpKit(kit, 'v3\n');
    const headless = runHeadless(['update', '--yes', '--json'], { kit, consumer });
    assert.equal(headless.status, 0, `${headless.stdout}${headless.stderr}`);
    const document = JSON.parse(headless.stdout);
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.state, 'applied');
    assert.deepEqual(document.report.requiredMigrations, []);
  } finally {
    await cleanup(kit, consumer);
  }
});
