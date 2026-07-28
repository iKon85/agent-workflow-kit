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
  ROSTER_PAIR_STATES,
  ROUTING_INTERVIEW_SEQUENCE,
  ROUTING_PROFILE_PATH,
  ROUTING_PROFILE_VERSION,
  STANDARD_ROUTE_CLASSES,
  STANDARD_ROUTE_STATES,
  commitRoutingProfilePair,
  composeRoutingProfile,
  decodeRoutingNarrowing,
  decodeRoutingProfile,
  inspectRoutingProfile,
  narrowingViolations,
  normalizeRosterModelId,
  readComposedRoutingProfile,
  readRoutingProfile,
  reconcileRosterState,
  reconcileRoutingProfile,
  routingProfileBackupPath,
  routingProfilePath,
  routingProfileStorageRoot,
  setupRoutingProfile,
  validateRoutingNarrowing,
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
import {
  UNTESTED_ACCESS,
  loadRoutingInventory,
  presentInventory,
} from '../src/lib/routingInventory.mjs';
import { routingPromptPayload, routingResultNote } from '../src/cli.mjs';
import { makeKit, makeEmptyDir, cleanup } from './helpers.mjs';
import { PACKAGE_MANIFEST_NAME, readManifest, writeManifest } from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';

const P = '.claude/skills/to-prd/SKILL.md';
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const verify = async () => {};
const NO_STANDARD_ROUTES = { mechanical: null, development: null, judgment: null };

/**
 * A pinned inventory fixture: the roster state machine is asserted against a
 * known pair set, not against whatever the shipped snapshots happen to list.
 */
const INVENTORY = Object.freeze({
  revision: 'sha256-inventory-1',
  pairs: Object.freeze([
    Object.freeze({ surface: 'claude-code', provider: 'anthropic', modelId: 'opus', effort: 'high' }),
    Object.freeze({ surface: 'claude-code', provider: 'anthropic', modelId: 'opus', effort: 'low' }),
    Object.freeze({ surface: 'claude-code', provider: 'anthropic', modelId: 'haiku', effort: null }),
    Object.freeze({ surface: 'codex', provider: 'openai', modelId: 'gpt-5.6-sol', effort: 'high' }),
  ]),
});

/** The same inventory after the maintainer step dropped one pair. */
const SHRUNK_INVENTORY = Object.freeze({
  revision: 'sha256-inventory-2',
  pairs: Object.freeze(INVENTORY.pairs.filter(({ modelId, effort }) =>
    !(modelId === 'opus' && effort === 'high'))),
});

const native = (...surfaces) => surfaces.map((surface) => ({ surface, transport: 'native' }));
const pair = (model, effort = null) => ({ model, effort });
const entry = (model, effort, state) => ({ model, effort, state });
const route = (model, effort, state = 'configured') => ({ model, effort, state });

/** A complete global authorization over the inventory fixture. */
const globalDocument = (overrides = {}) => ({
  schemaVersion: ROUTING_PROFILE_VERSION,
  registryRevision: 1,
  selectedSurfaces: ['claude-code', 'codex'],
  consideredSurfaces: ['claude-code', 'codex'],
  authorizedTransports: [...native('claude-code', 'codex'), { surface: 'claude-code', transport: 'codex-cli' }],
  switching: 'ask',
  roster: [
    entry('opus', 'high', 'admitted'),
    entry('haiku', null, 'admitted'),
    entry('gpt-5.6-sol', 'high', 'admitted'),
    entry('opus', 'low', 'declined'),
  ],
  inventoryRevision: INVENTORY.revision,
  standardRoutes: {
    mechanical: route('haiku', null),
    development: route('opus', 'high'),
    judgment: route('opus', 'high'),
  },
  advanced: null,
  ...overrides,
});

const narrowing = (overrides = {}) => ({
  schemaVersion: ROUTING_PROFILE_VERSION,
  selectedSurfaces: null,
  authorizedTransports: null,
  switching: null,
  roster: null,
  standardRoutes: null,
  ...overrides,
});

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

test('first setup walks the declared interview order and stores every answer', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const questions = [];
  try {
    const result = await setupRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      inventory: INVENTORY,
      currentSurface: 'claude-code',
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async (question) => {
        questions.push(question);
        if (question.kind === 'surfaces') {
          assert.deepEqual(question.preselected, ['claude-code', 'codex']);
          assert.deepEqual(question.options.map(({ id }) => id), ['claude-code', 'codex']);
          return ['claude-code', 'codex'];
        }
        if (question.kind === 'transports') {
          // Native is preselected; driving the other app's CLI is not.
          assert.deepEqual(question.preselected, native('claude-code', 'codex'));
          assert.deepEqual(question.options.map(({ surface, transport }) => `${surface}/${transport}`), [
            'claude-code/native', 'claude-code/codex-cli', 'codex/native', 'codex/claude-cli',
          ]);
          return [...native('claude-code', 'codex'), { surface: 'codex', transport: 'claude-cli' }];
        }
        if (question.kind === 'autonomy') return 'ask';
        if (question.kind === 'roster') return [pair('opus', 'high'), pair('haiku', null)];
        if (question.kind === 'standard-route') {
          return question.workload === 'mechanical' ? pair('haiku', null) : pair('opus', 'high');
        }
        if (question.kind === 'activation') return 'approve';
        throw new Error(`unexpected question: ${question.kind}`);
      },
    });

    assert.equal(result.status, 'activated');
    assert.deepEqual(questions.map(({ kind }) => kind), [
      'surfaces', 'transports', 'autonomy', 'roster',
      'standard-route', 'standard-route', 'standard-route', 'activation',
    ]);
    assert.deepEqual(await readRoutingProfile(consumer, profileRoot), {
      schemaVersion: 2,
      registryRevision: 1,
      selectedSurfaces: ['claude-code', 'codex'],
      consideredSurfaces: ['claude-code', 'codex'],
      authorizedTransports: [...native('claude-code', 'codex'), { surface: 'codex', transport: 'claude-cli' }],
      switching: 'ask',
      // Every offered pair carries a decision: the two picked are admitted, the
      // rest are declined so they are never asked about again.
      roster: [
        entry('opus', 'high', 'admitted'),
        entry('opus', 'low', 'declined'),
        entry('haiku', null, 'admitted'),
        entry('gpt-5.6-sol', 'high', 'declined'),
      ],
      inventoryRevision: INVENTORY.revision,
      standardRoutes: {
        mechanical: route('haiku', null),
        development: route('opus', 'high'),
        judgment: route('opus', 'high'),
      },
      advanced: null,
    });
    assert.equal((await inspectRoutingProfile({
      consumerRoot: consumer, profileRoot, inventory: INVENTORY,
      detectedSurfaceIds: ['claude-code', 'codex'],
    })).status, 'still valid');
  } finally {
    await cleanup(consumer);
  }
});

test('a single surface skips switching and an unreadable inventory skips the roster stage', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const questions = [];
  try {
    const result = await setupRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      // No inventory: nothing is authorized rather than something guessed.
      inventory: null,
      currentSurface: 'codex',
      detectedSurfaceIds: ['codex'],
      prompt: async (question) => {
        questions.push(question.kind);
        if (question.kind === 'surfaces') return ['codex'];
        if (question.kind === 'transports') return native('codex');
        if (question.kind === 'activation') return 'safe-current-surface';
        throw new Error(`unexpected question: ${question.kind}`);
      },
    });
    assert.equal(result.status, 'activated');
    assert.deepEqual(questions, ['surfaces', 'transports', 'activation']);
    const stored = await readRoutingProfile(consumer, profileRoot);
    assert.equal(stored.switching, 'current-surface-only');
    assert.deepEqual(stored.roster, []);
    assert.equal(stored.inventoryRevision, null);
    assert.deepEqual(stored.standardRoutes, NO_STANDARD_ROUTES);
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
      inventory: null,
      currentSurface: 'claude-code',
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async (question) => {
        questions.push(question.kind);
        if (question.kind === 'surfaces') return ['claude-code', 'codex'];
        if (question.kind === 'transports') return native('claude-code', 'codex');
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
      'surfaces', 'transports', 'autonomy', 'activation',
      'surfaces', 'transports', 'autonomy', 'activation', 'advanced', 'activation',
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
      inventory: null,
      currentSurface: 'claude-code',
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async ({ kind }) => {
        if (kind === 'surfaces') return ['claude-code', 'codex'];
        if (kind === 'transports') return native('claude-code', 'codex');
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
        inventory: null,
        currentSurface: 'codex',
        detectedSurfaceIds: ['codex'],
        prompt: async ({ kind }) => {
          if (kind === 'surfaces') return ['codex'];
          if (kind === 'transports') return native('codex');
          return 'approve';
        },
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
        inventory: INVENTORY,
        currentSurface: 'claude-code',
        detectedSurfaceIds: ['claude-code', 'codex'],
        prompt: async ({ kind }) => {
          if (kind === 'surfaces') return ['claude-code', 'codex'];
          if (kind === 'transports') return native('claude-code', 'codex');
          if (kind === 'autonomy') return 'ask';
          if (kind === 'roster') return [pair('haiku', null)];
          if (kind === 'standard-route') return pair('haiku', null);
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
        inventory: INVENTORY,
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
        inventory: null,
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
        inventory: null,
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
      inventory: INVENTORY,
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
    const inspection = await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      inventory: INVENTORY,
      currentSurface: 'codex',
      detectedSurfaceIds: ['codex'],
    });
    assert.deepEqual(inspection.reasons, [
      'materially-stale', 'removed-route', 'new-meaningful-surface', 'roster-pairs-unrecorded',
    ]);
    // The migrated profile never answered the roster question, so every pinned
    // pair is still unrecorded — and none of them is authorized meanwhile.
    assert.deepEqual(inspection.rosterState.admitted, []);
    assert.equal(inspection.delta.roster.pending.length, INVENTORY.pairs.length);

    // An unreadable inventory is named, never silently treated as "no pairs".
    const unreadable = await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      loadInventory: async () => { throw new Error('snapshot tampered'); },
      currentSurface: 'codex',
      detectedSurfaceIds: ['codex'],
    });
    assert.ok(unreadable.reasons.includes('roster-inventory-unreadable'));
    assert.equal(unreadable.rosterState, null);
    assert.equal(unreadable.delta.roster.inventoryUnreadable, true);

    // Without an explicit inventory the pinned shipped snapshots are the source.
    const shipped = await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      currentSurface: 'codex',
      detectedSurfaceIds: ['codex'],
    });
    assert.equal(shipped.rosterState.inventoryRevision, (await loadRoutingInventory()).revision);
    assert.ok(shipped.reasons.includes('roster-pairs-unrecorded'));
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
      inventory: null,
      detectedSurfaceIds: ['claude-code', 'codex'],
    });
    let prompts = 0;
    const result = await reconcileRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      inventory: null,
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
      authorizedTransports: native('claude-code'),
      switching: 'automatic',
      roster: [],
      inventoryRevision: null,
      standardRoutes: NO_STANDARD_ROUTES,
      advanced: { legacy: advanced },
    });
    assert.equal((await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      inventory: null,
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
      inventory: null,
      detectedSurfaceIds: ['claude-code', 'codex'],
    });
    await assert.rejects(reconcileRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      inventory: null,
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
      authorizedTransports: native('codex'),
      switching: 'current-surface-only',
      roster: [],
      inventoryRevision: null,
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
        inventory: null,
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
      authorizedTransports: native('codex'),
      switching: 'current-surface-only',
      roster: [],
      inventoryRevision: null,
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
    authorizedTransports: native('claude-code'),
    switching: 'current-surface-only',
    roster: [
      entry('claude-opus-5[1m]', 'high', 'admitted'),
      entry('claude-opus-5', 'high', 'admitted'),
      entry('claude-haiku-4-5', null, 'admitted'),
    ],
    inventoryRevision: null,
    standardRoutes: {
      mechanical: route('claude-haiku-4-5', null),
      development: route('claude-opus-5', 'high'),
      judgment: route('claude-opus-5[1m]', 'high'),
    },
    advanced: null,
  };
  const profile = validateRoutingProfile(base);
  assert.deepEqual(profile.roster, [
    entry('claude-opus-5', 'high', 'admitted'),
    entry('claude-haiku-4-5', null, 'admitted'),
  ]);
  assert.deepEqual(profile.standardRoutes, {
    mechanical: route('claude-haiku-4-5', null),
    development: route('claude-opus-5', 'high'),
    judgment: route('claude-opus-5', 'high'),
  });
  assert.equal(normalizeRosterModelId('  opus[1m] '), 'opus');

  const rejects = [
    [{ ...base, advanced: { optimization: 'quality' } }, /advanced field: optimization/],
    [{ ...base, standardRoutes: { mechanical: null, development: null } }, /workload class/],
    [
      { ...base, standardRoutes: { ...base.standardRoutes, judgment: route('gpt-5.6-sol', 'high') } },
      /standardRoutes\.judgment must name an admitted roster pair/,
    ],
    [{ ...base, roster: [{ model: 'claude-opus-5', state: 'admitted' }] }, /roster\[0\]\.effort/],
    [{ ...base, roster: [entry('claude-opus-5', '', 'admitted')] }, /roster\[0\]\.effort/],
    [{ ...base, roster: [entry('[1m]', 'high', 'admitted')] }, /roster\[0\]\.model/],
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
    entry('gpt-5.6-terra', 'medium', 'admitted'),
    entry('claude-haiku-4-5', null, 'admitted'),
  ]);
  assert.equal(profile.inventoryRevision, null);
  // v1 never asked a transport question; reading its surface selection as "may
  // drive its own runtime" keeps the meaning without granting a cross-app CLI.
  assert.deepEqual(profile.authorizedTransports, native('claude-code', 'codex'));
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
    { code: 'transport-authorization-defaulted-to-native', surfaces: ['claude-code', 'codex'] },
  ]);

  assert.deepEqual(decodeRoutingProfile({ ...v1, advanced: null }).profile.advanced, null);
  assert.equal(decodeRoutingProfile(globalDocument()).migration, null);
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
      inventory: null,
      detectedSurfaceIds: ['claude-code', 'codex'],
    });
    assert.equal(inspection.migration.from, 1);
    assert.deepEqual(inspection.profile.roster, [entry('gpt-5.6-sol', 'high', 'admitted')]);
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.equal(await access(backup).then(() => true, () => false), false);

    const result = await reconcileRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      inventory: null,
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async () => ({ action: 'apply', addSurfaceIds: ['codex'] }),
    }, inspection);

    assert.equal(result.status, 'reconciled');
    assert.equal(await readFile(backup, 'utf8'), bytes);
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.schemaVersion, 2);
    assert.deepEqual(stored.roster, [entry('gpt-5.6-sol', 'high', 'admitted')]);
    assert.deepEqual(stored.advanced, { legacy: JSON.parse(bytes).advanced });
    assert.equal((await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      inventory: null,
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

test('the activation summary renders every answer the interview collected', () => {
  const question = {
    kind: 'activation',
    message: 'Review routing activation',
    selectedSurfaces: AGENT_SURFACE_REGISTRY.map(({ id }) => id),
    authorizedTransports: [...native('claude-code'), { surface: 'codex', transport: 'claude-cli' }],
    switching: 'ask',
    roster: [entry('opus', 'high', 'admitted'), entry('opus', 'low', 'declined')],
    standardRoutes: {
      mechanical: null,
      development: route('opus', 'high'),
      judgment: route('gone', 'high', 'unresolved'),
    },
    advancedDraft: { optimization: 'quality', preferredModels: ['keep-me'] },
    actions: ['approve', 'back', 'advanced', 'safe-current-surface', 'decline'],
  };
  const payload = routingPromptPayload(question);

  assert.equal(payload.control, 'select');
  assert.match(payload.message, /Review routing activation/);
  for (const { label } of REGISTRY_OPTIONS) assert.ok(payload.message.includes(label));
  assert.match(payload.message, /transports: .+ · native, .+ · claude-cli/);
  assert.match(payload.message, /switching: ask — .+confirmation/);
  assert.match(payload.message, /model roster: 1 admitted · 1 declined/);
  assert.match(payload.message, /standard routes: mechanical: unset/);
  assert.match(payload.message, /development: opus · high/);
  assert.match(payload.message, /judgment: gone · high \(unresolved\)/);
  assert.match(payload.message, /advanced draft: .*optimization=quality/);
  assert.match(payload.message, /preferredModels=\["keep-me"\]/);
  assert.deepEqual(payload.options.map(({ value }) => value), question.actions);
  assert.ok(payload.options.every(({ hint, label }) => hint?.length && label?.length));
  assert.equal(new Set(payload.options.map(({ hint }) => hint)).size, question.actions.length);

  const bare = routingPromptPayload({
    ...question,
    advancedDraft: null,
    selectedSurfaces: [],
    authorizedTransports: [],
    roster: [],
    standardRoutes: null,
  });
  assert.match(bare.message, /agent apps: none/);
  assert.match(bare.message, /transports: none/);
  assert.match(bare.message, /model roster: none/);
  assert.match(bare.message, /standard routes: none/);
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
  authorizedTransports: native('claude-code', 'codex'),
  switching: 'ask',
  roster: [entry('claude-opus-5', 'high', 'admitted')],
  inventoryRevision: null,
  standardRoutes: { ...NO_STANDARD_ROUTES, development: route('claude-opus-5', 'high') },
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
      project: narrowing({ selectedSurfaces: ['codex'] }),
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
      project: narrowing({ selectedSurfaces: ['codex'] }),
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
      project: narrowing({ selectedSurfaces: ['codex'] }),
    });
    await commitRoutingProfilePair({
      profileRoot, identity: FIXTURE_IDENTITY, global: storageProfile({ switching: 'automatic' }),
    });

    const composed = await readComposedRoutingProfile({ profileRoot, identity: FIXTURE_IDENTITY });
    assert.equal(composed.global.generation, 2);
    assert.equal(composed.global.profile.switching, 'automatic');
    assert.equal(composed.project.generation, 1);
    assert.deepEqual(composed.project.narrowing.selectedSurfaces, ['codex']);
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
    project: narrowing({ selectedSurfaces: ['codex'], switching: 'current-surface-only' }),
  };
  try {
    await commitRoutingProfilePair({
      profileRoot,
      identity: FIXTURE_IDENTITY,
      global: storageProfile(),
      project: narrowing({ selectedSurfaces: ['codex'] }),
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
    assert.equal(afterCrash.project.narrowing.switching, null);
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
    assert.equal(landed.project.narrowing.switching, 'current-surface-only');
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
      project: narrowing({ selectedSurfaces: ['codex'] }),
    });
    const composed = await readComposedRoutingProfile({ profileRoot, projectRoot: repo });
    assert.equal(composed.identity.key, identity.key);
    assert.deepEqual(composed.project.narrowing.selectedSurfaces, ['codex']);
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

test('the global document and the project narrowing are two field-by-field schemas', () => {
  assert.deepEqual(ROSTER_PAIR_STATES, ['admitted', 'declined', 'withdrawn']);
  assert.deepEqual(STANDARD_ROUTE_STATES, ['configured', 'unresolved']);

  const global = validateRoutingProfile(globalDocument());
  assert.deepEqual(Object.keys(global).sort(), [
    'advanced', 'authorizedTransports', 'consideredSurfaces', 'inventoryRevision',
    'registryRevision', 'roster', 'schemaVersion', 'selectedSurfaces', 'standardRoutes',
    'switching',
  ]);
  assert.equal(global.inventoryRevision, INVENTORY.revision);
  assert.deepEqual(global.authorizedTransports, globalDocument().authorizedTransports);

  const narrowed = validateRoutingNarrowing(narrowing({ switching: 'current-surface-only' }));
  assert.deepEqual(narrowed, {
    schemaVersion: 2,
    selectedSurfaces: null,
    authorizedTransports: null,
    switching: 'current-surface-only',
    roster: null,
    standardRoutes: null,
  });
  assert.deepEqual(
    validateRoutingNarrowing({ schemaVersion: 2 }),
    narrowed && { ...narrowed, switching: null },
  );
  assert.deepEqual(
    decodeRoutingNarrowing(narrowing({ roster: [pair('opus', 'high')] })).narrowing.roster,
    [pair('opus', 'high')],
  );

  const rejects = [
    [() => validateRoutingProfile({ ...globalDocument(), roster: [pair('opus', 'high')] }),
      /roster\[0\]\.state must be one of: admitted, declined, withdrawn/],
    [() => validateRoutingProfile({ ...globalDocument(), roster: [entry('opus', 'high', 'unknown')] }),
      /roster\[0\]\.state must be one of/],
    [() => validateRoutingProfile({
      ...globalDocument(),
      roster: [entry('opus', 'high', 'admitted'), entry('opus[1m]', 'high', 'declined')],
    }), /roster records the same pair twice with different states/],
    [() => validateRoutingProfile({ ...globalDocument(), authorizedTransports: undefined }),
      /authorizedTransports must be an array/],
    [() => validateRoutingProfile({
      ...globalDocument(), authorizedTransports: [{ surface: 'ghost', transport: 'native' }],
    }), /authorizedTransports\[0\]\.surface must be a selected surface: ghost/],
    [() => validateRoutingProfile({
      ...globalDocument(), authorizedTransports: [{ surface: 'codex', transport: 'native', extra: 1 }],
    }), /unknown authorizedTransports\[0\] field: extra/],
    [() => validateRoutingProfile({ ...globalDocument(), inventoryRevision: '' }),
      /inventoryRevision must be a non-empty string or null/],
    [() => validateRoutingProfile({
      ...globalDocument(),
      standardRoutes: { ...globalDocument().standardRoutes, mechanical: route('opus', 'low') },
    }), /standardRoutes\.mechanical must name an admitted roster pair/],
    [() => validateRoutingProfile({
      ...globalDocument(),
      standardRoutes: { ...globalDocument().standardRoutes, mechanical: pair('haiku', null) },
    }), /standardRoutes\.mechanical\.state must be one of: configured, unresolved/],
    [() => validateRoutingNarrowing({ ...narrowing(), registryRevision: 1 }),
      /unknown routing narrowing field: registryRevision/],
    [() => validateRoutingNarrowing(narrowing({ selectedSurfaces: [] })),
      /selectedSurfaces must not be empty/],
    [() => validateRoutingNarrowing({ ...narrowing(), schemaVersion: 1 }),
      /routing narrowing schemaVersion must be 2/],
    [() => decodeRoutingNarrowing({ schemaVersion: 99 }),
      /unsupported routing narrowing schemaVersion: 99/],
  ];
  for (const [run, message] of rejects) assert.throws(run, message);

  // An `unresolved` route may name a pair the roster no longer admits: the plan
  // requires roster validation to accept it instead of calling the profile broken.
  assert.deepEqual(validateRoutingProfile({
    ...globalDocument(),
    standardRoutes: { ...globalDocument().standardRoutes, judgment: route('gone', 'high', 'unresolved') },
  }).standardRoutes.judgment, route('gone', 'high', 'unresolved'));
});

test('a project narrowing that widens surfaces, transports or roster is rejected with a named reason', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  try {
    assert.deepEqual(narrowingViolations(globalDocument(), narrowing({
      selectedSurfaces: ['codex'],
      authorizedTransports: [{ surface: 'codex', transport: 'native' }],
      roster: [pair('gpt-5.6-sol', 'high')],
      switching: 'current-surface-only',
    })), []);

    assert.deepEqual(narrowingViolations(globalDocument(), narrowing({
      selectedSurfaces: ['claude-code', 'ghost'],
      authorizedTransports: [{ surface: 'claude-code', transport: 'claude-cli' }],
      roster: [pair('opus', 'low')],
      standardRoutes: { judgment: route('opus', 'low') },
    })), [
      { code: 'surface-not-authorized', surface: 'ghost' },
      { code: 'transport-not-authorized', surface: 'claude-code', transport: 'claude-cli' },
      { code: 'pair-not-authorized', model: 'opus', effort: 'low' },
      {
        code: 'standard-route-not-in-effective-roster',
        workload: 'judgment', model: 'opus', effort: 'low',
      },
    ]);

    await commitRoutingProfilePair({
      profileRoot, identity: FIXTURE_IDENTITY, global: globalDocument(),
    });
    await assert.rejects(commitRoutingProfilePair({
      profileRoot, identity: FIXTURE_IDENTITY,
      project: narrowing({ selectedSurfaces: ['claude-code', 'ghost'] }),
    }), /project narrowing widens the global authorization: surface-not-authorized:ghost/);

    const committed = await commitRoutingProfilePair({
      profileRoot, identity: FIXTURE_IDENTITY,
      project: narrowing({ selectedSurfaces: ['codex'], roster: [pair('gpt-5.6-sol', 'high')] }),
    });
    assert.deepEqual([committed.globalGeneration, committed.projectGeneration], [null, 1]);

    // Narrowing without a global authorization has nothing to narrow.
    const bare = await makeEmptyDir();
    await assert.rejects(commitRoutingProfilePair({
      profileRoot: join(bare, '.state'), identity: FIXTURE_IDENTITY,
      project: narrowing({ switching: 'current-surface-only' }),
    }), /no-global-authorization/);
    await cleanup(bare);
  } finally {
    await cleanup(consumer);
  }
});

test('switching narrows monotonically toward stricter and never loosens', () => {
  const strictest = (globalSwitching, projectSwitching) => composeRoutingProfile({
    global: globalDocument({ switching: globalSwitching }),
    project: narrowing({ switching: projectSwitching }),
  }).switching;

  assert.equal(strictest('automatic', 'ask'), 'ask');
  assert.equal(strictest('automatic', 'current-surface-only'), 'current-surface-only');
  assert.equal(strictest('ask', 'current-surface-only'), 'current-surface-only');
  assert.equal(strictest('ask', null), 'ask');
  assert.equal(strictest('ask', 'ask'), 'ask');

  for (const [globalSwitching, projectSwitching] of [
    ['ask', 'automatic'],
    ['current-surface-only', 'ask'],
    ['current-surface-only', 'automatic'],
  ]) {
    assert.deepEqual(
      narrowingViolations(globalDocument({ switching: globalSwitching }),
        narrowing({ switching: projectSwitching })),
      [{ code: 'switching-loosened', from: globalSwitching, to: projectSwitching }],
    );
  }
});

test('composition validates authorization only and never consults the Access graph', async () => {
  const source = await readFile('src/lib/routingProfile.mjs', 'utf8');
  for (const forbidden of [
    'routingAccessGraph.mjs', 'routingAccessGraphStore.mjs', 'routingResolver.mjs',
    'routeDispatcher.mjs', 'routingPolicy.mjs',
  ]) {
    assert.doesNotMatch(source, new RegExp(`from '\\./${forbidden.replace('.', '\\.')}'`), forbidden);
  }

  const composed = composeRoutingProfile({
    global: globalDocument(), project: narrowing({ selectedSurfaces: ['codex'] }), inventory: INVENTORY,
  });
  assert.deepEqual(Object.keys(composed).sort(), [
    'authorizedTransports', 'blocked', 'inventoryRevision', 'notes', 'roster',
    'rosterState', 'selectedSurfaces', 'standardRoutes', 'switching',
  ]);

  // Every inventory pair is attested `unknown` until a probe proves otherwise —
  // composition still authorizes them, because reachability is decided later.
  const { attestations } = presentInventory(INVENTORY, ['claude-code']);
  assert.ok(attestations.every(({ access }) => access === UNTESTED_ACCESS));
  assert.deepEqual(composed.roster, [pair('opus', 'high'), pair('haiku', null), pair('gpt-5.6-sol', 'high')]);
  assert.deepEqual(composed.selectedSurfaces, ['codex']);
  assert.deepEqual(composed.authorizedTransports, [{ surface: 'codex', transport: 'native' }]);
  assert.deepEqual(composed.blocked, []);
});

test('a global contraction narrows an older project override instead of invalidating it', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  try {
    await commitRoutingProfilePair({
      profileRoot, identity: FIXTURE_IDENTITY,
      global: globalDocument(),
      project: narrowing({
        selectedSurfaces: ['claude-code', 'codex'],
        roster: [pair('opus', 'high'), pair('gpt-5.6-sol', 'high')],
        standardRoutes: { judgment: route('opus', 'high') },
      }),
    });
    // The user later contracts the global authorization: one surface and the pair
    // that served the project's judgment route are gone.
    await commitRoutingProfilePair({
      profileRoot, identity: FIXTURE_IDENTITY,
      global: globalDocument({
        selectedSurfaces: ['codex'],
        authorizedTransports: native('codex'),
        roster: [entry('gpt-5.6-sol', 'high', 'admitted'), entry('opus', 'high', 'declined')],
        standardRoutes: {
          mechanical: null,
          development: route('gpt-5.6-sol', 'high'),
          judgment: route('gpt-5.6-sol', 'high'),
        },
      }),
    });

    const read = await readComposedRoutingProfile({
      profileRoot, identity: FIXTURE_IDENTITY, inventory: INVENTORY,
    });
    const composed = read.composed;
    assert.deepEqual(composed.selectedSurfaces, ['codex']);
    assert.deepEqual(composed.roster, [pair('gpt-5.6-sol', 'high')]);
    assert.deepEqual(composed.notes, [
      { code: 'narrowing-dropped-by-global-contraction', axis: 'surface', value: 'claude-code' },
      { code: 'narrowing-dropped-by-global-contraction', axis: 'pair', value: 'opus/high' },
      { code: 'standard-route-derived-unresolved', workload: 'judgment', model: 'opus', effort: 'high' },
    ]);
    assert.deepEqual(composed.standardRoutes.judgment, route('opus', 'high', 'unresolved'));
    assert.deepEqual(composed.standardRoutes.development, route('gpt-5.6-sol', 'high'));
    assert.deepEqual(composed.blocked, [
      { workload: 'mechanical', reason: 'standard-route-missing' },
      { workload: 'judgment', reason: 'standard-route-unresolved' },
    ]);
  } finally {
    await cleanup(consumer);
  }
});

test('the roster state machine has defined transitions against a recorded inventory revision', () => {
  const fresh = reconcileRosterState({ roster: [], inventoryRevision: null, inventory: INVENTORY });
  assert.equal(fresh.stale, true);
  assert.equal(fresh.inventoryRevision, INVENTORY.revision);
  assert.deepEqual(fresh.pending, [
    pair('opus', 'high'), pair('opus', 'low'), pair('haiku', null), pair('gpt-5.6-sol', 'high'),
  ]);
  assert.deepEqual(fresh.admitted, []);

  const recorded = [
    entry('opus', 'high', 'admitted'),
    entry('opus', 'low', 'declined'),
    entry('haiku', null, 'admitted'),
    entry('gpt-5.6-sol', 'high', 'admitted'),
  ];
  const settled = reconcileRosterState({
    roster: recorded, inventoryRevision: INVENTORY.revision, inventory: INVENTORY,
  });
  assert.equal(settled.stale, false);
  assert.deepEqual(settled.pending, []);
  assert.deepEqual(settled.declined, [pair('opus', 'low')]);
  assert.deepEqual(settled.newlyWithdrawn, []);

  // The inventory drops a pair: an admitted pair is withdrawn, a declined one
  // keeps its decline so it never prompts again when it comes back.
  const shrunk = reconcileRosterState({
    roster: recorded, inventoryRevision: INVENTORY.revision, inventory: SHRUNK_INVENTORY,
  });
  assert.equal(shrunk.stale, true);
  assert.deepEqual(shrunk.newlyWithdrawn, [pair('opus', 'high')]);
  assert.deepEqual(shrunk.withdrawn, [pair('opus', 'high')]);
  assert.deepEqual(shrunk.admitted, [pair('haiku', null), pair('gpt-5.6-sol', 'high')]);
  assert.deepEqual(shrunk.pending, []);
  assert.deepEqual(shrunk.reopenable, []);
  assert.deepEqual(
    shrunk.entries.find(({ model, effort }) => model === 'opus' && effort === 'high'),
    entry('opus', 'high', 'withdrawn'),
  );

  const droppedDecline = reconcileRosterState({
    roster: [entry('opus', 'high', 'declined')],
    inventoryRevision: INVENTORY.revision,
    inventory: SHRUNK_INVENTORY,
  });
  assert.deepEqual(droppedDecline.declined, [pair('opus', 'high')]);
  assert.deepEqual(droppedDecline.withdrawn, []);
  assert.deepEqual(droppedDecline.pending, [pair('opus', 'low'), pair('haiku', null), pair('gpt-5.6-sol', 'high')]);

  // A withdrawn pair the inventory lists again is reopenable, never silently
  // re-admitted: the Kit does not authorize on the user's behalf.
  const returned = reconcileRosterState({
    roster: [entry('opus', 'high', 'withdrawn')],
    inventoryRevision: SHRUNK_INVENTORY.revision,
    inventory: INVENTORY,
  });
  assert.deepEqual(returned.reopenable, [pair('opus', 'high')]);
  assert.deepEqual(returned.admitted, []);
  assert.equal(returned.pending.some(({ model, effort }) => model === 'opus' && effort === 'high'), false);

  assert.throws(() => reconcileRosterState({ roster: [], inventory: null }), /loaded inventory/);
});

test('the interview declares its question order and what the user sees at each stage', async () => {
  assert.deepEqual(ROUTING_INTERVIEW_SEQUENCE.map(({ id }) => id), [
    'surfaces', 'transports', 'switching', 'roster', 'standardRoutes', 'activation',
  ]);
  for (const stage of ROUTING_INTERVIEW_SEQUENCE) {
    assert.ok(stage.asks.length > 0, stage.id);
    assert.ok(stage.shows.length > 0, stage.id);
    assert.ok(stage.kinds.length > 0, stage.id);
  }
  // Every stage that can be skipped says when — an unexplained skip is a hole.
  assert.deepEqual(
    ROUTING_INTERVIEW_SEQUENCE.filter(({ skippedWhen }) => skippedWhen).map(({ id }) => id),
    ['transports', 'switching', 'roster', 'standardRoutes'],
  );

  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const asked = [];
  try {
    await setupRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      inventory: INVENTORY,
      currentSurface: 'claude-code',
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async (question) => {
        asked.push(question.kind);
        if (question.kind === 'surfaces') return ['claude-code', 'codex'];
        if (question.kind === 'transports') return native('claude-code', 'codex');
        if (question.kind === 'autonomy') return 'ask';
        if (question.kind === 'roster') return [pair('haiku', null)];
        if (question.kind === 'standard-route') return null;
        return 'approve';
      },
    });
    // The order that ran is the order the table declares.
    const declared = ROUTING_INTERVIEW_SEQUENCE.flatMap(({ kinds }) => kinds[0]);
    assert.deepEqual([...new Set(asked)], declared.filter((kind) => asked.includes(kind)));
    assert.deepEqual(asked, [
      'surfaces', 'transports', 'autonomy', 'roster',
      'standard-route', 'standard-route', 'standard-route', 'activation',
    ]);
  } finally {
    await cleanup(consumer);
  }
});

test('a long model-and-effort list stays navigable and says what leaving a pair out means', () => {
  const question = {
    kind: 'roster',
    message: 'Which model-and-effort pairs may the Kit use?',
    groups: [
      {
        surface: 'codex',
        label: 'Codex',
        detected: true,
        pairs: [pair('gpt-5.6-sol', 'high'), pair('gpt-5.6-sol', 'low')],
      },
      { surface: 'claude-code', label: 'Claude Code', detected: false, pairs: [pair('haiku', null)] },
    ],
    total: 3,
    preselected: [],
  };
  const payload = routingPromptPayload(question);
  assert.equal(payload.control, 'groupmultiselect');
  assert.deepEqual(Object.keys(payload.options), ['Codex', 'Claude Code']);
  assert.match(payload.message, /3 pairs/);
  assert.match(payload.message, /2 agent apps/);
  assert.match(payload.message, /declined/);
  const all = Object.values(payload.options).flat();
  assert.equal(all.length, 3);
  assert.ok(all.every(({ hint, label, value }) => hint?.length && label?.length && value?.length));
  assert.equal(new Set(all.map(({ value }) => value)).size, 3);
  assert.match(all[2].label, /no effort axis/);
  assert.equal(payload.required, false);

  const transports = routingPromptPayload({
    kind: 'transports',
    message: 'Which runtime may each agent app drive?',
    options: [
      { surface: 'codex', surfaceLabel: 'Codex', transport: 'native', native: true },
      { surface: 'codex', surfaceLabel: 'Codex', transport: 'claude-cli', native: false },
    ],
    preselected: [{ surface: 'codex', transport: 'native' }],
  });
  assert.equal(transports.control, 'multiselect');
  assert.deepEqual(transports.initialValues, [transports.options[0].value]);
  assert.match(transports.options[0].hint, /own runtime/);
  assert.match(transports.options[1].hint, /claude-cli/);
  assert.ok(transports.options.every(({ label }) => label.includes('Codex')));

  const standardRoute = routingPromptPayload({
    kind: 'standard-route',
    workload: 'judgment',
    message: 'Which pair decides judgment work when no evidence covers it?',
    options: [pair('gpt-5.6-sol', 'high'), pair('haiku', null)],
    current: null,
    pageSize: 10,
  });
  assert.equal(standardRoute.control, 'select');
  assert.equal(standardRoute.maxItems, 10);
  assert.equal(standardRoute.options.at(-1).value, 'none');
  assert.match(standardRoute.options.at(-1).hint, /no Standard route/);
  assert.equal(standardRoute.initialValue, 'none');
});

test('a declined pair is never offered again and a withdrawn pair blocks its Standard route', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const asked = [];
  try {
    await setupRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      inventory: INVENTORY,
      currentSurface: 'claude-code',
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async (question) => {
        if (question.kind === 'surfaces') return ['claude-code', 'codex'];
        if (question.kind === 'transports') return native('claude-code', 'codex');
        if (question.kind === 'autonomy') return 'ask';
        if (question.kind === 'roster') return [pair('opus', 'high'), pair('haiku', null)];
        if (question.kind === 'standard-route') {
          return question.workload === 'mechanical' ? pair('haiku', null) : pair('opus', 'high');
        }
        return 'approve';
      },
    });

    // The maintainer step drops the pair two Standard routes were nominating.
    const options = {
      consumerRoot: consumer,
      profileRoot,
      inventory: SHRUNK_INVENTORY,
      detectedSurfaceIds: ['claude-code', 'codex'],
    };
    const inspection = await inspectRoutingProfile(options);
    assert.deepEqual(inspection.reasons, ['roster-pair-withdrawn', 'standard-route-unresolved']);
    assert.deepEqual(inspection.delta.roster.withdrawn, [pair('opus', 'high')]);
    assert.deepEqual(inspection.delta.roster.pending, []);
    assert.deepEqual(inspection.delta.roster.unresolvedRoutes, [
      { workload: 'development', model: 'opus', effort: 'high' },
      { workload: 'judgment', model: 'opus', effort: 'high' },
    ]);

    const result = await reconcileRoutingProfile({
      ...options,
      prompt: async (question) => {
        asked.push(question.kind);
        if (question.kind === 'reconcile') return { action: 'apply', addSurfaceIds: [] };
        if (question.kind === 'standard-route') {
          // One class gets a replacement; the other is knowingly left unresolved.
          return question.workload === 'development' ? pair('haiku', null) : null;
        }
        throw new Error(`unexpected question: ${question.kind}`);
      },
    }, inspection);

    // The declined pairs are never offered again: no roster question at all.
    assert.deepEqual(asked, ['reconcile', 'standard-route', 'standard-route']);
    assert.equal(result.status, 'reconciled');
    assert.deepEqual(result.profile.roster, [
      entry('opus', 'high', 'withdrawn'),
      entry('opus', 'low', 'declined'),
      entry('haiku', null, 'admitted'),
      entry('gpt-5.6-sol', 'high', 'declined'),
    ]);
    assert.deepEqual(result.profile.standardRoutes, {
      mechanical: route('haiku', null),
      development: route('haiku', null),
      judgment: route('opus', 'high', 'unresolved'),
    });
    assert.equal(result.profile.inventoryRevision, SHRUNK_INVENTORY.revision);

    const composed = composeRoutingProfile({
      global: result.profile, inventory: SHRUNK_INVENTORY,
    });
    assert.deepEqual(composed.roster, [pair('haiku', null)]);
    assert.deepEqual(composed.blocked, [
      { workload: 'judgment', reason: 'standard-route-unresolved' },
    ]);

    // A settled `unresolved` route is a state, not a pending question: the next
    // run is quiet instead of asking forever.
    assert.equal((await inspectRoutingProfile(options)).status, 'still valid');
  } finally {
    await cleanup(consumer);
  }
});

test('a re-run asks only the stage whose answer changed', async () => {
  const consumer = await makeEmptyDir();
  const profileRoot = join(consumer, '.test-user-state');
  const grown = {
    revision: 'sha256-inventory-3',
    pairs: [...INVENTORY.pairs, { surface: 'codex', provider: 'openai', modelId: 'gpt-5.6-luna', effort: 'medium' }],
  };
  const asked = [];
  try {
    await setupRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      inventory: INVENTORY,
      currentSurface: 'claude-code',
      detectedSurfaceIds: ['claude-code', 'codex'],
      prompt: async (question) => {
        if (question.kind === 'surfaces') return ['claude-code', 'codex'];
        if (question.kind === 'transports') return native('claude-code', 'codex');
        if (question.kind === 'autonomy') return 'ask';
        if (question.kind === 'roster') return [pair('haiku', null)];
        if (question.kind === 'standard-route') return pair('haiku', null);
        return 'approve';
      },
    });

    // A revision bump alone changes nothing the user must answer.
    const quiet = await inspectRoutingProfile({
      consumerRoot: consumer,
      profileRoot,
      inventory: { ...INVENTORY, revision: 'sha256-inventory-1b' },
      detectedSurfaceIds: ['claude-code', 'codex'],
    });
    assert.deepEqual(quiet.reasons, []);
    assert.equal(quiet.status, 'still valid');

    const options = {
      consumerRoot: consumer,
      profileRoot,
      inventory: grown,
      detectedSurfaceIds: ['claude-code', 'codex'],
    };
    const inspection = await inspectRoutingProfile(options);
    assert.deepEqual(inspection.reasons, ['roster-pairs-unrecorded']);
    const result = await reconcileRoutingProfile({
      ...options,
      prompt: async (question) => {
        asked.push(question);
        if (question.kind === 'reconcile') return { action: 'apply', addSurfaceIds: [] };
        if (question.kind === 'roster') {
          // Only the one new pair is offered — every other answer still stands.
          assert.deepEqual(question.groups.flatMap(({ pairs }) => pairs), [pair('gpt-5.6-luna', 'medium')]);
          return [pair('gpt-5.6-luna', 'medium')];
        }
        throw new Error(`unexpected question: ${question.kind}`);
      },
    }, inspection);

    assert.deepEqual(asked.map(({ kind }) => kind), ['reconcile', 'roster']);
    assert.equal(result.profile.selectedSurfaces.length, 2);
    assert.equal(result.profile.switching, 'ask');
    assert.deepEqual(result.profile.standardRoutes.mechanical, route('haiku', null));
    assert.deepEqual(
      result.profile.roster.filter(({ state }) => state === 'admitted'),
      [entry('haiku', null, 'admitted'), entry('gpt-5.6-luna', 'medium', 'admitted')],
    );
    assert.equal(result.profile.inventoryRevision, grown.revision);
    assert.equal((await inspectRoutingProfile(options)).status, 'still valid');
  } finally {
    await cleanup(consumer);
  }
});
