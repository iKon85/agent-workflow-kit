import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { init } from '../src/commands/init.mjs';
import { update } from '../src/commands/update.mjs';
import { makeKit, makeEmptyDir, cleanup } from './helpers.mjs';
import { PACKAGE_MANIFEST_NAME, readManifest, writeManifest } from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';

const exists = (p) => access(p).then(() => true, () => false);
const P = '.claude/skills/to-prd/SKILL.md';
const H = '.claude/hooks/my-hook.py';
const READINESS_MANIFEST = '.claude/skills/skill-manifest.json';

function releaseIdentities(version = '0.1.0', name = '@ikon85/agent-workflow-kit') {
  const identity = {
    name, version, tarballIntegrity: 'sha512-fixture', manifestSha256: 'fixture-manifest',
  };
  const installed = { name, version, manifestSha256: identity.manifestSha256 };
  return { installed, npm: { ...identity }, github: { ...identity } };
}

const verify = async () => {};

// re-write a kit file + its package-manifest hash to simulate an upstream change
async function bumpKit(kitRoot, path, content) {
  await writeFile(join(kitRoot, path), content);
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  pkg.files.find((f) => f.path === path).sha256 = sha256(content);
  await writeManifest(join(kitRoot, PACKAGE_MANIFEST_NAME), pkg);
}

async function setKitReadiness(kitRoot, manifest) {
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const path = join(kitRoot, READINESS_MANIFEST);
  await mkdir(join(kitRoot, '.claude/skills'), { recursive: true });
  await writeFile(path, content);
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  const entry = pkg.files.find(({ path: candidate }) => candidate === READINESS_MANIFEST);
  if (entry) entry.sha256 = sha256(content);
  else pkg.files.push({ path: READINESS_MANIFEST, kind: 'doc', sha256: sha256(content), mode: 0o644, origin: 'kit' });
  await writeManifest(join(kitRoot, PACKAGE_MANIFEST_NAME), pkg);
}

test('update transactionally adopts new safe stubs and reports behavior availability', async () => {
  const oldReadiness = {
    readiness: { contractVersion: 1, capabilities: {
      prodTarget: { evidence: { type: 'prod-section', paths: ['CLAUDE.md'] } },
    } },
    skills: { wrapup: { readiness: { optionalBlocks: { deployReport: 'prodTarget' } } } },
  };
  const nextReadiness = structuredClone(oldReadiness);
  nextReadiness.readiness.capabilities.orchestrateWaveRecipe = {
    evidence: {
      type: 'sentinel', paths: ['docs/agents/skills/orchestrate-wave.md'], allowLegacy: true,
    },
  };
  nextReadiness.skills['orchestrate-wave'] = {
    readiness: { optionalBlocks: { projectRecipe: 'orchestrateWaveRecipe' } },
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const stub = 'docs/agents/skills/orchestrate-wave.md';
  let decisionCalls = 0;
  try {
    await setKitReadiness(kit, oldReadiness);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await rm(join(consumer, stub), { force: true });
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const manifest = await readManifest(manifestPath);
    await writeManifest(manifestPath, {
      ...manifest, readinessDecisions: { prodTarget: 'pending' },
    });
    await setKitReadiness(kit, nextReadiness);

    const result = await update({
      kitRoot: kit, consumerRoot: consumer,
      releaseIdentities: releaseIdentities(), verify,
      decide: () => { decisionCalls += 1; return true; },
    });

    assert.equal(result.state, 'applied');
    assert.deepEqual(result.generated, [stub]);
    assert.match(await readFile(join(consumer, stub), 'utf8'), /state=stub/);
    assert.deepEqual(result.availability.newlyAvailable, ['orchestrate-wave']);
    assert.deepEqual(result.availability.newlyDegraded, ['orchestrate-wave.projectRecipe']);
    assert.deepEqual(result.availability.newlyBlocked, []);
    assert.deepEqual(result.availability.stillUnresolved, [
      'orchestrateWaveRecipe:invalid', 'prodTarget:pending',
    ]);
    const after = await readManifest(manifestPath);
    assert.deepEqual(after.readinessDecisions, { prodTarget: 'pending' });
    assert.equal(after.installed.find(({ path }) => path === stub)?.origin, 'consumer');
    assert.equal(decisionCalls, 0, 'headless package consent never answers readiness');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('dry-run previews readiness adoption without creating the candidate stub', async () => {
  const oldReadiness = { readiness: { contractVersion: 1, capabilities: {} }, skills: {} };
  const nextReadiness = {
    readiness: { contractVersion: 1, capabilities: {
      localCiRecipe: { evidence: {
        type: 'sentinel', paths: ['docs/agents/skills/local-ci.md'], allowLegacy: true,
      } },
    } },
    skills: { 'local-ci': { readiness: { required: ['localCiRecipe'] } } },
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const stub = 'docs/agents/skills/local-ci.md';
  try {
    await setKitReadiness(kit, oldReadiness);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await rm(join(consumer, stub), { force: true });
    await setKitReadiness(kit, nextReadiness);

    const result = await update({ kitRoot: kit, consumerRoot: consumer, dryRun: true });

    assert.equal(result.state, 'preview');
    assert.deepEqual(result.generated, [stub]);
    assert.deepEqual(result.availability.newlyBlocked, ['local-ci']);
    assert.deepEqual(result.availability.stillUnresolved, ['localCiRecipe:invalid']);
    assert.equal(await exists(join(consumer, stub)), false);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a generated-stub destination race fails in activation and preserves consumer state', async () => {
  const oldReadiness = { readiness: { contractVersion: 1, capabilities: {} }, skills: {} };
  const nextReadiness = {
    readiness: { contractVersion: 1, capabilities: {
      localCiRecipe: { evidence: {
        type: 'sentinel', paths: ['docs/agents/skills/local-ci.md'], allowLegacy: true,
      } },
    } },
    skills: { 'local-ci': { readiness: { required: ['localCiRecipe'] } } },
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const stub = 'docs/agents/skills/local-ci.md';
  try {
    await setKitReadiness(kit, oldReadiness);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await rm(join(consumer, stub), { force: true });
    await setKitReadiness(kit, nextReadiness);
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const manifestBefore = await readFile(manifestPath);

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(),
      verify: async () => { await writeFile(join(consumer, stub), 'late consumer evidence\n'); },
    });

    assert.equal(result.state, 'failed');
    assert.deepEqual(result.failure, { phase: 'activation', consumerState: 'unchanged' });
    assert.match(result.error, /consumer changed during verification/);
    assert.equal(await readFile(join(consumer, stub), 'utf8'), 'late consumer evidence\n');
    assert.deepEqual(await readFile(manifestPath), manifestBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a compatible update cannot make previously available skill core unavailable', async () => {
  const oldReadiness = {
    readiness: { contractVersion: 1, capabilities: {
      issueTracker: { evidence: {
        type: 'sentinel', paths: ['docs/agents/issue-tracker.md'], allowLegacy: true,
      } },
    } },
    skills: { 'to-prd': { readiness: { required: ['issueTracker'] } } },
  };
  const nextReadiness = structuredClone(oldReadiness);
  nextReadiness.readiness.capabilities.managedBoard = {
    evidence: { type: 'board-profile', paths: ['docs/agents/board-sync.md'] },
  };
  nextReadiness.skills['to-prd'].readiness.required.push('managedBoard');
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  let verified = false;
  try {
    await setKitReadiness(kit, oldReadiness);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, 'docs/agents/issue-tracker.md'), '# Legacy configured tracker\n');
    const manifestBefore = await readFile(join(consumer, 'agent-workflow-kit.json'));
    await setKitReadiness(kit, nextReadiness);

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(),
      verify: async () => { verified = true; },
    });

    assert.equal(result.state, 'failed');
    assert.deepEqual(result.failure, { phase: 'staging', consumerState: 'unchanged' });
    assert.match(result.error, /monotonic compatibility.*to-prd/);
    assert.deepEqual(result.availability.newlyBlocked, ['to-prd']);
    assert.equal(verified, false);
    assert.equal(await readFile(join(consumer, 'docs/agents/issue-tracker.md'), 'utf8'), '# Legacy configured tracker\n');
    assert.deepEqual(await readFile(join(consumer, 'agent-workflow-kit.json')), manifestBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('an interrupted readiness adoption resumes with its generated stub intact', async () => {
  const oldReadiness = { readiness: { contractVersion: 1, capabilities: {} }, skills: {} };
  const nextReadiness = {
    readiness: { contractVersion: 1, capabilities: {
      localCiRecipe: { evidence: {
        type: 'sentinel', paths: ['docs/agents/skills/local-ci.md'], allowLegacy: true,
      } },
    } },
    skills: { 'local-ci': { readiness: { required: ['localCiRecipe'] } } },
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const controller = new AbortController();
  const stub = 'docs/agents/skills/local-ci.md';
  try {
    await setKitReadiness(kit, oldReadiness);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await rm(join(consumer, stub), { force: true });
    await setKitReadiness(kit, nextReadiness);

    const interrupted = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
      signal: controller.signal,
      onState: (state) => { if (state === 'verifying') controller.abort(); },
    });
    assert.equal(interrupted.state, 'aborted');
    assert.deepEqual(interrupted.generated, [stub]);
    assert.equal(await exists(join(consumer, stub)), false);

    const resumed = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
      resumeFrom: interrupted.candidateRoot,
    });
    assert.equal(resumed.state, 'applied');
    assert.deepEqual(resumed.generated, [stub]);
    assert.match(await readFile(join(consumer, stub), 'utf8'), /state=stub/);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('update overwrites an unmodified file when upstream changed', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'v2\n');
    const r = await update({
      kitRoot: kit, consumerRoot: consumer, now: 'T', releaseIdentities: releaseIdentities(), verify,
    });
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v2\n');
    assert.ok(r.updated.includes(P));
    assert.deepEqual(r.history, ['checking', 'preview', 'staging', 'verifying', 'applied']);
    const again = await update({
      kitRoot: kit, consumerRoot: consumer, now: 'T2', releaseIdentities: releaseIdentities(), verify,
    });
    assert.equal(again.status, 'current');
    assert.deepEqual(again.unchanged, [P]);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('update rejects a mismatched release before staging or consumer mutation', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'v2\n');
    const before = await readFile(join(consumer, P));
    const identities = releaseIdentities();
    identities.github.manifestSha256 = 'different';

    await assert.rejects(
      update({ kitRoot: kit, consumerRoot: consumer, now: 'T', releaseIdentities: identities, verify }),
      /github manifestSha256 mismatch/,
    );
    await assert.rejects(
      update({
        kitRoot: kit,
        consumerRoot: consumer,
        now: 'T',
        releaseIdentities: releaseIdentities('0.1.0', 'agent-workflow-kit'),
        verify,
      }),
      /invalid release origin: agent-workflow-kit/,
    );
    assert.deepEqual(await readFile(join(consumer, P)), before);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('update keeps the installed tree byte-identical when candidate verification fails', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'v2\n');
    const fileBefore = await readFile(join(consumer, P));
    const manifestBefore = await readFile(join(consumer, 'agent-workflow-kit.json'));

    const r = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      now: 'T',
      releaseIdentities: releaseIdentities(),
      verify: async () => { throw new Error('fixture verify failed'); },
    });

    assert.equal(r.state, 'failed');
    assert.deepEqual(r.failure, { phase: 'verification', consumerState: 'unchanged' });
    assert.match(r.error, /fixture verify failed/);
    assert.deepEqual(await readFile(join(consumer, P)), fileBefore);
    assert.deepEqual(await readFile(join(consumer, 'agent-workflow-kit.json')), manifestBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('update stages and activates a newly added upstream file', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const added = '.agents/skills/kit-update/SKILL.md';
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    await writeFile(join(kit, added), 'new skill\n').catch(async () => {
      await mkdir(join(kit, '.agents/skills/kit-update'), { recursive: true });
      await writeFile(join(kit, added), 'new skill\n');
    });
    pkg.files.push({ path: added, kind: 'skill', sha256: sha256('new skill\n'), mode: 0o644, origin: 'kit' });
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);

    const r = await update({
      kitRoot: kit, consumerRoot: consumer, now: 'T', releaseIdentities: releaseIdentities(), verify,
    });
    assert.deepEqual(r.added, [added]);
    assert.equal(await readFile(join(consumer, added), 'utf8'), 'new skill\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('update removes an unmodified legacy file that becomes maintainer-only', async () => {
  const maintainerPath = 'scripts/kit-release.mjs';
  const kit = await makeKit({ [P]: 'v1\n', [maintainerPath]: 'release helper\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files.find(({ path }) => path === maintainerPath).installRole = 'maintainer';
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);

    const updated = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(),
      decide: () => true, verify,
    });

    assert.deepEqual(updated.deleted, [maintainerPath]);
    assert.equal(await exists(join(consumer, maintainerPath)), false);
    const manifest = await readManifest(join(consumer, 'agent-workflow-kit.json'));
    assert.equal(manifest.installRole, 'consumer');
    assert.ok(manifest.installed.every(({ installRole }) => installRole === 'consumer'));

    const again = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
    });
    assert.equal(again.status, 'current');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('update preserves an edited legacy maintainer file and records its role', async () => {
  const maintainerPath = 'scripts/kit-release.mjs';
  const kit = await makeKit({ [P]: 'v1\n', [maintainerPath]: 'release helper\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, maintainerPath), 'consumer customization\n');
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files.find(({ path }) => path === maintainerPath).installRole = 'maintainer';
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);

    const updated = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(),
      decide: () => true, verify,
    });

    assert.deepEqual(updated.keptDeleted, [maintainerPath]);
    assert.equal(await readFile(join(consumer, maintainerPath), 'utf8'), 'consumer customization\n');
    const manifest = await readManifest(join(consumer, 'agent-workflow-kit.json'));
    assert.equal(
      manifest.installed.find(({ path }) => path === maintainerPath).installRole,
      'maintainer',
    );
  } finally {
    await cleanup(kit, consumer);
  }
});

test('update preserves a local modification when upstream is unchanged', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, P), 'local-only edit\n');
    const r = await update({
      kitRoot: kit, consumerRoot: consumer, now: 'T', releaseIdentities: releaseIdentities(), verify,
    });
    assert.equal(r.status, 'current');
    assert.deepEqual(r.userModified, [P]);
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'local-only edit\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('an interrupted staged candidate is resumable without mutating the consumer early', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const controller = new AbortController();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'v2\n');
    const interrupted = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      now: 'T',
      releaseIdentities: releaseIdentities(),
      verify,
      signal: controller.signal,
      onState: (state) => { if (state === 'verifying') controller.abort(); },
    });
    assert.equal(interrupted.state, 'aborted');
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v1\n');
    assert.equal(await readFile(join(interrupted.candidateRoot, P), 'utf8'), 'v2\n');

    const resumed = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      now: 'T',
      releaseIdentities: releaseIdentities(),
      verify,
      resumeFrom: interrupted.candidateRoot,
    });
    assert.equal(resumed.state, 'applied');
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v2\n');
    assert.equal(await exists(interrupted.candidateRoot), false);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('an abort raised by verification prevents activation and retains the candidate', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const controller = new AbortController();
  let candidateRoot;
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'v2\n');
    const interrupted = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      signal: controller.signal,
      verify: async () => { controller.abort(); },
    });
    candidateRoot = interrupted.candidateRoot;
    assert.equal(interrupted.state, 'aborted');
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v1\n');
    assert.equal(await readFile(join(candidateRoot, P), 'utf8'), 'v2\n');
  } finally {
    await cleanup(kit, consumer);
    if (candidateRoot) await cleanup(candidateRoot);
  }
});

test('a candidate construction failure preserves the old installed bytes', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files[0].sha256 = sha256('missing upstream bytes\n');
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);
    await rm(join(kit, P));
    const before = await readFile(join(consumer, P));

    const r = await update({
      kitRoot: kit, consumerRoot: consumer, now: 'T', releaseIdentities: releaseIdentities(), verify,
    });
    assert.equal(r.state, 'failed');
    assert.deepEqual(await readFile(join(consumer, P)), before);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a candidate whose bytes do not match the package manifest is never activated', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    pkg.files[0].sha256 = sha256('claimed v2\n');
    await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);
    const before = await readFile(join(consumer, P));

    const r = await update({
      kitRoot: kit, consumerRoot: consumer, now: 'T', releaseIdentities: releaseIdentities(), verify,
    });
    assert.equal(r.state, 'failed');
    assert.match(r.error, /candidate hash mismatch/);
    assert.deepEqual(await readFile(join(consumer, P)), before);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a local edit made during candidate verification is never overwritten', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'v2\n');
    const r = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      now: 'T',
      releaseIdentities: releaseIdentities(),
      verify: async () => { await writeFile(join(consumer, P), 'late local edit\n'); },
    });
    assert.equal(r.state, 'failed');
    assert.match(r.error, /consumer changed during verification/);
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'late local edit\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a consumer manifest changed during verification is preserved byte-for-byte', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'v2\n');
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const concurrent = Buffer.from(JSON.stringify({
      ...await readManifest(manifestPath), concurrentConsumerField: 'keep-me',
    }) + '\n');
    const r = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async () => { await writeFile(manifestPath, concurrent); },
    });
    assert.equal(r.state, 'failed');
    assert.match(r.error, /consumer manifest changed during verification/);
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v1\n');
    assert.deepEqual(await readFile(manifestPath), concurrent);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('ordinary update preserves readiness decisions and unknown manifest extensions', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const manifest = await readManifest(manifestPath);
    await writeManifest(manifestPath, {
      ...manifest,
      readinessDecisions: { prodTarget: 'pending' },
      consumerExtension: { keep: true },
    });
    await bumpKit(kit, P, 'v2\n');

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
    });
    assert.equal(result.state, 'applied');
    const after = await readManifest(manifestPath);
    assert.deepEqual(after.readinessDecisions, { prodTarget: 'pending' });
    assert.deepEqual(after.consumerExtension, { keep: true });
  } finally {
    await cleanup(kit, consumer);
  }
});

test('update does NOT mutate or back up a user-edited file when it reports a conflict', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, P), 'user edit\n');       // user modifies
    await bumpKit(kit, P, 'v2\n');                           // upstream also changes
    const r = await update({
      kitRoot: kit, consumerRoot: consumer, now: 'T', releaseIdentities: releaseIdentities(), verify,
    });
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'user edit\n', 'kept user version');
    assert.ok(r.conflicts.find((c) => c.path === P), 'reported conflict');
    assert.equal(r.state, 'conflicted');
    assert.equal(r.report.conflicts, 1);
    assert.deepEqual(r.report.paths.conflicts, [P]);
    assert.match(r.report.recommendation, /manually/);
    assert.equal(await exists(join(consumer, P + '.T.bak')), false, 'consumer tree was not mutated');
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

    const noDelete = await update({
      kitRoot: kit, consumerRoot: consumer, now: 'T', decide: () => false,
      releaseIdentities: releaseIdentities(), verify,
    });
    assert.equal(await exists(join(consumer, P)), true, 'kept when decide=false');

    const r = await update({
      kitRoot: kit, consumerRoot: consumer, now: 'T', decide: () => true,
      releaseIdentities: releaseIdentities(), verify,
    });
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

    const r = await update({
      kitRoot: kit, consumerRoot: consumer, now: 'T', decide: () => true,
      releaseIdentities: releaseIdentities(), verify,
    });
    assert.equal(await exists(join(consumer, H)), true, 'hook survives because settings.json still references it');
    assert.ok(r.keptDeleted.includes(H));
    assert.equal(r.deleted.includes(H), false);
  } finally {
    await cleanup(kit, consumer);
  }
});
