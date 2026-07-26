import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const CLAUDE = resolve('.claude/skills/setup-workflow');
const CODEX = resolve('.agents/skills/setup-workflow');

async function loadEffects() {
  const seed = await readFile(join(CLAUDE, 'worktree-lifecycle.md'), 'utf8');
  const match = seed.match(/```json worktree-lifecycle-setup-effects\n([\s\S]*?)\n```/);
  assert.ok(match, 'missing structured Worktree Lifecycle setup contract');
  return Object.fromEntries(JSON.parse(match[1]).map((row) => [row.state, row]));
}

const hookCommands = [
  'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/branch-context.py"',
  'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/branch-watch.py"',
  'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-worktree.py"',
  'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-worktree-cwd.py"',
  'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-worktree-discipline.py"',
  'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/slice-handoff-hint.py"',
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
      profile.worktreeLifecycle ??= {};
      profile.worktreeLifecycle.choice = effect.choice;
    } else if (operation === 'reconcile-profile-enabled') {
      profile.worktreeLifecycle = {
        worktreeRoot: '.worktrees',
        branchTemplate: '{type}/{issue}-{slug}',
        pathTemplate: '{type}-{issue}-{slug}',
        branchRegex: '^(?:feat|fix|chore|docs)/(?P<issue>\\d+)-',
        mainBranches: ['main', 'master'],
        protectedBranches: ['main', 'master'],
        scratchPatterns: [],
        setupEntry: 'python3 scripts/worktree-lifecycle/setup.py',
        setupSteps: [],
        ...profile.worktreeLifecycle,
        choice: 'yes',
        enabled: true,
      };
    } else if (operation === 'reconcile-hook-wiring') {
      settings.hooks.worktreeLifecycle = [...hookCommands];
    } else if (operation === 'remove-hook-wiring') {
      delete settings.hooks.worktreeLifecycle;
    } else if (operation === 'update-profile-disabled') {
      profile.worktreeLifecycle.enabled = false;
    } else if (operation === 'adopt-existing') {
      assert.ok(profile.worktreeLifecycle, 'existing state needs a profile');
    } else {
      throw new Error(`unknown operation: ${operation}`);
    }
  }

  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`);
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { profilePath, settingsPath };
}

test('yes/later/no/existing/disable activation matrix is idempotent and preserves consumer data', async (t) => {
  const effects = await loadEffects();
  assert.deepEqual(Object.keys(effects).sort(), ['disable', 'existing', 'later', 'missing', 'no', 'yes']);

  for (const state of ['yes', 'later', 'no', 'existing', 'disable']) {
    const root = await mkdtemp(join(tmpdir(), `awkit-activation-${state}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    if (state === 'existing' || state === 'disable') {
      await mkdir(join(root, 'docs/agents'), { recursive: true });
      await writeFile(join(root, 'docs/agents/workflow-capabilities.json'), JSON.stringify({
        consumerKey: 'keep',
        worktreeLifecycle: {
          enabled: true,
          choice: 'yes',
          unknownKey: 'keep',
          scratchPatterns: ['LOCAL-PLAN.md'],
        },
      }));
    }
    const paths = await reconcile(root, effects[state]);
    const first = await Promise.all([readFile(paths.profilePath), readFile(paths.settingsPath)]);
    await reconcile(root, effects[state]);
    const second = await Promise.all([readFile(paths.profilePath), readFile(paths.settingsPath)]);
    assert.deepEqual(second, first, `${state} rerun changed bytes`);
    const profile = JSON.parse(first[0]);
    if (state === 'yes') assert.equal(profile.worktreeLifecycle.enabled, true);
    if (state === 'later' || state === 'no') assert.equal(profile.worktreeLifecycle.enabled, undefined);
    if (state === 'existing' || state === 'disable') {
      assert.equal(profile.consumerKey, 'keep');
      assert.equal(profile.worktreeLifecycle.unknownKey, 'keep');
      assert.deepEqual(profile.worktreeLifecycle.scratchPatterns, ['LOCAL-PLAN.md']);
    }
    if (state === 'disable') assert.equal(profile.worktreeLifecycle.enabled, false);
  }
});

test('setup-workflow carries the same Worktree Lifecycle contract on both surfaces', async () => {
  assert.equal(
    await readFile(join(CODEX, 'worktree-lifecycle.md'), 'utf8'),
    await readFile(join(CLAUDE, 'worktree-lifecycle.md'), 'utf8'),
  );
  for (const surface of [CLAUDE, CODEX]) {
    const skill = await readFile(join(surface, 'SKILL.md'), 'utf8');
    assert.match(skill, /yes \/ later \/ no \/ existing \/ disable/);
    assert.match(skill, /docs\/agents\/workflow-capabilities\.json/);
  }
});
