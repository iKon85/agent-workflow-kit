import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from '../src/commands/init.mjs';
import { update } from '../src/commands/update.mjs';
import { activateCandidate } from '../src/lib/updateCandidate.mjs';
import {
  ROUTING_PROFILE_PATH,
  inspectRoutingProfile,
  readRoutingProfile,
  reconcileRoutingProfile,
  routingProfilePath,
  setupRoutingProfile,
} from '../src/lib/routingProfile.mjs';
import {
  AGENT_SURFACE_REGISTRY,
  detectAgentSurfaces,
} from '../src/lib/agentSurfaceRegistry.mjs';
import { makeKit, makeEmptyDir, cleanup } from './helpers.mjs';
import { PACKAGE_MANIFEST_NAME, readManifest, writeManifest } from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';

const P = '.claude/skills/to-prd/SKILL.md';
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const verify = async () => {};

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
      schemaVersion: 1,
      registryRevision: 1,
      selectedSurfaces: ['claude-code', 'codex'],
      consideredSurfaces: ['claude-code', 'codex'],
      switching: 'ask',
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
      optimization: 'quality',
      preferredModels: ['optional-user-choice'],
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
      schemaVersion: 1,
      registryRevision: 1,
      selectedSurfaces: ['claude-code'],
      consideredSurfaces: ['claude-code', 'codex'],
      switching: 'automatic',
      advanced,
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
    assert.deepEqual(await readRoutingProfile(consumer, profileRoot), concurrent);
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
    assert.deepEqual(await readRoutingProfile(consumer, profileRoot), concurrent);
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
