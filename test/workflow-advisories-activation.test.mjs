import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { HELPER_FILES } from '../src/lib/bundle.mjs';

const CLAUDE = resolve('.claude/skills/setup-workflow');
const CODEX = resolve('.agents/skills/setup-workflow');

async function loadEffects() {
  const seed = await readFile(join(CLAUDE, 'workflow-advisories.md'), 'utf8');
  const match = seed.match(/```json workflow-advisories-setup-effects\n([\s\S]*?)\n```/);
  assert.ok(match, 'missing structured Workflow Advisories setup contract');
  return Object.fromEntries(JSON.parse(match[1]).map((row) => [row.state, row]));
}

const hookCommands = [
  'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/recon-size-hint.py"',
  'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/baseline-capture-hint.py"',
  'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/pre-refactor-sweep.py"',
  '"$CLAUDE_PROJECT_DIR/.claude/hooks/typecheck-on-stop.sh"',
  'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/convention-drift-hint.py"',
  'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/migration-snapshot-reminder.py"',
  'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/loc-offender-forewarn.py"',
];

async function reconcile(root, effect) {
  const profilePath = join(root, 'docs/agents/workflow-capabilities.json');
  const settingsPath = join(root, '.claude/settings.json');
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await mkdir(join(root, '.claude'), { recursive: true });
  let profile = {};
  try { profile = JSON.parse(await readFile(profilePath, 'utf8')); } catch {}
  let settings = { consumerSetting: 'keep', hooks: {} };
  try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch {}

  for (const operation of effect.operations) {
    if (operation === 'record-choice') {
      profile.workflowAdvisories ??= {};
      profile.workflowAdvisories.choice = effect.choice;
    } else if (operation === 'reconcile-profile-enabled') {
      profile.workflowAdvisories = {
        ...profile.workflowAdvisories,
        choice: 'yes',
        enabled: true,
      };
    } else if (operation === 'reconcile-hook-wiring') {
      settings.hooks.workflowAdvisories = [...hookCommands];
    } else if (operation === 'remove-hook-wiring') {
      delete settings.hooks.workflowAdvisories;
    } else if (operation === 'update-profile-disabled') {
      profile.workflowAdvisories.enabled = false;
    } else if (operation === 'adopt-existing') {
      assert.ok(profile.workflowAdvisories);
    }
  }
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { profilePath, settingsPath };
}

test('workflow advisory activation is idempotent and preserves consumer profile data', async (t) => {
  const effects = await loadEffects();
  assert.deepEqual(Object.keys(effects).sort(), ['disable', 'existing', 'later', 'missing', 'no', 'yes']);
  for (const state of ['yes', 'later', 'no', 'existing', 'disable']) {
    const root = await mkdtemp(join(tmpdir(), `awkit-advisory-activation-${state}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    if (state === 'existing' || state === 'disable') {
      await mkdir(join(root, 'docs/agents'), { recursive: true });
      await writeFile(join(root, 'docs/agents/workflow-capabilities.json'), JSON.stringify({
        consumerKey: 'keep',
        workflowAdvisories: { enabled: true, choice: 'yes', unknownKey: 'keep' },
      }));
    }
    const paths = await reconcile(root, effects[state]);
    const first = await Promise.all([readFile(paths.profilePath), readFile(paths.settingsPath)]);
    await reconcile(root, effects[state]);
    const second = await Promise.all([readFile(paths.profilePath), readFile(paths.settingsPath)]);
    assert.deepEqual(second, first, `${state} rerun changed bytes`);
    const profile = JSON.parse(first[0]);
    if (state === 'yes') assert.equal(profile.workflowAdvisories.enabled, true);
    if (state === 'existing' || state === 'disable') {
      assert.equal(profile.consumerKey, 'keep');
      assert.equal(profile.workflowAdvisories.unknownKey, 'keep');
    }
    if (state === 'disable') assert.equal(profile.workflowAdvisories.enabled, false);
  }
});

test('setup contract mirrors and ships the complete 6a helper unit', async () => {
  assert.equal(
    await readFile(join(CODEX, 'workflow-advisories.md'), 'utf8'),
    await readFile(join(CLAUDE, 'workflow-advisories.md'), 'utf8'),
  );
  for (const surface of [CLAUDE, CODEX]) {
    const skill = await readFile(join(surface, 'SKILL.md'), 'utf8');
    assert.match(skill, /Workflow Advisories/);
    assert.match(skill, /yes \/ later \/ no \/ existing \/ disable/);
  }
  const shipped = new Set(HELPER_FILES.map(({ path }) => path));
  for (const path of [
    'scripts/workflow-advisories/core.py',
    'scripts/workflow-advisories/capabilities.json',
    '.claude/hooks/recon-size-hint.py',
    '.claude/hooks/baseline-capture-hint.py',
    '.claude/hooks/pre-refactor-sweep.py',
    '.claude/hooks/typecheck-on-stop.py',
    '.claude/hooks/typecheck-on-stop.sh',
    '.claude/hooks/convention-drift-hint.py',
    '.claude/hooks/migration-snapshot-reminder.py',
    '.claude/hooks/loc-offender-forewarn.py',
  ]) assert.equal(shipped.has(path), true, path);
});
