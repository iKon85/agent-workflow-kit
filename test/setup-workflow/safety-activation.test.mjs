import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { HELPER_FILES } from '../../src/lib/bundle.mjs';
import { buildKit } from '../../scripts/build-kit.mjs';

const CLAUDE = resolve('.claude/skills/setup-workflow');
const CODEX = resolve('.agents/skills/setup-workflow');
const TESTREPORTER = resolve('test/fixtures/safety-guardrails/testreporter.json');
const GENERIC = resolve('test/fixtures/safety-guardrails/generic.json');

async function contract() {
  const seed = await readFile(join(CLAUDE, 'safety-guardrails.md'), 'utf8');
  const effects = seed.match(/```json safety-guardrails-setup-effects\n([\s\S]*?)\n```/);
  const capabilities = seed.match(/```json safety-guardrails-capabilities\n([\s\S]*?)\n```/);
  assert.ok(effects, 'missing structured Safety Guardrails setup effects');
  assert.ok(capabilities, 'missing counted Safety Guardrails capability map');
  return {
    effects: Object.fromEntries(JSON.parse(effects[1]).map((row) => [row.state, row])),
    capabilities: JSON.parse(capabilities[1]),
  };
}

async function reconcile(root, effect, defaults) {
  const profilePath = join(root, 'docs/agents/workflow-capabilities.json');
  const settingsPath = join(root, '.claude/settings.json');
  const gitConfigPath = join(root, '.git-config-fixture.json');
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await mkdir(join(root, '.claude'), { recursive: true });
  let profile = { consumerKey: 'keep' };
  let settings = { consumerSetting: 'keep', hooks: {} };
  let gitConfig = { consumerSetting: 'keep' };
  try { profile = JSON.parse(await readFile(profilePath, 'utf8')); } catch {}
  try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch {}
  try { gitConfig = JSON.parse(await readFile(gitConfigPath, 'utf8')); } catch {}

  const staged = structuredClone(profile);
  for (const operation of effect.operations) {
    if (operation === 'record-choice') {
      staged.safetyGuardrails ??= {};
      staged.safetyGuardrails.choice = effect.choice;
    } else if (operation === 'stage-enabled-profile') {
      staged.safetyGuardrails = {
        ...defaults,
        ...staged.safetyGuardrails,
        choice: 'yes',
        enabled: true,
      };
    } else if (operation === 'stage-agent-hook-wiring') {
      settings.hooks.safetyGuardrails = [
        'grep-shim-guard.py',
      ];
    } else if (operation === 'stage-git-hook-wiring') {
      gitConfig['core.hooksPath'] = staged.safetyGuardrails.repositorySecurity.gitHooks.hooksPath;
    } else if (operation === 'activate-staged-profile') {
      profile = staged;
    } else if (operation === 'remove-agent-hook-wiring') {
      delete settings.hooks.safetyGuardrails;
    } else if (operation === 'remove-git-hook-wiring') {
      delete gitConfig['core.hooksPath'];
    } else if (operation === 'update-profile-disabled') {
      staged.safetyGuardrails.enabled = false;
      profile = staged;
    } else if (operation === 'adopt-existing') {
      assert.ok(profile.safetyGuardrails);
    }
  }
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  await writeFile(gitConfigPath, `${JSON.stringify(gitConfig, null, 2)}\n`);
  return { profile, settings, gitConfig };
}

test('setup exposes exactly four independently counted Safety capabilities', async () => {
  // The secrets / packageManager / doubleBackground agent adapters were
  // retired by the 2026-07 hook review (no named incident).
  const { capabilities } = await contract();
  assert.deepEqual(capabilities.map(({ id }) => id), [
    'searchShim',
    'gitHooks',
    'gitleaks',
    'dependencyAudit',
  ]);
  assert.ok(capabilities.every(({ profilePath, artifact }) => profilePath && artifact));
});

test('frozen Testreporter and generic profiles make different row decisions', async () => {
  const testreporter = JSON.parse(await readFile(TESTREPORTER, 'utf8'));
  const generic = JSON.parse(await readFile(GENERIC, 'utf8'));
  assert.equal(testreporter.safetyGuardrails.repositorySecurity.dependencyAudit.packageManager, 'pnpm');
  assert.equal(generic.safetyGuardrails.repositorySecurity.dependencyAudit.packageManager, 'yarn');
  assert.equal(testreporter.safetyGuardrails.gitHooks, undefined);
  assert.equal(generic.safetyGuardrails.doubleBackground.enabled, false);
  assert.equal(generic.safetyGuardrails.repositorySecurity.gitHooks.enabled, false);
  assert.equal(generic.safetyGuardrails.repositorySecurity.gitleaks.required, true);
});

test('activation is idempotent, opt-in, and removes wiring before disable', async (t) => {
  const { effects } = await contract();
  assert.deepEqual(Object.keys(effects).sort(), ['disable', 'existing', 'later', 'missing', 'no', 'yes']);
  const frozen = JSON.parse(await readFile(TESTREPORTER, 'utf8'));
  for (const state of ['yes', 'later', 'no', 'existing', 'disable']) {
    const root = await mkdtemp(join(tmpdir(), `awkit-safety-activation-${state}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    if (state === 'existing' || state === 'disable') {
      await mkdir(join(root, 'docs/agents'), { recursive: true });
      await writeFile(join(root, 'docs/agents/workflow-capabilities.json'), JSON.stringify({
        consumerKey: 'keep',
        safetyGuardrails: { ...frozen.safetyGuardrails, unknownKey: 'keep' },
      }));
    }
    const first = await reconcile(root, effects[state], frozen.safetyGuardrails);
    const second = await reconcile(root, effects[state], frozen.safetyGuardrails);
    assert.deepEqual(second, first, `${state} rerun changed state`);
    assert.equal(first.profile.consumerKey, 'keep');
    if (state === 'yes') {
      assert.equal(first.profile.safetyGuardrails.enabled, true);
      assert.ok(first.settings.hooks.safetyGuardrails);
      assert.equal(first.gitConfig['core.hooksPath'], '.githooks');
    } else if (state === 'later' || state === 'no') {
      assert.equal(first.settings.hooks.safetyGuardrails, undefined);
      assert.equal(first.gitConfig['core.hooksPath'], undefined);
    } else {
      assert.equal(first.profile.safetyGuardrails.unknownKey, 'keep');
    }
    if (state === 'disable') {
      assert.equal(first.profile.safetyGuardrails.enabled, false);
      assert.equal(first.settings.hooks.safetyGuardrails, undefined);
      assert.equal(first.gitConfig['core.hooksPath'], undefined);
    }
  }
});

test('Claude-first setup contract mirrors and ships all Safety primitives', async () => {
  assert.equal(
    await readFile(join(CODEX, 'safety-guardrails.md'), 'utf8'),
    await readFile(join(CLAUDE, 'safety-guardrails.md'), 'utf8'),
  );
  assert.equal(
    await readFile(join(CODEX, 'SKILL.md'), 'utf8'),
    await readFile(join(CLAUDE, 'SKILL.md'), 'utf8'),
  );
  const shipped = new Set(HELPER_FILES.map(({ path }) => path));
  for (const path of [
    'scripts/safety-guardrails/core.py',
    'scripts/safety-guardrails/search.py',
    '.claude/hooks/_safety_guard.py',
    '.claude/hooks/grep-shim-guard.py',
    'scripts/security/install-git-hooks.mjs',
    'scripts/security/ensure-gitleaks.mjs',
    'scripts/security/gitleaks-profile.json',
    'scripts/security/audit-gate.mjs',
  ]) assert.equal(shipped.has(path), true, path);
});

test('published Safety unit is self-contained and excludes consumer fixtures or secret values', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'awkit-safety-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await buildKit({ repoRoot: resolve('.'), distDir: dist });
  const manifest = JSON.parse(await readFile(join(dist, 'agent-workflow-kit.package.json'), 'utf8'));
  const paths = manifest.files.map(({ path }) => path);
  assert.ok(paths.includes('.claude/skills/setup-workflow/safety-guardrails.md'));
  assert.ok(paths.includes('.agents/skills/setup-workflow/safety-guardrails.md'));
  assert.ok(paths.every((path) => !path.startsWith('test/fixtures/')));
  const shippedProfile = await readFile(
    join(dist, '.claude/skills/setup-workflow/safety-guardrails.md'),
    'utf8',
  );
  assert.doesNotMatch(shippedProfile, /fixture-value-must-never-appear|CENSUS_SECRET_CANARY/);
  assert.doesNotMatch(
    await readFile(join(dist, 'scripts/safety-guardrails/core.py'), 'utf8'),
    /test\/fixtures|testreporter/i,
  );
});
