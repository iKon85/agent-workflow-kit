import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod, readFile, readdir, rename, writeFile, access, lstat, mkdir, rm, symlink,
} from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { init } from '../src/commands/init.mjs';
import { renderUpdateFailure, update } from '../src/commands/update.mjs';
import {
  activateCandidate, materializeUpdateCandidate, validateCandidateManifestPath,
} from '../src/lib/updateCandidate.mjs';
import { makeKit, makeEmptyDir, cleanup } from './helpers.mjs';
import {
  PACKAGE_MANIFEST_NAME, filesForInstallRole, readManifest, writeManifest,
} from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { inspectProjectSkillExtension } from '../src/lib/projectSkillExtension.mjs';

const exists = (p) => access(p).then(() => true, () => false);
const P = '.claude/skills/to-prd/SKILL.md';
const Q = '.agents/skills/to-prd/SKILL.md';
const H = '.claude/hooks/my-hook.py';
const READINESS_MANIFEST = '.claude/skills/skill-manifest.json';
const PROJECT_SKILL_REGISTRY = 'docs/agents/skill-registry.json';

function releaseIdentities(version = '0.1.0', name = '@ikon85/agent-workflow-kit') {
  const identity = {
    name, version, tarballIntegrity: 'sha512-fixture', manifestSha256: 'fixture-manifest',
  };
  const installed = { name, version, manifestSha256: identity.manifestSha256 };
  return { installed, npm: { ...identity }, github: { ...identity } };
}

const verify = async () => {};

test('failed update output names its transaction phase and consumer state', () => {
  assert.equal(renderUpdateFailure({
    error: 'disk write failed',
    failure: { phase: 'activation', consumerState: 'rolled-back' },
  }), 'candidate update failed · phase: activation · consumerState: rolled-back · disk write failed');
});

// re-write a kit file + its package-manifest hash to simulate an upstream change
async function bumpKit(kitRoot, path, content) {
  await writeFile(join(kitRoot, path), content);
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  pkg.files.find((f) => f.path === path).sha256 = sha256(content);
  await writeManifest(join(kitRoot, PACKAGE_MANIFEST_NAME), pkg);
}

async function setKitReadiness(kitRoot, manifest) {
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  const skills = structuredClone(manifest.skills ?? {});
  for (const entry of pkg.files) {
    const match = /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(entry.path);
    if (match) skills[match[1]] ??= {};
  }
  for (const [name, declaration] of Object.entries(skills)) {
    skills[name] = {
      class: 'generic',
      publish: true,
      surfaces: ['claude'],
      provenance: 'own',
      ...declaration,
    };
    for (const surface of skills[name].surfaces) {
      const path = `.${surface === 'claude' ? 'claude' : 'agents'}/skills/${name}/SKILL.md`;
      if (pkg.files.some((entry) => entry.path === path)) continue;
      const body = `---\nname: ${name}\ndescription: Test fixture.\n---\n\n# ${name}\n`;
      await mkdir(join(kitRoot, path, '..'), { recursive: true });
      await writeFile(join(kitRoot, path), body);
      pkg.files.push({
        path, kind: 'skill', ownerSkill: name, surface,
        sha256: sha256(body), mode: 0o644, origin: 'kit',
      });
    }
  }
  const normalized = { schema_version: 1, ...manifest, skills };
  const content = `${JSON.stringify(normalized, null, 2)}\n`;
  const path = join(kitRoot, READINESS_MANIFEST);
  await mkdir(join(kitRoot, '.claude/skills'), { recursive: true });
  await writeFile(path, content);
  const entry = pkg.files.find(({ path: candidate }) => candidate === READINESS_MANIFEST);
  if (entry) entry.sha256 = sha256(content);
  else pkg.files.push({ path: READINESS_MANIFEST, kind: 'doc', sha256: sha256(content), mode: 0o644, origin: 'kit' });
  await writeManifest(join(kitRoot, PACKAGE_MANIFEST_NAME), pkg);
}

async function candidateFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await candidateFiles(root, path));
    else files.push(path);
  }
  return files.sort();
}

async function candidateSnapshot(root) {
  return Object.fromEntries(await Promise.all((await candidateFiles(root)).map(async (path) => [
    path, sha256(await readFile(join(root, path))),
  ])));
}

test('canonical manifest paths remain valid materializer inputs under Windows path semantics', () => {
  assert.equal(
    validateCandidateManifestPath(P, win32),
    '.claude\\skills\\to-prd\\SKILL.md',
  );
  assert.throws(
    () => validateCandidateManifestPath('../outside.md', win32),
    /unsafe candidate manifest path/,
  );
  assert.throws(
    () => validateCandidateManifestPath('.claude\\skills\\escape.md', win32),
    /unsafe candidate manifest path/,
  );
});

test('staged candidate contains the complete manifest state and no unrelated Consumer paths', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, 'package.json'), '{"scripts":{"test":"exit 0"}}\n');
    for (const path of [
      'src/application.mjs', 'dist/output.js', 'node_modules/package/index.js',
      '.worktrees/feature/src/branch.mjs', 'notes/unknown.txt',
    ]) {
      await mkdir(join(consumer, path, '..'), { recursive: true });
      await writeFile(join(consumer, path), `${path}\n`);
    }
    await bumpKit(kit, P, 'v2\n');
    let staged;

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(),
      verify: async (candidateRoot) => { staged = await candidateFiles(candidateRoot); },
    });

    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    assert.equal(result.state, 'applied', result.error);
    assert.deepEqual(
      staged,
      [
        ...pkg.files.map(({ path }) => path),
        'agent-workflow-kit.json',
        'package.json',
      ].sort(),
    );
  } finally {
    await cleanup(kit, consumer);
  }
});

test('active worktrees cannot change or be read into the staged candidate', async () => {
  const staged = [];
  for (const hasWorktree of [false, true]) {
    const kit = await makeKit({ [P]: 'v1\n' });
    const consumer = await makeEmptyDir();
    const branchFile = join(consumer, '.worktrees/feature/src/branch.mjs');
    try {
      await init({ kitRoot: kit, consumerRoot: consumer });
      await writeFile(join(consumer, 'package.json'), '{"scripts":{"test":"exit 0"}}\n');
      if (hasWorktree) {
        await mkdir(join(consumer, '.worktrees/feature/src'), { recursive: true });
        await writeFile(branchFile, 'must not be read\n', { mode: 0o000 });
      }
      await bumpKit(kit, P, 'v2\n');

      const result = await update({
        kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(),
        onState: async (state) => {
          if (hasWorktree && state === 'staging') {
            await chmod(branchFile, 0o600);
            await writeFile(branchFile, 'concurrent worktree mutation\n');
            await chmod(branchFile, 0o000);
          }
        },
        verify: async (candidateRoot) => { staged.push(await candidateSnapshot(candidateRoot)); },
      });

      assert.equal(result.state, 'applied');
    } finally {
      if (hasWorktree && await exists(branchFile)) await chmod(branchFile, 0o600);
      await cleanup(kit, consumer);
    }
  }
  assert.deepEqual(staged[1], staged[0]);
  assert.equal(Object.keys(staged[1]).some((path) => path.startsWith('.worktrees/')), false);
});

test('candidate ledger covers the release-manifest denominator plus the Project registry', async () => {
  const kit = process.cwd();
  const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
  const packagePaths = filesForInstallRole(pkg).map(({ path }) => path).sort();
  const expected = [...packagePaths, PROJECT_SKILL_REGISTRY].sort();
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const manifest = await readManifest(manifestPath);
    await writeManifest(manifestPath, { ...manifest, installRole: 'legacy' });
    let stagedInstalled;

    const result = await update({
      kitRoot: kit, consumerRoot: consumer,
      releaseIdentities: releaseIdentities(pkg.kitVersion),
      verify: async (candidateRoot) => {
        const candidate = await readManifest(join(candidateRoot, 'agent-workflow-kit.json'));
        stagedInstalled = candidate.installed.map(({ path }) => path).sort();
        for (const path of packagePaths) {
          assert.equal(await exists(join(candidateRoot, path)), true, path);
        }
      },
    });

    assert.equal(result.state, 'applied', result.error);
    assert.equal(stagedInstalled.length, expected.length);
    assert.deepEqual(stagedInstalled, expected);
  } finally {
    await cleanup(consumer);
  }
});

test('unsafe managed input fails staging without changing the Consumer', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const external = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(external, 'outside.md'), 'v1\n');
    await rm(join(consumer, P));
    await symlink(join(external, 'outside.md'), join(consumer, P));
    await bumpKit(kit, P, 'v2\n');
    const manifestBefore = await readFile(join(consumer, 'agent-workflow-kit.json'));

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
    });

    assert.equal(result.state, 'failed');
    assert.deepEqual(result.failure, { phase: 'staging', consumerState: 'unchanged' });
    assert.match(result.error, /unsafe consumer path/);
    assert.equal((await lstat(join(consumer, P))).isSymbolicLink(), true);
    assert.deepEqual(await readFile(join(consumer, 'agent-workflow-kit.json')), manifestBefore);
  } finally {
    await cleanup(kit, consumer, external);
  }
});

test('candidate materialization rejects an intermediate-directory symlink escape', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const external = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await mkdir(join(external, 'skills/to-prd'), { recursive: true });
    await writeFile(join(external, 'skills/to-prd/SKILL.md'), 'v1\n');
    await rm(join(consumer, '.claude'), { recursive: true });
    await symlink(external, join(consumer, '.claude'), 'dir');
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));

    await assert.rejects(
      materializeUpdateCandidate({
        consumerRoot: consumer, pkg,
        priorReadinessManifest: null, nextReadinessManifest: null,
      }),
      new RegExp(`unsafe consumer path.*${P.replaceAll('.', '\\.')}`),
    );
  } finally {
    await cleanup(kit, consumer, external);
  }
});

test('candidate materialization rejects a same-bytes leaf replacement after validation', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  let candidateRoot;
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
    let swapped = false;

    await assert.rejects(async () => {
      candidateRoot = await materializeUpdateCandidate({
        consumerRoot: consumer, pkg,
        priorReadinessManifest: null, nextReadinessManifest: null,
        afterInputValidation: async (path) => {
          if (path !== P || swapped) return;
          swapped = true;
          const replacement = join(consumer, '.replacement');
          await writeFile(replacement, 'v1\n');
          await rename(replacement, join(consumer, P));
        },
      });
    }, new RegExp(`consumer input changed while staging: ${P.replaceAll('.', '\\.')}`));
    assert.equal(swapped, true);
  } finally {
    await cleanup(kit, consumer);
    if (candidateRoot) await cleanup(candidateRoot);
  }
});

test('ledger metadata is preserved but only manifest-declared bytes enter the candidate', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const external = await makeEmptyDir();
  let candidateRoot;
  const forbidden = '.worktrees/poison/secret.md';
  const consumerOwned = 'docs/consumer-owned.md';
  const legacyKit = 'docs/legacy-kit.md';
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await mkdir(join(consumer, 'docs'), { recursive: true });
    await writeFile(join(consumer, consumerOwned), 'consumer-owned\n');
    await writeFile(join(consumer, legacyKit), 'legacy-kit\n');
    await mkdir(join(external, 'poison'), { recursive: true });
    await writeFile(join(external, 'poison/secret.md'), 'must not be read\n');
    await symlink(external, join(consumer, '.worktrees'), 'dir');
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const manifest = await readManifest(manifestPath);
    manifest.installed.push(
      {
        path: forbidden, kind: 'doc', installedSha256: sha256('must not be read\n'),
        origin: 'kit', installRole: 'consumer',
      },
      {
        path: consumerOwned, kind: 'doc', installedSha256: sha256('consumer-owned\n'),
        origin: 'consumer', installRole: 'consumer',
      },
      {
        path: legacyKit, kind: 'doc', installedSha256: sha256('legacy-kit\n'),
        origin: 'kit', installRole: 'consumer',
      },
    );
    await writeManifest(manifestPath, manifest);
    const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));

    candidateRoot = await materializeUpdateCandidate({
      consumerRoot: consumer, pkg,
      priorReadinessManifest: null, nextReadinessManifest: null,
    });

    assert.equal(await readFile(join(candidateRoot, P), 'utf8'), 'v1\n');
    assert.equal(await exists(join(candidateRoot, forbidden)), false);
    assert.equal(await exists(join(candidateRoot, consumerOwned)), false);
    assert.equal(await exists(join(candidateRoot, legacyKit)), false);
    const candidateManifest = await readManifest(join(candidateRoot, 'agent-workflow-kit.json'));
    assert.equal(
      candidateManifest.installed.find(({ path }) => path === consumerOwned)?.origin,
      'consumer',
    );
    assert.equal(
      candidateManifest.installed.find(({ path }) => path === legacyKit)?.origin,
      'kit',
    );
  } finally {
    await cleanup(kit, consumer, external);
    if (candidateRoot) await cleanup(candidateRoot);
  }
});

test('declared readiness runbooks are the only transitive project inputs staged', async () => {
  const readiness = {
    readiness: { contractVersion: 1, capabilities: {
      securityAuditRunbook: {
        evidence: {
          type: 'runbook-reference', paths: ['docs/agents/skills/security-audit.md'],
          allowLegacy: true,
        },
      },
    } },
    skills: {},
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const runbook = 'docs/security/runbook.md';
  try {
    await setKitReadiness(kit, readiness);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(
      join(consumer, 'docs/agents/skills/security-audit.md'),
      `Use the project runbook at \`${runbook}\`.\n`,
    );
    await mkdir(join(consumer, 'docs/security'), { recursive: true });
    await writeFile(join(consumer, runbook), '# Project security procedure\n');
    await writeFile(join(consumer, 'docs/security/unrelated.md'), '# Do not stage\n');
    await bumpKit(kit, P, 'v2\n');

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(),
      verify: async (candidateRoot) => {
        assert.equal(
          await readFile(join(candidateRoot, runbook), 'utf8'),
          '# Project security procedure\n',
        );
        assert.equal(await exists(join(candidateRoot, 'docs/security/unrelated.md')), false);
      },
    });

    assert.equal(result.state, 'applied');
  } finally {
    await cleanup(kit, consumer);
  }
});

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

test('update mirrors one existing Prod section across Claude and Codex surfaces idempotently', async () => {
  const readiness = {
    readiness: { contractVersion: 1, capabilities: {
      prodTarget: { evidence: { type: 'prod-section', paths: ['CLAUDE.md', 'AGENTS.md'] } },
    } },
    skills: { wrapup: { readiness: { optionalBlocks: { deployReport: 'prodTarget' } } } },
  };
  for (const [source, destination, destinationExists] of [
    ['CLAUDE.md', 'AGENTS.md', false],
    ['AGENTS.md', 'CLAUDE.md', true],
  ]) {
    const kit = await makeKit({ [P]: 'v1\n' });
    const consumer = await makeEmptyDir();
    const prod = 'Deploy through the release workflow.\nLive: https://example.test.';
    try {
      await setKitReadiness(kit, readiness);
      await init({ kitRoot: kit, consumerRoot: consumer });
      await writeFile(join(consumer, source), `# ${source}\n\n## Prod\n\n${prod}\n`);
      if (destinationExists) await writeFile(join(consumer, destination), `# ${destination}\n`);

      const preview = await update({ kitRoot: kit, consumerRoot: consumer, dryRun: true });
      assert.deepEqual(preview.migrated, [destination]);
      if (destinationExists) {
        assert.doesNotMatch(await readFile(join(consumer, destination), 'utf8'), /## Prod/);
      } else {
        assert.equal(await exists(join(consumer, destination)), false);
      }

      const result = await update({
        kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
      });
      assert.equal(result.state, 'applied');
      assert.deepEqual(result.migrated, [destination]);
      assert.match(await readFile(join(consumer, destination), 'utf8'),
        new RegExp(`## Prod\\n\\n${prod.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`));

      const second = await update({
        kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
      });
      assert.equal(second.status, 'current');
      assert.deepEqual(second.migrated, []);
    } finally {
      await cleanup(kit, consumer);
    }
  }
});

test('update refuses divergent Prod sections without touching consumer files', async () => {
  const readiness = {
    readiness: { contractVersion: 1, capabilities: {
      prodTarget: { evidence: { type: 'prod-section', paths: ['CLAUDE.md', 'AGENTS.md'] } },
    } },
    skills: { wrapup: { readiness: { optionalBlocks: { deployReport: 'prodTarget' } } } },
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await setKitReadiness(kit, readiness);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, 'CLAUDE.md'), '# Claude\n\n## Prod\n\nTarget A.\n');
    await writeFile(join(consumer, 'AGENTS.md'), '# Agents\n\n## Prod\n\nTarget B.\n');
    const beforeClaude = await readFile(join(consumer, 'CLAUDE.md'));
    const beforeAgents = await readFile(join(consumer, 'AGENTS.md'));

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
    });

    assert.equal(result.state, 'conflicted');
    assert.deepEqual(result.migrationConflicts, ['CLAUDE.md', 'AGENTS.md']);
    assert.equal(result.report.conflicts, 2);
    assert.deepEqual(result.report.paths.conflicts, ['CLAUDE.md', 'AGENTS.md']);
    assert.match(result.report.recommendation, /Prod sections differ/);
    assert.deepEqual(await readFile(join(consumer, 'CLAUDE.md')), beforeClaude);
    assert.deepEqual(await readFile(join(consumer, 'AGENTS.md')), beforeAgents);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a Prod migration destination race fails without overwriting the late consumer edit', async () => {
  const readiness = {
    readiness: { contractVersion: 1, capabilities: {
      prodTarget: { evidence: { type: 'prod-section', paths: ['CLAUDE.md', 'AGENTS.md'] } },
    } },
    skills: { wrapup: { readiness: { optionalBlocks: { deployReport: 'prodTarget' } } } },
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await setKitReadiness(kit, readiness);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, 'CLAUDE.md'), '# Claude\n\n## Prod\n\nTarget A.\n');
    await writeFile(join(consumer, 'AGENTS.md'), '# Agents\n');
    const lateEdit = '# Agents\n\nConsumer changed this during verification.\n';

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(),
      verify: async () => { await writeFile(join(consumer, 'AGENTS.md'), lateEdit); },
    });

    assert.equal(result.state, 'failed');
    assert.deepEqual(result.failure, { phase: 'activation', consumerState: 'unchanged' });
    assert.match(result.error, /consumer changed during verification: AGENTS\.md/);
    assert.equal(await readFile(join(consumer, 'AGENTS.md'), 'utf8'), lateEdit);
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

test('a local edit after the rollback snapshot is revalidated before activation', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'v2\n');
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const manifestBefore = await readFile(manifestPath);

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
      activate: (options) => activateCandidate({
        ...options,
        afterSnapshot: async () => {
          await writeFile(join(consumer, P), 'late local edit after snapshot\n');
        },
      }),
    });

    assert.equal(result.state, 'failed');
    assert.deepEqual(result.failure, { phase: 'activation', consumerState: 'unchanged' });
    assert.match(result.error, /consumer changed during verification/);
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'late local edit after snapshot\n');
    assert.deepEqual(await readFile(manifestPath), manifestBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a later managed edit is preserved after an earlier managed path was activated', async () => {
  const kit = await makeKit({ [P]: 'p-v1\n', [Q]: 'q-v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'p-v2\n');
    await bumpKit(kit, Q, 'q-v2\n');
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const manifestBefore = await readFile(manifestPath);
    const managed = new Set([P, Q]);
    let firstPath;
    let laterPath;
    let partialWriteObserved = false;

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
      activate: (options) => activateCandidate({
        ...options,
        beforeTargetRevalidation: async (path) => {
          if (!managed.has(path)) return;
          if (!firstPath) {
            firstPath = path;
            return;
          }
          if (laterPath) return;
          laterPath = path;
          partialWriteObserved = (
            await readFile(join(consumer, firstPath), 'utf8')
          ).endsWith('-v2\n');
          await writeFile(join(consumer, laterPath), 'external late edit\n');
        },
      }),
    });

    assert.equal(partialWriteObserved, true);
    assert.equal(result.state, 'failed');
    assert.deepEqual(result.failure, { phase: 'activation', consumerState: 'rolled-back' });
    assert.match(result.error, new RegExp(`consumer changed during activation: ${laterPath}`));
    assert.equal(await readFile(join(consumer, firstPath), 'utf8'), `${firstPath === P ? 'p' : 'q'}-v1\n`);
    assert.equal(await readFile(join(consumer, laterPath), 'utf8'), 'external late edit\n');
    assert.deepEqual(await readFile(manifestPath), manifestBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('rollback preserves an external edit to an already activated path', async () => {
  const kit = await makeKit({ [P]: 'p-v1\n', [Q]: 'q-v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'p-v2\n');
    await bumpKit(kit, Q, 'q-v2\n');
    const managed = new Set([P, Q]);
    let firstPath;
    let laterPath;

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
      activate: (options) => activateCandidate({
        ...options,
        beforeTargetRevalidation: async (path) => {
          if (!managed.has(path)) return;
          if (!firstPath) {
            firstPath = path;
            return;
          }
          if (laterPath) return;
          laterPath = path;
          await writeFile(join(consumer, firstPath), 'external edit after activation\n');
          await writeFile(join(consumer, laterPath), 'external edit before activation\n');
        },
      }),
    });

    assert.equal(result.state, 'failed');
    assert.deepEqual(result.failure, {
      phase: 'activation', consumerState: 'rollback-conflicted',
    });
    assert.match(result.error, /rollback preserved concurrent edits/);
    assert.equal(
      await readFile(join(consumer, firstPath), 'utf8'),
      'external edit after activation\n',
    );
    assert.equal(
      await readFile(join(consumer, laterPath), 'utf8'),
      'external edit before activation\n',
    );
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a first-target edit fails activation with unchanged consumer state', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'v2\n');
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const manifestBefore = await readFile(manifestPath);

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
      activate: (options) => activateCandidate({
        ...options,
        beforeTargetRevalidation: async (path) => {
          if (path === P) await writeFile(join(consumer, P), 'external first-target edit\n');
        },
      }),
    });

    assert.equal(result.state, 'failed');
    assert.deepEqual(result.failure, { phase: 'activation', consumerState: 'unchanged' });
    assert.match(result.error, new RegExp(`consumer changed during activation: ${P.replaceAll('.', '\\.')}`));
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'external first-target edit\n');
    assert.deepEqual(await readFile(manifestPath), manifestBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a late ledger edit is preserved while earlier activation writes roll back', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, P, 'v2\n');
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const externalLedger = '{"external":"late ledger edit"}\n';
    let partialWriteObserved = false;

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
      activate: (options) => activateCandidate({
        ...options,
        beforeTargetRevalidation: async (path) => {
          if (path !== 'agent-workflow-kit.json') return;
          partialWriteObserved = await readFile(join(consumer, P), 'utf8') === 'v2\n';
          await writeFile(manifestPath, externalLedger);
        },
      }),
    });

    assert.equal(partialWriteObserved, true);
    assert.equal(result.state, 'failed');
    assert.deepEqual(result.failure, { phase: 'activation', consumerState: 'rolled-back' });
    assert.match(result.error, /consumer changed during activation: agent-workflow-kit\.json/);
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v1\n');
    assert.equal(await readFile(manifestPath, 'utf8'), externalLedger);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('mid-activation failure rolls back generated and kit-owned bytes without clobbering legacy evidence', async () => {
  const oldReadiness = { readiness: { contractVersion: 1, capabilities: {} }, skills: {} };
  const nextReadiness = {
    readiness: { contractVersion: 1, capabilities: {
      localCiRecipe: { evidence: {
        type: 'sentinel', paths: ['docs/agents/skills/local-ci.md'], allowLegacy: true,
      } },
      orchestrateWaveRecipe: { evidence: {
        type: 'sentinel', paths: ['docs/agents/skills/orchestrate-wave.md'], allowLegacy: true,
      } },
    } },
    skills: {
      'local-ci': { readiness: { required: ['localCiRecipe'] } },
      'orchestrate-wave': { readiness: { optionalBlocks: { projectRecipe: 'orchestrateWaveRecipe' } } },
    },
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const generated = 'docs/agents/skills/local-ci.md';
  const legacy = 'docs/agents/skills/orchestrate-wave.md';
  try {
    await setKitReadiness(kit, oldReadiness);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await rm(join(consumer, generated), { force: true });
    await writeFile(join(consumer, legacy), '# Legacy project recipe\n');
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const manifestBefore = await readFile(manifestPath);
    const readinessBefore = await readFile(join(consumer, READINESS_MANIFEST));
    await setKitReadiness(kit, nextReadiness);
    let copiedBeforeFault = false;

    const result = await update({
      kitRoot: kit, consumerRoot: consumer, releaseIdentities: releaseIdentities(), verify,
      activate: (options) => activateCandidate({
        ...options,
        afterGenerated: async () => {
          copiedBeforeFault = await exists(join(consumer, generated));
          throw new Error('injected activation failure');
        },
      }),
    });

    assert.equal(copiedBeforeFault, true);
    assert.equal(result.state, 'failed');
    assert.deepEqual(result.failure, { phase: 'activation', consumerState: 'rolled-back' });
    assert.match(result.error, /injected activation failure/);
    assert.equal(await exists(join(consumer, generated)), false);
    assert.equal(await readFile(join(consumer, legacy), 'utf8'), '# Legacy project recipe\n');
    assert.deepEqual(await readFile(join(consumer, READINESS_MANIFEST)), readinessBefore);
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
    assert.deepEqual(result.failure, { phase: 'verification', consumerState: 'unchanged' });
    assert.match(result.error, /monotonic compatibility.*to-prd/);
    assert.deepEqual(result.availability.newlyBlocked, ['to-prd']);
    assert.equal(verified, false);
    assert.equal(await readFile(join(consumer, 'docs/agents/issue-tracker.md'), 'utf8'), '# Legacy configured tracker\n');
    assert.deepEqual(await readFile(join(consumer, 'agent-workflow-kit.json')), manifestBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a legacy mixed skill registry migrates to current Kit Core plus a durable Project registry', async () => {
  const oldCore = {
    readiness: { contractVersion: 1, capabilities: {} },
    skills: { 'to-prd': {} },
  };
  const nextCore = {
    readiness: { contractVersion: 1, capabilities: {} },
    skills: { 'to-prd': {}, 'kit-update': {} },
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await setKitReadiness(kit, oldCore);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await rm(join(consumer, PROJECT_SKILL_REGISTRY), { force: true });

    const mixed = JSON.parse(await readFile(join(consumer, READINESS_MANIFEST), 'utf8'));
    mixed.skills['to-prd'].note = 'Project-specific provenance note.';
    mixed.skills['project-local'] = {
      class: 'project-private',
      publish: false,
      surfaces: ['claude', 'codex'],
    };
    await writeFile(
      join(consumer, READINESS_MANIFEST),
      `${JSON.stringify(mixed, null, 2)}\n`,
    );
    const ledgerPath = join(consumer, 'agent-workflow-kit.json');
    const ledger = await readManifest(ledgerPath);
    ledger.installed = ledger.installed.filter(
      ({ path }) => path !== PROJECT_SKILL_REGISTRY,
    );
    ledger.installed.find(({ path }) => path === READINESS_MANIFEST).origin = 'consumer';
    await writeManifest(ledgerPath, ledger);

    await setKitReadiness(kit, nextCore);
    const expectedCore = await readFile(join(kit, READINESS_MANIFEST), 'utf8');
    const first = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify,
    });

    assert.equal(first.state, 'applied', first.error);
    assert.deepEqual(await readFile(join(consumer, READINESS_MANIFEST), 'utf8'), expectedCore);
    assert.deepEqual(
      JSON.parse(await readFile(join(consumer, PROJECT_SKILL_REGISTRY), 'utf8')),
      {
        schemaVersion: 1,
        coreSchemaVersion: 1,
        skills: {
          'project-local': mixed.skills['project-local'],
        },
        annotations: {
          'to-prd': { note: 'Project-specific provenance note.' },
        },
      },
    );
    const migratedLedger = await readManifest(ledgerPath);
    assert.equal(
      migratedLedger.installed.find(({ path }) => path === READINESS_MANIFEST).origin,
      'kit',
    );
    assert.equal(
      migratedLedger.installed.find(({ path }) => path === PROJECT_SKILL_REGISTRY).origin,
      'consumer',
    );

    const second = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify,
    });
    assert.equal(second.state, 'applied');
    assert.equal(second.status, 'current');
    assert.deepEqual(second.migrated, []);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a clean legacy Consumer adopts an empty Project registry without changing Kit Core ownership', async () => {
  const oldCore = {
    readiness: { contractVersion: 1, capabilities: {} },
    skills: { 'to-prd': {} },
  };
  const nextCore = {
    readiness: { contractVersion: 1, capabilities: {} },
    skills: { 'to-prd': {}, 'kit-update': {} },
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await setKitReadiness(kit, oldCore);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await rm(join(consumer, PROJECT_SKILL_REGISTRY), { force: true });
    const ledgerPath = join(consumer, 'agent-workflow-kit.json');
    const ledger = await readManifest(ledgerPath);
    ledger.installed = ledger.installed.filter(
      ({ path }) => path !== PROJECT_SKILL_REGISTRY,
    );
    await writeManifest(ledgerPath, ledger);

    await setKitReadiness(kit, nextCore);
    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify,
    });

    assert.equal(result.state, 'applied', result.error);
    assert.deepEqual(
      JSON.parse(await readFile(join(consumer, PROJECT_SKILL_REGISTRY), 'utf8')),
      {
        schemaVersion: 1,
        coreSchemaVersion: 1,
        skills: {},
        annotations: {},
      },
    );
    const after = await readManifest(ledgerPath);
    assert.equal(
      after.installed.find(({ path }) => path === READINESS_MANIFEST).origin,
      'kit',
    );
    assert.equal(
      after.installed.find(({ path }) => path === PROJECT_SKILL_REGISTRY).origin,
      'consumer',
    );
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a modified legacy Core declaration remains unchanged and blocks semantic migration', async () => {
  const oldCore = {
    readiness: { contractVersion: 1, capabilities: {} },
    skills: { 'to-prd': {} },
  };
  const nextCore = {
    readiness: { contractVersion: 1, capabilities: {} },
    skills: { 'to-prd': {}, 'kit-update': {} },
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await setKitReadiness(kit, oldCore);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await rm(join(consumer, PROJECT_SKILL_REGISTRY), { force: true });
    const mixedPath = join(consumer, READINESS_MANIFEST);
    const mixed = JSON.parse(await readFile(mixedPath, 'utf8'));
    mixed.skills['to-prd'].class = 'adapter';
    await writeFile(mixedPath, `${JSON.stringify(mixed, null, 2)}\n`);
    const ledgerPath = join(consumer, 'agent-workflow-kit.json');
    const ledger = await readManifest(ledgerPath);
    ledger.installed = ledger.installed.filter(
      ({ path }) => path !== PROJECT_SKILL_REGISTRY,
    );
    ledger.installed.find(({ path }) => path === READINESS_MANIFEST).origin = 'consumer';
    await writeManifest(ledgerPath, ledger);
    const bytesBefore = await readFile(mixedPath);
    const ledgerBefore = await readFile(ledgerPath);

    await setKitReadiness(kit, nextCore);
    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      decide: () => true,
      verify,
    });

    assert.equal(result.state, 'conflicted');
    assert.match(result.migrationConflicts.join('\n'), /ambiguous Kit Core changes: to-prd/);
    assert.deepEqual(await readFile(mixedPath), bytesBefore);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
    assert.equal(await exists(join(consumer, PROJECT_SKILL_REGISTRY)), false);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a legacy mixed Core plus an existing Project registry fails closed without overwriting either', async () => {
  const oldCore = {
    readiness: { contractVersion: 1, capabilities: {} },
    skills: { 'to-prd': {} },
  };
  const nextCore = {
    readiness: { contractVersion: 1, capabilities: {} },
    skills: { 'to-prd': {}, 'kit-update': {} },
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await setKitReadiness(kit, oldCore);
    await init({ kitRoot: kit, consumerRoot: consumer });
    const corePath = join(consumer, READINESS_MANIFEST);
    const registryPath = join(consumer, PROJECT_SKILL_REGISTRY);
    const ledgerPath = join(consumer, 'agent-workflow-kit.json');
    const ledger = await readManifest(ledgerPath);
    ledger.installed.find(({ path }) => path === READINESS_MANIFEST).origin = 'consumer';
    await writeManifest(ledgerPath, ledger);
    const coreBefore = await readFile(corePath);
    const registryBefore = await readFile(registryPath);
    const ledgerBefore = await readFile(ledgerPath);

    await setKitReadiness(kit, nextCore);
    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify,
    });

    assert.equal(result.state, 'conflicted');
    assert.match(result.migrationConflicts.join('\n'), /already has a Project registry/);
    assert.deepEqual(await readFile(corePath), coreBefore);
    assert.deepEqual(await readFile(registryPath), registryBefore);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('an unknown Project registry schema fails closed before a Core update', async () => {
  const oldCore = {
    readiness: { contractVersion: 1, capabilities: {} },
    skills: { 'to-prd': {} },
  };
  const nextCore = {
    readiness: { contractVersion: 1, capabilities: {} },
    skills: { 'to-prd': {}, 'kit-update': {} },
  };
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  try {
    await setKitReadiness(kit, oldCore);
    await init({ kitRoot: kit, consumerRoot: consumer });
    const registryPath = join(consumer, PROJECT_SKILL_REGISTRY);
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.schemaVersion = 99;
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const corePath = join(consumer, READINESS_MANIFEST);
    const ledgerPath = join(consumer, 'agent-workflow-kit.json');
    const coreBefore = await readFile(corePath);
    const registryBefore = await readFile(registryPath);
    const ledgerBefore = await readFile(ledgerPath);

    await setKitReadiness(kit, nextCore);
    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify,
    });

    assert.equal(result.state, 'failed');
    assert.match(result.error, /Project skill registry has an unsupported schema/);
    assert.deepEqual(await readFile(corePath), coreBefore);
    assert.deepEqual(await readFile(registryPath), registryBefore);
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a Project skill extension survives a Core update and composes through both agent surfaces', async () => {
  const sourceRoot = process.cwd();
  const claudePath = '.claude/skills/tdd/SKILL.md';
  const codexPath = '.agents/skills/tdd/SKILL.md';
  const shipped = {};
  for (const path of [
    claudePath,
    codexPath,
    'scripts/project-skill-extension.mjs',
    'src/lib/projectSkillExtension.mjs',
    'src/lib/sentinel.mjs',
  ]) {
    shipped[path] = await readFile(join(sourceRoot, path));
  }
  const kit = await makeKit(shipped);
  const consumer = await makeEmptyDir();
  try {
    await setKitReadiness(kit, {
      readiness: { contractVersion: 1, capabilities: {} },
      skills: {
        tdd: {
          class: 'generic',
          publish: true,
          surfaces: ['claude', 'codex'],
        },
      },
    });
    await init({ kitRoot: kit, consumerRoot: consumer });
    const extensionPath = join(consumer, 'docs/agents/skills/tdd.md');
    const extension = Buffer.from(
      '<!-- agent-workflow-kit: project-extension/v1; skill=tdd -->\n' +
      '# Project policy\n\nRun the Consumer integration tracer.\n',
    );
    await mkdir(join(extensionPath, '..'), { recursive: true });
    await writeFile(extensionPath, extension);
    await init({ kitRoot: kit, consumerRoot: consumer, force: true });
    assert.deepEqual(await readFile(extensionPath), extension);

    for (const path of [claudePath, codexPath]) {
      const next = Buffer.concat([await readFile(join(kit, path)), Buffer.from('\nCore v2.\n')]);
      await bumpKit(kit, path, next);
    }
    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify,
    });

    assert.equal(result.state, 'applied', result.error);
    assert.deepEqual(await readFile(extensionPath), extension);
    assert.deepEqual(await inspectProjectSkillExtension({ root: consumer, skill: 'tdd' }), {
      state: 'active',
      schemaVersion: 1,
      path: 'docs/agents/skills/tdd.md',
    });
    for (const path of [claudePath, codexPath]) {
      assert.match(
        await readFile(join(consumer, path), 'utf8'),
        /project-skill-extension\.mjs inspect --skill tdd --json/,
      );
    }
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
    assert.match(r.error, /candidate invariant artifact: hash mismatch/);
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
