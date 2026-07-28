import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../src/commands/init.mjs';
import { update } from '../src/commands/update.mjs';
import { activateCandidate } from '../src/lib/updateCandidate.mjs';
import {
  ROUTING_PROFILE_PATH,
  ROUTING_PROFILE_VERSION,
  STANDARD_ROUTE_CLASSES,
  commitRoutingProfilePair,
  decodeRoutingProfile,
  inspectRoutingProfile,
  normalizeRosterModelId,
  readComposedRoutingProfile,
  readRoutingProfile,
  reconcileRoutingProfile,
  routingProfileBackupPath,
  routingProfilePath,
  routingProfileStorageRoot,
  setupRoutingProfile,
  validateRoutingProfile,
} from '../src/lib/routingProfile.mjs';
import {
  ROUTING_PROFILE_ENVELOPE_VERSION,
  recoverRoutingProfileStorage,
  resolveProjectIdentity,
  routingProfileGenerationPath,
} from '../src/lib/routingProfileStorage.mjs';
import {
  AGENT_SURFACE_REGISTRY,
  detectAgentSurfaces,
} from '../src/lib/agentSurfaceRegistry.mjs';
import { routingPromptPayload, routingResultNote } from '../src/cli.mjs';
import { makeKit, makeEmptyDir, cleanup } from './helpers.mjs';
import { PACKAGE_MANIFEST_NAME, readManifest, writeManifest } from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';

const P = '.claude/skills/to-prd/SKILL.md';
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const verify = async () => {};
const NO_STANDARD_ROUTES = { mechanical: null, development: null, judgment: null };

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

async function bumpKit(kitRoot, content) {
  await writeFile(join(kitRoot, P), content);
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  pkg.files.find(({ path }) => path === P).sha256 = sha256(content);
  await writeManifest(join(kitRoot, PACKAGE_MANIFEST_NAME), pkg);
}

test('registry data drives detection and keeps technical capabilities in adapters', async () => {
  assert.deepEqual(AGENT_SURFACE_REGISTRY.map(({ id }) => id), ['claude-code', 'codex']);
  const detected = await detectAgentSurfaces({
    commandAvailable: async (command) => command === 'claude' || command === 'codex',
  });
  assert.deepEqual(detected.map(({ id, detected: value }) => [id, value]), [
    ['claude-code', true],
    ['codex', true],
  ]);
  assert.ok(detected.every(({ adapter }) =>
    Array.isArray(adapter.providers) &&
    Array.isArray(adapter.transports) &&
    typeof adapter.enforcement === 'object'));
});

test('first setup live fixture preselects Claude and Codex and asks only surface and autonomy', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const questions = [];
  try {
    const result = await setupRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      currentSurface: 'claude-code',
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async (question) => {
        questions.push(question);
        if (question.kind === 'surfaces') {
          assert.deepEqual(question.preselected, ['claude-code', 'codex']);
          assert.deepEqual(question.options.map(({ id }) => id), ['claude-code', 'codex']);
          return ['claude-code', 'codex'];
        }
        if (question.kind === 'autonomy') return 'ask';
        if (question.kind === 'activation') return 'approve';
        throw new Error(`unexpected question: ${question.kind}`);
      },
    });

    assert.equal(result.status, 'activated');
    assert.deepEqual(questions.map(({ kind }) => kind), ['surfaces', 'autonomy', 'activation']);
    assert.ok(questions.every((question) =>
      !('providers' in question) && !('transports' in question) &&
      !('model' in question) && !('effort' in question)));
    assert.deepEqual(await readRoutingProfile(consumer, profileRoot), {
      schemaVersion: 2,
      registryRevision: 1,
      selectedSurfaces: ['claude-code', 'codex'],
      consideredSurfaces: ['claude-code', 'codex'],
      switching: 'ask',
      roster: [],
      standardRoutes: NO_STANDARD_ROUTES,
      advanced: null,
    });
  } finally {
    await cleanup(consumer);
  }
});

test('a single detected surface skips autonomy and safe-current-surface can activate', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const questions = [];
  try {
    const result = await setupRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      currentSurface: 'codex',
      detectedSurfaceIds: ['codex'],
      prompt: async (question) => {
        questions.push(question.kind);
        if (question.kind === 'surfaces') return ['codex'];
        if (question.kind === 'activation') return 'safe-current-surface';
        throw new Error(`unexpected question: ${question.kind}`);
      },
    });
    assert.equal(result.status, 'activated');
    assert.deepEqual(questions, ['surfaces', 'activation']);
    assert.equal((await readRoutingProfile(consumer, profileRoot)).switching, 'current-surface-only');
  } finally {
    await cleanup(consumer);
  }
});

test('activation supports back and optional advanced choices without entering default flow', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const questions = [];
  let activation = 0;
  try {
    await setupRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      currentSurface: 'claude-code',
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async (question) => {
        questions.push(question.kind);
        if (question.kind === 'surfaces') return ['claude-code', 'codex'];
        if (question.kind === 'autonomy') return 'automatic';
        if (question.kind === 'activation') {
          activation += 1;
          if (activation === 1) return 'back';
          if (activation === 2) return 'advanced';
          return 'approve';
        }
        if (question.kind === 'advanced') {
          return { optimization: 'quality', preferredModels: ['optional-user-choice'] };
        }
        throw new Error(`unexpected question: ${question.kind}`);
      },
    });
    assert.deepEqual(questions, [
      'surfaces', 'autonomy', 'activation', 'surfaces', 'autonomy',
      'activation', 'advanced', 'activation',
    ]);
    assert.deepEqual((await readRoutingProfile(consumer, profileRoot)).advanced, {
      legacy: { optimization: 'quality', preferredModels: ['optional-user-choice'] },
    });
  } finally {
    await cleanup(consumer);
  }
});

test('advanced stays draft-only until a later explicit approval', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const path = routingProfilePath(consumer, profileRoot);
  let activation = 0;
  try {
    const result = await setupRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      currentSurface: 'claude-code',
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async ({ kind }) => {
        if (kind === 'surfaces') return ['claude-code', 'codex'];
        if (kind === 'autonomy') return 'ask';
        if (kind === 'advanced') {
          assert.equal(await access(path).then(() => true, () => false), false);
          return { optimization: 'quality' };
        }
        if (kind === 'activation') {
          activation += 1;
          if (activation === 1) return 'advanced';
          assert.equal(await access(path).then(() => true, () => false), false);
          return 'decline';
        }
        throw new Error(`unexpected question: ${kind}`);
      },
    });
    assert.equal(result.status, 'declined');
    assert.equal(await access(path).then(() => true, () => false), false);
  } finally {
    await cleanup(consumer);
  }
});

test('init can run the one-time profile setup without mixing it into package ownership', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  try {
    const result = await init({
      kitRoot: kit,
      consumerRoot: consumer,
      routingProfile: {
        profileRoot,
        currentSurface: 'codex',
        detectedSurfaceIds: ['codex'],
        prompt: async ({ kind }) => kind === 'surfaces' ? ['codex'] : 'approve',
      },
    });
    assert.equal(result.routingProfile.status, 'activated');
    const manifest = await readManifest(join(consumer, 'agent-workflow-kit.json'));
    assert.equal(manifest.installed.some(({ path }) => path === ROUTING_PROFILE_PATH), false);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('unchanged update reports still valid and performs zero prompts', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  let prompts = 0;
  try {
    await init({
      kitRoot: kit,
      consumerRoot: consumer,
      routingProfile: {
        profileRoot,
        currentSurface: 'claude-code',
        detectedSurfaceIds: ['claude-code', 'codex'],
        prompt: async ({ kind }) => {
          if (kind === 'surfaces') return ['claude-code', 'codex'];
          if (kind === 'autonomy') return 'ask';
          return 'approve';
        },
      },
    });
    await bumpKit(kit, 'v2\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify,
      routingProfile: {
        profileRoot,
        currentSurface: 'claude-code',
        detectedSurfaceIds: ['claude-code', 'codex'],
        prompt: async () => { prompts += 1; return 'decline'; },
      },
    });

    assert.equal(result.state, 'applied');
    assert.equal(result.routingProfile.status, 'still valid');
    assert.equal(prompts, 0);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('missing profile is reported unattended and declining reconcile never rolls back update', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, 'v2\n');
    const unattended = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify,
      routingProfile: {
        profileRoot,
        currentSurface: 'codex',
        detectedSurfaceIds: ['codex'],
      },
    });
    assert.equal(unattended.state, 'applied');
    assert.deepEqual(unattended.routingProfile, {
      status: 'needs-reconcile',
      reasons: ['missing'],
    });
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v2\n');

    await bumpKit(kit, 'v3\n');
    let calls = 0;
    const declined = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify,
      routingProfile: {
        profileRoot,
        currentSurface: 'codex',
        detectedSurfaceIds: ['codex'],
        prompt: async ({ kind }) => {
          calls += 1;
          assert.equal(kind, 'reconcile');
          return 'decline';
        },
      },
    });
    assert.equal(declined.state, 'applied');
    assert.equal(declined.routingProfile.status, 'declined');
    assert.equal(calls, 1);
    assert.equal(await readFile(join(consumer, P), 'utf8'), 'v3\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('profile preflight names invalid, removed-route, newly meaningful surface, and stale states', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  try {
    const path = routingProfilePath(consumer, profileRoot);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"schemaVersion":99}\n');
    assert.deepEqual((await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      currentSurface: 'codex',
      detectedSurfaceIds: ['codex'],
    })).reasons, ['invalid']);

    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      registryRevision: 0,
      selectedSurfaces: ['removed-surface'],
      consideredSurfaces: ['removed-surface'],
      switching: 'ask',
      advanced: null,
    }));
    assert.deepEqual((await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      currentSurface: 'codex',
      detectedSurfaceIds: ['codex'],
    })).reasons, ['materially-stale', 'removed-route', 'new-meaningful-surface']);
  } finally {
    await cleanup(consumer);
  }
});

test('typed reconcile changes only the surfaced delta and preserves unaffected choices', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const path = routingProfilePath(consumer, profileRoot);
  const advanced = { optimization: 'quality', preferredModels: ['keep-me'] };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 1,
      registryRevision: 1,
      selectedSurfaces: ['claude-code'],
      consideredSurfaces: ['claude-code'],
      switching: 'automatic',
      advanced,
    })}\n`);
    const inspection = await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      detectedSurfaceIds: ['claude-code', 'codex'],
    });
    let prompts = 0;
    const result = await reconcileRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async (question) => {
        prompts += 1;
        assert.deepEqual(question.delta.newSurfaces, [{ id: 'codex', label: 'Codex' }]);
        assert.deepEqual(question.delta.removedSurfaces, []);
        return { action: 'apply', addSurfaceIds: [] };
      },
    }, inspection);

    assert.equal(result.status, 'reconciled');
    assert.equal(prompts, 1);
    assert.deepEqual(await readRoutingProfile(consumer, profileRoot), {
      schemaVersion: 2,
      registryRevision: 1,
      selectedSurfaces: ['claude-code'],
      consideredSurfaces: ['claude-code', 'codex'],
      switching: 'automatic',
      roster: [],
      standardRoutes: NO_STANDARD_ROUTES,
      advanced: { legacy: advanced },
    });
    assert.equal((await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      detectedSurfaceIds: ['claude-code', 'codex'],
    })).status, 'still valid');
  } finally {
    await cleanup(consumer);
  }
});

test('a concurrent profile mutation during reconcile is preserved and blocks stale overwrite', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const path = routingProfilePath(consumer, profileRoot);
  const original = {
    schemaVersion: 1,
    registryRevision: 1,
    selectedSurfaces: ['claude-code'],
    consideredSurfaces: ['claude-code'],
    switching: 'current-surface-only',
    advanced: null,
  };
  const concurrent = {
    ...original,
    selectedSurfaces: ['codex'],
    consideredSurfaces: ['codex'],
    advanced: { optimization: 'cost' },
  };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(original)}\n`);
    const inspection = await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      detectedSurfaceIds: ['claude-code', 'codex'],
    });
    await assert.rejects(reconcileRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async () => {
        await writeFile(path, `${JSON.stringify(concurrent)}\n`);
        return { action: 'apply', addSurfaceIds: ['codex'] };
      },
    }, inspection), /concurrent routing profile mutation/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), concurrent);
    assert.deepEqual(await readRoutingProfile(consumer, profileRoot), {
      schemaVersion: 2,
      registryRevision: 1,
      selectedSurfaces: ['codex'],
      consideredSurfaces: ['codex'],
      switching: 'current-surface-only',
      roster: [],
      standardRoutes: NO_STANDARD_ROUTES,
      advanced: { legacy: { optimization: 'cost' } },
    });
  } finally {
    await cleanup(consumer);
  }
});

test('update re-inspects after activation and adopts a concurrent valid personal choice', async () => {
  const kit = await makeKit({ [P]: 'v1\n' });
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const path = routingProfilePath(consumer, profileRoot);
  const concurrent = {
    schemaVersion: 1,
    registryRevision: 1,
    selectedSurfaces: ['codex'],
    consideredSurfaces: ['codex'],
    switching: 'current-surface-only',
    advanced: { optimization: 'cost' },
  };
  let prompts = 0;
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, 'v2\n');
    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify,
      activate: async (context) => {
        await activateCandidate(context);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(concurrent)}\n`);
      },
      routingProfile: {
        profileRoot,
        currentSurface: 'codex',
        detectedSurfaceIds: ['codex'],
        prompt: async () => { prompts += 1; return 'decline'; },
      },
    });
    assert.equal(result.routingProfile.status, 'still valid');
    assert.equal(prompts, 0);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), concurrent);
    assert.deepEqual(await readRoutingProfile(consumer, profileRoot), {
      schemaVersion: 2,
      registryRevision: 1,
      selectedSurfaces: ['codex'],
      consideredSurfaces: ['codex'],
      switching: 'current-surface-only',
      roster: [],
      standardRoutes: NO_STANDARD_ROUTES,
      advanced: { legacy: { optimization: 'cost' } },
    });
  } finally {
    await cleanup(kit, consumer);
  }
});

test('shipped CLI wires init and update while unattended init never prompts or invents policy', async () => {
  const consumer = await makeEmptyDir();
  const stateRoot = join(consumer, '.test-user-state');
  try {
    const result = spawnSync(process.execPath, [CLI, 'init', '--yes'], {
      cwd: consumer,
      env: { ...process.env, XDG_STATE_HOME: stateRoot },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(`${result.stdout}${result.stderr}`, /routing profile[\s\S]*needs-reconcile/);
    assert.equal(
      await access(routingProfilePath(consumer, join(stateRoot, 'agent-workflow-kit')))
        .then(() => true, () => false),
      false,
    );

    const cli = await readFile('src/cli.mjs', 'utf8');
    assert.equal((cli.match(/routingProfile: routingProfileOptions\(yes\)/g) ?? []).length, 2);
    assert.match(cli, /p\.multiselect/);
    assert.match(cli, /question\.options\.map/);
    assert.doesNotMatch(cli, /Claude Code.*Codex|Codex.*Claude Code/);
  } finally {
    await cleanup(consumer);
  }
});

test('schema v2 carries a Model roster and three Standard routes and rejects the removed dial', () => {
  assert.equal(ROUTING_PROFILE_VERSION, 2);
  assert.deepEqual(STANDARD_ROUTE_CLASSES, ['mechanical', 'development', 'judgment']);
  const base = {
    schemaVersion: 2,
    registryRevision: 1,
    selectedSurfaces: ['claude-code'],
    consideredSurfaces: ['claude-code'],
    switching: 'current-surface-only',
    roster: [
      { model: 'claude-opus-5[1m]', effort: 'high' },
      { model: 'claude-opus-5', effort: 'high' },
      { model: 'claude-haiku-4-5', effort: null },
    ],
    standardRoutes: {
      mechanical: { model: 'claude-haiku-4-5', effort: null },
      development: { model: 'claude-opus-5', effort: 'high' },
      judgment: { model: 'claude-opus-5[1m]', effort: 'high' },
    },
    advanced: null,
  };
  const profile = validateRoutingProfile(base);
  assert.deepEqual(profile.roster, [
    { model: 'claude-opus-5', effort: 'high' },
    { model: 'claude-haiku-4-5', effort: null },
  ]);
  assert.deepEqual(profile.standardRoutes, {
    mechanical: { model: 'claude-haiku-4-5', effort: null },
    development: { model: 'claude-opus-5', effort: 'high' },
    judgment: { model: 'claude-opus-5', effort: 'high' },
  });
  assert.equal(normalizeRosterModelId('  opus[1m] '), 'opus');

  const rejects = [
    [{ ...base, advanced: { optimization: 'quality' } }, /advanced field: optimization/],
    [{ ...base, standardRoutes: { mechanical: null, development: null } }, /workload class/],
    [
      { ...base, standardRoutes: { ...base.standardRoutes, judgment: { model: 'gpt-5.6-sol', effort: 'high' } } },
      /standardRoutes\.judgment must name a roster pair/,
    ],
    [{ ...base, roster: [{ model: 'claude-opus-5' }] }, /roster\[0\]\.effort/],
    [{ ...base, roster: [{ model: 'claude-opus-5', effort: '' }] }, /roster\[0\]\.effort/],
    [{ ...base, roster: [{ model: '[1m]', effort: 'high' }] }, /roster\[0\]\.model/],
    [{ ...base, schemaVersion: 1 }, /schemaVersion must be 2/],
  ];
  for (const [input, message] of rejects) assert.throws(() => validateRoutingProfile(input), message);
});

test('a v1 profile decodes through its own decoder and migrates without losing a choice', () => {
  const v1 = {
    schemaVersion: 1,
    registryRevision: 1,
    selectedSurfaces: ['claude-code', 'codex'],
    consideredSurfaces: ['claude-code', 'codex'],
    switching: 'ask',
    advanced: {
      optimization: 'quality',
      preferredModels: [
        'claude-opus-5[1m]',
        { model: 'gpt-5.6-terra[1m]', effort: 'medium' },
        { model: 'claude-haiku-4-5', effort: null },
        42,
      ],
      unknownEvidence: { keep: 'me' },
    },
  };
  const { profile, migration } = decodeRoutingProfile(structuredClone(v1));

  assert.equal(profile.schemaVersion, 2);
  assert.deepEqual(profile.selectedSurfaces, ['claude-code', 'codex']);
  assert.equal(profile.switching, 'ask');
  assert.deepEqual(profile.standardRoutes, NO_STANDARD_ROUTES);
  assert.deepEqual(profile.roster, [
    { model: 'gpt-5.6-terra', effort: 'medium' },
    { model: 'claude-haiku-4-5', effort: null },
  ]);
  assert.deepEqual(profile.advanced, { legacy: v1.advanced });
  assert.deepEqual(migration.backup, v1);
  assert.equal(migration.from, 1);
  assert.equal(migration.to, 2);
  assert.deepEqual(migration.notes, [
    { code: 'optimization-removed', value: 'quality' },
    { code: 'model-preference-needs-effort', model: 'claude-opus-5' },
    { code: 'roster-pair-admitted', model: 'gpt-5.6-terra', effort: 'medium' },
    { code: 'roster-pair-admitted', model: 'claude-haiku-4-5', effort: null },
    { code: 'model-preference-unreadable', index: 3 },
  ]);

  assert.deepEqual(decodeRoutingProfile({ ...v1, advanced: null }).profile.advanced, null);
  assert.equal(decodeRoutingProfile({ ...v1, schemaVersion: 2, roster: [], standardRoutes: NO_STANDARD_ROUTES, advanced: null }).migration, null);
  assert.throws(() => decodeRoutingProfile({ schemaVersion: 99 }), /unsupported routing profile schemaVersion/);
});

test('a stored v1 profile stays untouched until an authorized write backs the original up', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const path = routingProfilePath(consumer, profileRoot);
  const backup = routingProfileBackupPath(consumer, profileRoot, 1);
  const bytes = `${JSON.stringify({
    schemaVersion: 1,
    registryRevision: 1,
    selectedSurfaces: ['claude-code'],
    consideredSurfaces: ['claude-code'],
    switching: 'automatic',
    advanced: { optimization: 'cost', preferredModels: [{ model: 'gpt-5.6-sol', effort: 'high' }] },
  })}\n`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);

    const inspection = await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      detectedSurfaceIds: ['claude-code', 'codex'],
    });
    assert.equal(inspection.migration.from, 1);
    assert.deepEqual(inspection.profile.roster, [{ model: 'gpt-5.6-sol', effort: 'high' }]);
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.equal(await access(backup).then(() => true, () => false), false);

    const result = await reconcileRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async () => ({ action: 'apply', addSurfaceIds: ['codex'] }),
    }, inspection);

    assert.equal(result.status, 'reconciled');
    assert.equal(await readFile(backup, 'utf8'), bytes);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.schemaVersion, 2);
    assert.deepEqual(stored.roster, [{ model: 'gpt-5.6-sol', effort: 'high' }]);
    assert.deepEqual(stored.advanced, { legacy: JSON.parse(bytes).advanced });
    assert.equal((await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      detectedSurfaceIds: ['claude-code', 'codex'],
    })).migration, null);
  } finally {
    await cleanup(consumer);
  }
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const REGISTRY_OPTIONS = AGENT_SURFACE_REGISTRY.map(({ id, label }) => ({ id, label }));
const hintOf = (payload, value) => payload.options.find((option) => option.value === value)?.hint;

test('every routing prompt option explains what choosing it means', () => {
  const surfaces = routingPromptPayload({
    kind: 'surfaces',
    message: 'Which agent apps do you use?',
    options: REGISTRY_OPTIONS,
    preselected: [REGISTRY_OPTIONS[0].id],
  });
  assert.equal(surfaces.control, 'multiselect');
  assert.deepEqual(surfaces.options.map(({ value }) => value), REGISTRY_OPTIONS.map(({ id }) => id));
  assert.deepEqual(surfaces.initialValues, [REGISTRY_OPTIONS[0].id]);
  assert.ok(surfaces.options.every(({ hint }) => typeof hint === 'string' && hint.length > 0));
  assert.match(surfaces.options[0].hint, /^preselected —/);
  assert.ok(surfaces.options[0].hint.includes(REGISTRY_OPTIONS[0].label));
  assert.match(surfaces.options[1].hint, /^not preselected —/);
  assert.ok(surfaces.options[1].hint.includes(REGISTRY_OPTIONS[1].label));

  const autonomy = routingPromptPayload({
    kind: 'autonomy',
    message: 'May the Kit switch agent apps for a task?',
    options: [
      { value: 'automatic', label: 'Switch automatically' },
      { value: 'ask', label: 'Ask before switching' },
      { value: 'current-surface-only', label: 'Stay in the current app' },
    ],
  });
  assert.equal(autonomy.control, 'select');
  assert.deepEqual(autonomy.options.map(({ label }) => label), [
    'Switch automatically', 'Ask before switching', 'Stay in the current app',
  ]);
  assert.equal(new Set(autonomy.options.map(({ hint }) => hint)).size, 3);
  assert.match(hintOf(autonomy, 'ask'), /confirmation/);
  assert.match(hintOf(autonomy, 'current-surface-only'), /stays/);
  assert.match(hintOf(autonomy, 'automatic'), /on its own/);

  const advanced = routingPromptPayload({
    kind: 'advanced',
    message: 'Optional model and optimization preferences',
    draft: { optimization: 'quality' },
  });
  assert.equal(advanced.control, 'select');
  assert.equal(advanced.initialValue, 'quality');
  assert.match(advanced.message, /optional note/);
  assert.deepEqual(advanced.options.map(({ value }) => value), ['balanced', 'quality', 'cost']);
  assert.ok(advanced.options.every(({ hint }) => typeof hint === 'string' && hint.length > 0));
});

test('the activation summary renders surfaces, switching and the advanced draft', () => {
  const question = {
    kind: 'activation',
    message: 'Review routing activation',
    selectedSurfaces: AGENT_SURFACE_REGISTRY.map(({ id }) => id),
    switching: 'ask',
    advancedDraft: { optimization: 'quality', preferredModels: ['keep-me'] },
    actions: ['approve', 'back', 'advanced', 'safe-current-surface', 'decline'],
  };
  const payload = routingPromptPayload(question);

  assert.equal(payload.control, 'select');
  assert.match(payload.message, /Review routing activation/);
  for (const { label } of REGISTRY_OPTIONS) assert.ok(payload.message.includes(label));
  assert.match(payload.message, /switching: ask — .+confirmation/);
  assert.match(payload.message, /advanced draft: .*optimization=quality/);
  assert.match(payload.message, /preferredModels=\["keep-me"\]/);
  assert.deepEqual(payload.options.map(({ value }) => value), question.actions);
  assert.ok(payload.options.every(({ hint, label }) => hint?.length && label?.length));
  assert.equal(new Set(payload.options.map(({ hint }) => hint)).size, question.actions.length);

  const bare = routingPromptPayload({ ...question, advancedDraft: null, selectedSurfaces: [] });
  assert.match(bare.message, /agent apps: none/);
  assert.match(bare.message, /advanced draft: none/);
});

test('reconcile prompts explain both routes and the confirm names each answer', () => {
  const migration = routingPromptPayload({
    kind: 'reconcile',
    message: 'Your routing choices need review.',
    reasons: ['missing'],
    delta: { type: 'missing-profile' },
  });
  assert.equal(migration.control, 'select');
  assert.deepEqual(migration.options.map(({ value }) => value), ['review', 'decline']);
  assert.ok(migration.options.every(({ hint }) => typeof hint === 'string' && hint.length > 0));

  const additions = routingPromptPayload({
    kind: 'reconcile',
    message: 'Your routing choices need review.',
    delta: {
      type: 'registry-delta',
      newSurfaces: [REGISTRY_OPTIONS[1]],
      removedSurfaces: [{ id: 'ghost', label: 'Ghost' }],
    },
  });
  assert.equal(additions.control, 'multiselect');
  assert.match(additions.message, /new: .*· unavailable: Ghost/);
  assert.deepEqual(additions.options.map(({ value }) => value), [REGISTRY_OPTIONS[1].id]);
  assert.ok(additions.options[0].hint.includes(REGISTRY_OPTIONS[1].label));

  const confirm = routingPromptPayload({
    kind: 'reconcile',
    message: 'Your routing choices need review.',
    delta: { type: 'registry-delta', newSurfaces: [], removedSurfaces: [{ id: 'ghost', label: 'Ghost' }] },
  });
  assert.equal(confirm.control, 'confirm');
  assert.match(confirm.message, /Ghost/);
  assert.ok(confirm.active.length > 0 && confirm.inactive.length > 0);

  assert.throws(() => routingPromptPayload({ kind: 'teleport' }), /unknown routing profile question: teleport/);
  assert.throws(
    () => routingPromptPayload({
      kind: 'autonomy',
      message: 'May the Kit switch agent apps for a task?',
      options: [{ value: 'teleport', label: 'Teleport' }],
    }),
    /missing routing prompt hint: autonomy\.teleport/,
  );
});

test('the result note names the activated profile and its user-local path', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  try {
    const result = await setupRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      currentSurface: 'claude-code',
      detectedSurfaceIds: AGENT_SURFACE_REGISTRY.map(({ id }) => id),
      prompt: async ({ kind }) => {
        if (kind === 'surfaces') return AGENT_SURFACE_REGISTRY.map(({ id }) => id);
        if (kind === 'autonomy') return 'ask';
        return 'approve';
      },
    });
    assert.equal(result.status, 'activated');

    const note = routingResultNote(result, consumer, profileRoot);
    assert.match(note, /status: activated/);
    for (const { label } of REGISTRY_OPTIONS) assert.ok(note.includes(label), label);
    assert.match(note, /switching: ask — .+confirmation/);
    assert.ok(note.includes(routingProfilePath(consumer, profileRoot)));

    const unresolved = routingResultNote(
      { status: 'needs-reconcile', reasons: ['missing'] }, consumer, profileRoot,
    );
    assert.match(unresolved, /status: needs-reconcile/);
    assert.match(unresolved, /reasons: missing/);
    assert.ok(unresolved.includes(routingProfilePath(consumer, profileRoot)));

    const hostile = routingResultNote({
      status: 'reconciled',
      reasons: [],
      profile: { selectedSurfaces: ['gh\u001b[31most'], switching: 'automatic' },
    }, consumer, profileRoot);
    for (const line of hostile.split('\n')) assert.doesNotMatch(line, CONTROL_CHARACTERS);
    assert.match(hostile, /switching: automatic — /);

    assert.equal(routingResultNote(undefined, consumer, profileRoot), null);
  } finally {
    await cleanup(consumer);
  }
});

test('setup and update skill contracts stay source-first and mirrored', async () => {
  for (const skill of ['setup-workflow', 'kit-update']) {
    const claude = await readFile(join('.claude/skills', skill, 'SKILL.md'), 'utf8');
    const codex = await readFile(join('.agents/skills', skill, 'SKILL.md'), 'utf8');
    assert.equal(codex, claude);
    assert.match(claude, /user-local|routing-profile/);
    assert.match(claude, /still valid/);
  }
  const setup = await readFile('.claude/skills/setup-workflow/SKILL.md', 'utf8');
  assert.match(setup, /detected entries preselected/);
  assert.match(setup, /Switch automatically/);
  assert.match(setup, /Ask before switching/);
  assert.match(setup, /Stay in the current app/);
  assert.match(setup, /Back[\s\S]*Advanced[\s\S]*Approve[\s\S]*Safe current surface/);

  const updateSkill = await readFile('.claude/skills/kit-update/SKILL.md', 'utf8');
  assert.match(updateSkill, /Unattended update records[\s\S]*needs-reconcile/);
  assert.match(updateSkill, /Declining the[\s\S]*successful Kit update applied/);
});

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A resolved project identity that needs no git, so storage tests stay hermetic. */
const FIXTURE_IDENTITY = Object.freeze({
  key: 'b1c26c58-9a2e-4a63-8f0a-5f9c1d3e7a20',
  value: 'b1c26c58-9a2e-4a63-8f0a-5f9c1d3e7a20',
  source: 'git-marker',
  confidence: 'stable',
  markerPath: null,
});

const storageProfile = (overrides = {}) => ({
  schemaVersion: ROUTING_PROFILE_VERSION,
  registryRevision: 1,
  selectedSurfaces: ['claude-code', 'codex'],
  consideredSurfaces: ['claude-code', 'codex'],
  switching: 'ask',
  roster: [{ model: 'claude-opus-5', effort: 'high' }],
  standardRoutes: { ...NO_STANDARD_ROUTES, development: { model: 'claude-opus-5', effort: 'high' } },
  advanced: null,
  ...overrides,
});

/** Git without the hook-exported GIT_* environment, which would retarget the repo. */
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
);

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], {
    cwd, encoding: 'utf8', env: GIT_ENV, timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const exists = (path) => access(path).then(() => true, () => false);

test('global and project documents carry immutable generations in a storage envelope, never in the profile schema', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const root = routingProfileStorageRoot(profileRoot);
  try {
    const first = await commitRoutingProfilePair({
      profileRoot,
      identity: FIXTURE_IDENTITY,
      global: storageProfile(),
      project: storageProfile({ selectedSurfaces: ['codex'] }),
    });
    assert.deepEqual([first.globalGeneration, first.projectGeneration], [1, 1]);

    const globalFile = routingProfileGenerationPath({ root, scope: 'global', generation: 1 });
    const envelope = JSON.parse(await readFile(globalFile, 'utf8'));
    assert.equal(envelope.envelopeVersion, ROUTING_PROFILE_ENVELOPE_VERSION);
    assert.equal(envelope.scope, 'global');
    assert.equal(envelope.generation, 1);
    assert.ok(Number.isFinite(Date.parse(envelope.committedAt)));
    assert.deepEqual(envelope.document, validateRoutingProfile(storageProfile()));
    for (const field of ['generation', 'envelopeVersion', 'committedAt', 'revision']) {
      assert.equal(field in envelope.document, false, field);
    }
    assert.throws(
      () => validateRoutingProfile({ ...storageProfile(), generation: 1 }),
      /unknown routing profile field: generation/,
    );

    const projectEnvelope = JSON.parse(await readFile(routingProfileGenerationPath({
      root, scope: 'project', projectKey: FIXTURE_IDENTITY.key, generation: 1,
    }), 'utf8'));
    assert.equal(projectEnvelope.projectKey, FIXTURE_IDENTITY.key);
    assert.deepEqual(projectEnvelope.identity, { source: 'git-marker', confidence: 'stable' });
    assert.equal(projectEnvelope.authoredAgainstGlobalGeneration, 1);

    const bytes = await readFile(globalFile, 'utf8');
    const second = await commitRoutingProfilePair({
      profileRoot, identity: FIXTURE_IDENTITY, global: storageProfile({ switching: 'automatic' }),
    });
    assert.equal(second.globalGeneration, 2);
    assert.equal(second.projectGeneration, null);
    assert.equal(await readFile(globalFile, 'utf8'), bytes);

    await assert.rejects(commitRoutingProfilePair({
      profileRoot,
      identity: FIXTURE_IDENTITY,
      global: storageProfile({ switching: 'current-surface-only' }),
      expectedGlobalGeneration: 1,
    }), /stale routing profile generation: expected 1, found 2/);
    await assert.rejects(commitRoutingProfilePair({
      profileRoot,
      identity: FIXTURE_IDENTITY,
      project: storageProfile({ selectedSurfaces: ['codex'] }),
      expectedProjectGeneration: null,
    }), /stale routing profile generation: expected none, found 1/);
    const latest = JSON.parse(await readFile(
      routingProfileGenerationPath({ root, scope: 'global', generation: 2 }), 'utf8',
    ));
    assert.equal(latest.document.switching, 'automatic');
  } finally {
    await cleanup(consumer);
  }
});

test('composition reads the latest committed global generation plus the project narrowing', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  try {
    const empty = await readComposedRoutingProfile({ profileRoot, identity: FIXTURE_IDENTITY });
    assert.equal(empty.global, null);
    assert.equal(empty.project, null);
    assert.deepEqual(empty.reasons, ['no-global-authorization', 'no-project-narrowing']);

    await commitRoutingProfilePair({
      profileRoot,
      identity: FIXTURE_IDENTITY,
      global: storageProfile(),
      project: storageProfile({ selectedSurfaces: ['codex'] }),
    });
    await commitRoutingProfilePair({
      profileRoot, identity: FIXTURE_IDENTITY, global: storageProfile({ switching: 'automatic' }),
    });

    const composed = await readComposedRoutingProfile({ profileRoot, identity: FIXTURE_IDENTITY });
    assert.equal(composed.global.generation, 2);
    assert.equal(composed.global.profile.switching, 'automatic');
    assert.equal(composed.project.generation, 1);
    assert.deepEqual(composed.project.profile.selectedSurfaces, ['codex']);
    assert.equal(composed.project.authoredAgainstGlobalGeneration, 1);
    assert.deepEqual(composed.reasons, []);
    assert.equal(composed.pendingTransactionId, null);

    const fresh = await readComposedRoutingProfile({
      profileRoot, identity: { ...FIXTURE_IDENTITY, key: 'a0e1b2c3-d4e5-4f60-8a9b-0c1d2e3f4a5b' },
    });
    assert.equal(fresh.global.generation, 2);
    assert.equal(fresh.project, null);
    assert.deepEqual(fresh.reasons, ['no-project-narrowing']);
  } finally {
    await cleanup(consumer);
  }
});

test('a crash between the global and the project write recovers to the last committed pair', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const root = routingProfileStorageRoot(profileRoot);
  const projectDir = dirname(routingProfileGenerationPath({
    root, scope: 'project', projectKey: FIXTURE_IDENTITY.key, generation: 1,
  }));
  const pair = {
    global: storageProfile({ switching: 'automatic' }),
    project: storageProfile({ selectedSurfaces: ['codex'], switching: 'current-surface-only' }),
  };
  try {
    await commitRoutingProfilePair({
      profileRoot,
      identity: FIXTURE_IDENTITY,
      global: storageProfile(),
      project: storageProfile({ selectedSurfaces: ['codex'] }),
    });

    // The crash: the global generation reaches the disk, the project generation
    // never does — reproduced by making only the project side unwritable.
    await chmod(projectDir, 0o555);
    await assert.rejects(commitRoutingProfilePair({
      profileRoot, identity: FIXTURE_IDENTITY, ...pair,
    }));
    const halfWritten = routingProfileGenerationPath({ root, scope: 'global', generation: 2 });
    assert.equal(await exists(halfWritten), true);

    const afterCrash = await readComposedRoutingProfile({ profileRoot, identity: FIXTURE_IDENTITY });
    assert.equal(afterCrash.global.generation, 1);
    assert.equal(afterCrash.global.profile.switching, 'ask');
    assert.equal(afterCrash.project.generation, 1);
    assert.equal(afterCrash.project.profile.switching, 'ask');
    assert.ok(UUID_SHAPE.test(afterCrash.pendingTransactionId));

    await chmod(projectDir, 0o700);
    const recovered = await recoverRoutingProfileStorage({ root });
    assert.equal(recovered.transactionId, afterCrash.pendingTransactionId);
    assert.deepEqual(recovered.discarded, [halfWritten]);
    assert.equal(await exists(halfWritten), false);

    const afterRecovery = await readComposedRoutingProfile({
      profileRoot, identity: FIXTURE_IDENTITY,
    });
    assert.equal(afterRecovery.global.generation, 1);
    assert.equal(afterRecovery.project.generation, 1);
    assert.equal(afterRecovery.pendingTransactionId, null);

    const retried = await commitRoutingProfilePair({
      profileRoot, identity: FIXTURE_IDENTITY, ...pair,
    });
    assert.deepEqual([retried.globalGeneration, retried.projectGeneration], [2, 2]);
    const landed = await readComposedRoutingProfile({ profileRoot, identity: FIXTURE_IDENTITY });
    assert.equal(landed.global.profile.switching, 'automatic');
    assert.equal(landed.project.profile.switching, 'current-surface-only');
    assert.equal(landed.project.authoredAgainstGlobalGeneration, 2);
  } finally {
    await chmod(projectDir, 0o700).catch(() => {});
    await cleanup(consumer);
  }
});

test('the project key is the marker identity every worktree of a repository shares', async () => {
  const repo = await makeEmptyDir();
  const elsewhere = await makeEmptyDir();
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const worktree = join(elsewhere, 'slice');
  try {
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'root');

    const identity = await resolveProjectIdentity({ projectRoot: repo });
    assert.equal(identity.source, 'git-marker');
    assert.equal(identity.confidence, 'stable');
    assert.ok(UUID_SHAPE.test(identity.key));
    assert.equal(identity.markerPath, join(repo, '.git', 'agent-workflow-kit', 'project-id'));
    assert.equal((await readFile(identity.markerPath, 'utf8')).trim(), identity.key);
    assert.equal((await resolveProjectIdentity({ projectRoot: repo })).key, identity.key);
    assert.equal(git(repo, 'status', '--porcelain'), '');

    git(repo, 'worktree', 'add', '-q', '-b', 'slice', worktree);
    assert.equal((await resolveProjectIdentity({ projectRoot: worktree })).key, identity.key);

    await commitRoutingProfilePair({
      profileRoot,
      projectRoot: worktree,
      global: storageProfile(),
      project: storageProfile({ selectedSurfaces: ['codex'] }),
    });
    const composed = await readComposedRoutingProfile({ profileRoot, projectRoot: repo });
    assert.equal(composed.identity.key, identity.key);
    assert.deepEqual(composed.project.profile.selectedSurfaces, ['codex']);
    assert.equal(await exists(routingProfileGenerationPath({
      root: routingProfileStorageRoot(profileRoot),
      scope: 'project',
      projectKey: identity.key,
      generation: 1,
    })), true);

    const outsideGit = await resolveProjectIdentity({ projectRoot: consumer });
    assert.equal(outsideGit.source, 'project-path');
    assert.equal(outsideGit.confidence, 'lower');
    assert.match(outsideGit.key, /^path-[0-9a-f]{20}$/);
    assert.equal(outsideGit.value, consumer);
    assert.equal(outsideGit.markerPath, null);

    await writeFile(identity.markerPath, 'not-a-uuid\n');
    await assert.rejects(
      resolveProjectIdentity({ projectRoot: repo }),
      /routing project identity marker is unreadable/,
    );
  } finally {
    await cleanup(repo, elsewhere, consumer);
  }
});
