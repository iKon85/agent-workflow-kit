import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { init } from '../src/commands/init.mjs';
import {
  readManifest, writeManifest, CONSUMER_MANIFEST_NAME, PACKAGE_MANIFEST_NAME,
} from '../src/lib/manifest.mjs';
import { firstLineState } from '../src/lib/sentinel.mjs';
import { STUB_TARGETS } from '../src/lib/bundle.mjs';
import { PROJECT_SKILL_REGISTRY_PATH } from '../src/lib/skillRegistry.mjs';
import { makeKit, makeEmptyDir, cleanup } from './helpers.mjs';

const exists = (p) => access(p).then(() => true, () => false);
const PRE_CHANGE_STUB_BYTES = '<!-- setup-workflow: state=stub -->\n';

test('init copies kit files, writes the consumer manifest, and seeds every doc stub byte-identically', async () => {
  const kit = await makeKit({ '.claude/skills/to-prd/SKILL.md': '# to-prd\n' });
  const consumer = await makeEmptyDir();
  try {
    const result = await init({ kitRoot: kit, consumerRoot: consumer });

    assert.equal(await readFile(join(consumer, '.claude/skills/to-prd/SKILL.md'), 'utf8'), '# to-prd\n');

    const mf = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    const entry = mf.installed.find((e) => e.path === '.claude/skills/to-prd/SKILL.md');
    assert.ok(entry.installedSha256, 'records a hash');
    assert.equal(entry.origin, 'kit');

    assert.deepEqual(
      await Promise.all(STUB_TARGETS.map(async (path) => ({
        path,
        bytes: await readFile(join(consumer, path), 'utf8'),
      }))),
      STUB_TARGETS.map((path) => ({ path, bytes: PRE_CHANGE_STUB_BYTES })),
    );
    assert.deepEqual(result.seeded, STUB_TARGETS);
    assert.equal(
      firstLineState(await readFile(join(consumer, 'docs/agents/issue-tracker.md'), 'utf8')),
      'stub',
    );
    // board-sync.md remains discovery-dependent and is not created by init.
    assert.equal(await exists(join(consumer, 'docs/agents/board-sync.md')), false);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('init rejects an invalid package manifest before copying or seeding consumer files', async () => {
  const path = '.claude/skills/to-prd/SKILL.md';
  const kit = await makeKit({ [path]: '# to-prd\n' });
  const consumer = await makeEmptyDir();
  try {
    const manifestPath = join(kit, PACKAGE_MANIFEST_NAME);
    const manifest = await readManifest(manifestPath);
    manifest.files.push({ ...manifest.files[0] });
    await writeManifest(manifestPath, manifest);

    await assert.rejects(
      init({ kitRoot: kit, consumerRoot: consumer }),
      /invalid package manifest.*duplicates path.*regenerate/i,
    );
    assert.equal(await exists(join(consumer, path)), false);
    assert.equal(await exists(join(consumer, CONSUMER_MANIFEST_NAME)), false);
    assert.equal(await exists(join(consumer, 'docs/agents/issue-tracker.md')), false);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('init establishes and preserves a consumer-owned Project skill registry beside Kit Core', async () => {
  const core = `${JSON.stringify({
    schema_version: 1,
    readiness: { contractVersion: 1, capabilities: {} },
    skills: {},
  }, null, 2)}\n`;
  const kit = await makeKit({ '.claude/skills/skill-manifest.json': core });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const projectRegistry = {
      schemaVersion: 1,
      coreSchemaVersion: 1,
      skills: {},
      annotations: {},
    };
    assert.deepEqual(
      JSON.parse(await readFile(join(consumer, PROJECT_SKILL_REGISTRY_PATH), 'utf8')),
      projectRegistry,
    );
    let manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(
      manifest.installed.find(({ path }) => path === PROJECT_SKILL_REGISTRY_PATH).origin,
      'consumer',
    );

    projectRegistry.skills.local = {
      class: 'project-private',
      publish: false,
      surfaces: ['claude'],
    };
    const localBytes = `${JSON.stringify(projectRegistry, null, 2)}\n`;
    await writeFile(join(consumer, PROJECT_SKILL_REGISTRY_PATH), localBytes);
    await init({ kitRoot: kit, consumerRoot: consumer, force: true });

    assert.equal(
      await readFile(join(consumer, PROJECT_SKILL_REGISTRY_PATH), 'utf8'),
      localBytes,
    );
    manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(
      manifest.installed.find(({ path }) => path === PROJECT_SKILL_REGISTRY_PATH).origin,
      'consumer',
    );
  } finally {
    await cleanup(kit, consumer);
  }
});

test('init installs only consumer-role files and records that role', async () => {
  const consumerPath = '.claude/skills/to-prd/SKILL.md';
  const maintainerPath = 'scripts/kit-release.mjs';
  const kit = await makeKit({
    [consumerPath]: '# to-prd\n',
    [maintainerPath]: 'import "./build-kit.mjs";\n',
  });
  const consumer = await makeEmptyDir();
  try {
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files.find(({ path }) => path === consumerPath).installRole = 'consumer';
    pkg.files.find(({ path }) => path === maintainerPath).installRole = 'maintainer';
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);

    await init({ kitRoot: kit, consumerRoot: consumer });

    assert.equal(await exists(join(consumer, maintainerPath)), false);
    const manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(manifest.installRole, 'consumer');
    assert.deepEqual(manifest.installed.map(({ path }) => path), [consumerPath]);
    assert.equal(manifest.installed[0].installRole, 'consumer');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('re-running init retains and classifies an edited legacy maintainer file', async () => {
  const maintainerPath = 'scripts/kit-release.mjs';
  const kit = await makeKit({
    '.claude/skills/to-prd/SKILL.md': '# to-prd\n',
    [maintainerPath]: 'release helper\n',
  });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, maintainerPath), 'consumer customization\n');
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files.find(({ path }) => path === maintainerPath).installRole = 'maintainer';
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);

    await init({ kitRoot: kit, consumerRoot: consumer });

    assert.equal(await readFile(join(consumer, maintainerPath), 'utf8'), 'consumer customization\n');
    const manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
    assert.equal(
      manifest.installed.find(({ path }) => path === maintainerPath).installRole,
      'maintainer',
    );
  } finally {
    await cleanup(kit, consumer);
  }
});

test('init never clobbers a pre-existing untracked file (unless force)', async () => {
  const kit = await makeKit({ '.claude/skills/to-prd/SKILL.md': '# from kit\n' });
  const consumer = await makeEmptyDir();
  try {
    const dest = join(consumer, '.claude/skills/to-prd/SKILL.md');
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, '# user already had this\n');

    const r1 = await init({ kitRoot: kit, consumerRoot: consumer });
    assert.equal(await readFile(dest, 'utf8'), '# user already had this\n', 'preserved');
    assert.ok(r1.skipped.includes('.claude/skills/to-prd/SKILL.md'));

    await init({ kitRoot: kit, consumerRoot: consumer, force: true });
    assert.equal(await readFile(dest, 'utf8'), '# from kit\n', 'force overwrites');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('init is idempotent: re-run leaves filled stubs untouched', async () => {
  const kit = await makeKit({ '.claude/skills/to-prd/SKILL.md': '# to-prd\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const stub = join(consumer, 'docs/agents/domain.md');
    await writeFile(stub, '<!-- setup-workflow: state=filled -->\nfilled content\n');
    await init({ kitRoot: kit, consumerRoot: consumer });
    assert.equal(firstLineState(await readFile(stub, 'utf8')), 'filled', 'not re-seeded');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('re-running init preserves consumer-owned files and manifest entries, including with force', async () => {
  const path = '.claude/skills/to-prd/SKILL.md';
  const kit = await makeKit({ [path]: '# from kit\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const manifestPath = join(consumer, CONSUMER_MANIFEST_NAME);
    const manifest = await readManifest(manifestPath);
    const ownedEntry = manifest.installed.find((entry) => entry.path === path);
    ownedEntry.origin = 'consumer';
    await writeManifest(manifestPath, manifest);
    await writeFile(join(consumer, path), '# consumer-owned bytes\n');

    for (const force of [false, true]) {
      await init({ kitRoot: kit, consumerRoot: consumer, force });

      assert.equal(
        await readFile(join(consumer, path), 'utf8'),
        '# consumer-owned bytes\n',
        `consumer-owned bytes survive init${force ? ' --force' : ''}`,
      );
      const after = await readManifest(manifestPath);
      assert.deepEqual(
        after.installed.find((entry) => entry.path === path),
        ownedEntry,
        `consumer-owned manifest entry survives init${force ? ' --force' : ''}`,
      );
    }
  } finally {
    await cleanup(kit, consumer);
  }
});

test('init and re-init preserve manifest extensions and establish readiness contract v1', async () => {
  const kit = await makeKit({
    '.claude/skills/to-prd/SKILL.md': '# to-prd\n',
    '.claude/skills/skill-manifest.json': JSON.stringify({
      schema_version: 1,
      readiness: {
        contractVersion: 1,
        capabilities: { prodTarget: {}, managedBoard: { allowNotApplicable: true } },
      },
      skills: {},
    }),
  });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const path = join(consumer, CONSUMER_MANIFEST_NAME);
    const manifest = await readManifest(path);
    assert.equal(manifest.readinessContractVersion, 1);
    assert.deepEqual(manifest.readinessDecisions, {});
    await writeManifest(path, {
      ...manifest,
      readinessDecisions: {
        prodTarget: 'pending', managedBoard: 'not-applicable', unknownCapability: 'pending',
      },
      consumerExtension: { keep: true },
    });

    await init({ kitRoot: kit, consumerRoot: consumer });
    const after = await readManifest(path);
    assert.deepEqual(after.readinessDecisions, {
      prodTarget: 'pending', managedBoard: 'not-applicable',
    });
    assert.deepEqual(after.consumerExtension, { keep: true });
  } finally {
    await cleanup(kit, consumer);
  }
});
