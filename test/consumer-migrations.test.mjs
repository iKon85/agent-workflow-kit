import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../src/commands/init.mjs';
import { update } from '../src/commands/update.mjs';
import { diff } from '../src/commands/diff.mjs';
import {
  CONSUMER_MIGRATION_SCHEMA_VERSION, evaluateConsumerMigrations,
  readShippedConsumerMigrationRegistry, validateConsumerMigrationRegistry,
} from '../src/lib/consumerMigrations.mjs';
import { PACKAGE_MANIFEST_NAME, readManifest, writeManifest } from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { cleanup, makeEmptyDir, makeKit } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const UPDATE = fileURLToPath(new URL('../src/commands/update.mjs', import.meta.url));
const P = '.claude/skills/to-prd/SKILL.md';
const POLICY_PATH = 'docs/agents/workflow-capabilities.json';
const POLICY_DECISION = 'wrapup.landingGeneratedArtifactPatterns';
const LANDING_MIGRATION = 'wrapup-landing-artifact-policy';
const KIT_VERSION = '0.38.0';

const exists = (path) => access(path).then(() => true, () => false);
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

test('the shipped consumer-migration registry is declarative versioned data', async () => {
  const registry = await readShippedConsumerMigrationRegistry();

  assert.equal(registry.schemaVersion, CONSUMER_MIGRATION_SCHEMA_VERSION);
  const landing = registry.migrations.find(({ id }) => id === LANDING_MIGRATION);
  assert.ok(landing, 'the 0.38.0 landing-artifact policy is a registered migration');
  assert.equal(landing.requiredFrom, KIT_VERSION);
  assert.equal(landing.workflow, 'setup-workflow');
  assert.equal(landing.decision, POLICY_DECISION);
  assert.equal(landing.detect.type, 'json-key');
  assert.equal(landing.detect.path, POLICY_PATH);
  assert.deepEqual(landing.detect.key, ['wrapup', 'landingGeneratedArtifactPatterns']);
});

test('registry validation rejects an unknown detector, version, or duplicate id', () => {
  const entry = {
    id: 'x', requiredFrom: '1.0.0', title: 't', workflow: 'setup-workflow',
    decision: 'a.b', consequence: 'c', remediation: 'r',
    detect: { type: 'json-key', path: 'docs/agents/x.json', key: ['a', 'b'] },
  };
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

test('a missing or undecided landing policy is pending, an explicit one is resolved', async () => {
  const consumer = await makeEmptyDir();
  try {
    const pendingWithoutFile = await evaluateConsumerMigrations({
      consumerRoot: consumer, kitVersion: KIT_VERSION,
    });
    assert.deepEqual(pendingWithoutFile.map(({ id }) => id), [LANDING_MIGRATION]);
    assert.equal(pendingWithoutFile[0].state, 'pending');
    assert.equal(pendingWithoutFile[0].reason, 'missing-file');

    await writeConsumerPolicy(consumer, { worktreeLifecycle: { enabled: true } });
    const pendingWithoutDecision = await evaluateConsumerMigrations({
      consumerRoot: consumer, kitVersion: KIT_VERSION,
    });
    assert.deepEqual(pendingWithoutDecision.map(({ id }) => id), [LANDING_MIGRATION]);
    assert.equal(pendingWithoutDecision[0].reason, 'missing-decision');

    // An explicit empty list is a committed decision, not an absent one.
    await writeConsumerPolicy(consumer, {
      worktreeLifecycle: { enabled: true },
      wrapup: { landingGeneratedArtifactPatterns: [] },
    });
    assert.deepEqual(await evaluateConsumerMigrations({
      consumerRoot: consumer, kitVersion: KIT_VERSION,
    }), []);
  } finally {
    await cleanup(consumer);
  }
});

test('a migration stays silent below the kit version that introduced it', async () => {
  const consumer = await makeEmptyDir();
  try {
    assert.deepEqual(
      await evaluateConsumerMigrations({ consumerRoot: consumer, kitVersion: '0.37.9' }),
      [],
    );
    assert.equal(
      (await evaluateConsumerMigrations({ consumerRoot: consumer, kitVersion: '1.4.0' })).length,
      1,
    );
  } finally {
    await cleanup(consumer);
  }
});

test('preview of a pre-policy consumer names the workflow, profile, and decision', async () => {
  const kit = await makeKit({ [P]: 'v1\n' }, KIT_VERSION);
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, 'v2\n');

    const preview = await diff({ kitRoot: kit, consumerRoot: consumer });

    assert.equal(preview.state, 'preview');
    const [action] = preview.requiredMigrations;
    assert.equal(action.id, LANDING_MIGRATION);
    assert.equal(action.workflow, 'setup-workflow');
    assert.equal(action.path, POLICY_PATH);
    assert.equal(action.decision, POLICY_DECISION);
    assert.deepEqual(preview.report.requiredMigrations, preview.requiredMigrations);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('applying with a pending action reports it and never writes the policy', async () => {
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
    assert.deepEqual(result.report.requiredMigrations.map(({ id }) => id), [LANDING_MIGRATION]);
    assert.deepEqual(await readFile(join(consumer, POLICY_PATH)), policyBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a committed policy clears the action on the next preview and apply', async () => {
  const kit = await makeKit({ [P]: 'v1\n' }, KIT_VERSION);
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, 'v2\n');
    await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
    });
    await writeConsumerPolicy(consumer, {
      worktreeLifecycle: { enabled: true },
      wrapup: { landingGeneratedArtifactPatterns: ['dist/**'] },
    });

    const rerunPreview = await diff({ kitRoot: kit, consumerRoot: consumer });
    const rerun = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
    });

    assert.deepEqual(rerunPreview.requiredMigrations, []);
    assert.deepEqual(rerun.report.requiredMigrations, []);
    assert.equal(rerun.status, 'current');
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
    assert.match(rendered.stdout, /required migration: wrapup-landing-artifact-policy/);
    assert.match(rendered.stdout, /setup-workflow/);
    assert.match(rendered.stdout, /docs\/agents\/workflow-capabilities\.json/);
    assert.match(rendered.stdout, /wrapup\.landingGeneratedArtifactPatterns/);

    await bumpKit(kit, 'v3\n');
    const headless = runHeadless(['update', '--yes', '--json'], { kit, consumer });
    assert.equal(headless.status, 0, `${headless.stdout}${headless.stderr}`);
    const document = JSON.parse(headless.stdout);
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.state, 'applied');
    assert.deepEqual(document.report.requiredMigrations.map(({ id, workflow, path, decision }) => (
      { id, workflow, path, decision }
    )), [{
      id: LANDING_MIGRATION,
      workflow: 'setup-workflow',
      path: POLICY_PATH,
      decision: POLICY_DECISION,
    }]);
    assert.equal(await exists(join(consumer, POLICY_PATH)), false, 'no policy was invented');
  } finally {
    await cleanup(kit, consumer);
  }
});
