import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  inspectProjectSkillExtension,
} from '../src/lib/projectSkillExtension.mjs';

async function workspace() {
  return mkdtemp(join(tmpdir(), 'project-skill-extension-'));
}

async function write(root, path, body) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), body);
}

test('a versioned Project extension resolves under its canonical skill identity', async () => {
  const root = await workspace();
  try {
    await write(
      root,
      'docs/agents/skills/tdd.md',
      '<!-- agent-workflow-kit: project-extension/v1; skill=tdd -->\n# Local TDD policy\n',
    );
    assert.deepEqual(await inspectProjectSkillExtension({ root, skill: 'tdd' }), {
      state: 'active',
      schemaVersion: 1,
      path: 'docs/agents/skills/tdd.md',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an all-sections extension stays inactive until every section has instructions', async () => {
  const root = await workspace();
  const marker = '<!-- agent-workflow-kit: project-extension/v1; skill=orchestrate-wave -->';
  const activation = {
    mode: 'all-sections-filled',
    sections: ['§Setup', '§Landing'],
  };
  try {
    await write(
      root,
      'docs/agents/skills/orchestrate-wave.md',
      [
        marker,
        '# Project layer',
        '',
        'Explanatory boilerplate does not activate the recipe.',
        '',
        '## §Setup',
        '<!-- Add setup instructions. -->',
        '',
        '## §Landing',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      await inspectProjectSkillExtension({ root, skill: 'orchestrate-wave', activation }),
      {
        state: 'inactive',
        reason: 'sections-unfilled',
        schemaVersion: 1,
        path: 'docs/agents/skills/orchestrate-wave.md',
        missingSections: ['§Setup', '§Landing'],
      },
    );

    await write(
      root,
      'docs/agents/skills/orchestrate-wave.md',
      [
        marker,
        '# Project layer',
        '',
        '## §Setup',
        '- TODO',
        '',
        '## §Landing',
        '* [ ] TBD.',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      await inspectProjectSkillExtension({ root, skill: 'orchestrate-wave', activation }),
      {
        state: 'inactive',
        reason: 'sections-unfilled',
        schemaVersion: 1,
        path: 'docs/agents/skills/orchestrate-wave.md',
        missingSections: ['§Setup', '§Landing'],
      },
    );

    await write(
      root,
      'docs/agents/skills/orchestrate-wave.md',
      [
        marker,
        '# Project layer',
        '',
        '## §Setup',
        '<command>',
        '',
        '## §Landing',
        '<script>',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      await inspectProjectSkillExtension({ root, skill: 'orchestrate-wave', activation }),
      {
        state: 'inactive',
        reason: 'sections-unfilled',
        schemaVersion: 1,
        path: 'docs/agents/skills/orchestrate-wave.md',
        missingSections: ['§Setup', '§Landing'],
      },
    );

    await write(
      root,
      'docs/agents/skills/orchestrate-wave.md',
      [
        marker,
        '# Project layer',
        '',
        '## §Setup',
        '~~~sh',
        '~~~',
        '',
        '## §Landing',
        'TODO',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      await inspectProjectSkillExtension({ root, skill: 'orchestrate-wave', activation }),
      {
        state: 'inactive',
        reason: 'sections-unfilled',
        schemaVersion: 1,
        path: 'docs/agents/skills/orchestrate-wave.md',
        missingSections: ['§Setup', '§Landing'],
      },
    );

    await write(
      root,
      'docs/agents/skills/orchestrate-wave.md',
      [
        marker,
        '# Project layer',
        '',
        '## §Setup',
        'Run `tool <input >output`.',
        '',
        '## §Landing',
        '<details>',
        'Use `scripts/wrapup-land.py`.',
        '</details>',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      await inspectProjectSkillExtension({ root, skill: 'orchestrate-wave', activation }),
      {
        state: 'active',
        schemaVersion: 1,
        path: 'docs/agents/skills/orchestrate-wave.md',
      },
    );

    await write(
      root,
      'docs/agents/skills/orchestrate-wave.md',
      [
        marker,
        '# Project layer',
        '',
        '## §Setup',
        '```sh',
        '```',
        '',
        '## §Landing',
        'Run `<command>`.',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      await inspectProjectSkillExtension({ root, skill: 'orchestrate-wave', activation }),
      {
        state: 'inactive',
        reason: 'sections-unfilled',
        schemaVersion: 1,
        path: 'docs/agents/skills/orchestrate-wave.md',
        missingSections: ['§Setup', '§Landing'],
      },
    );

    await write(
      root,
      'docs/agents/skills/orchestrate-wave.md',
      [
        marker,
        '# Project layer',
        '',
        '## §Setup',
        'Run `npm install --no-package-lock`.',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      await inspectProjectSkillExtension({ root, skill: 'orchestrate-wave', activation }),
      {
        state: 'inactive',
        reason: 'sections-unfilled',
        schemaVersion: 1,
        path: 'docs/agents/skills/orchestrate-wave.md',
        missingSections: ['§Landing'],
      },
    );

    await write(
      root,
      'docs/agents/skills/orchestrate-wave.md',
      [
        marker,
        '# Project layer',
        '',
        '## §Setup',
        'Run `npm install --no-package-lock`.',
        '',
        '## §Landing',
        'Use `scripts/wrapup-land.py`.',
        '',
      ].join('\n'),
    );
    assert.deepEqual(
      await inspectProjectSkillExtension({ root, skill: 'orchestrate-wave', activation }),
      {
        state: 'active',
        schemaVersion: 1,
        path: 'docs/agents/skills/orchestrate-wave.md',
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('absent and setup stubs are inactive while legacy non-empty layers remain compatible', async () => {
  const root = await workspace();
  try {
    assert.deepEqual(await inspectProjectSkillExtension({ root, skill: 'tdd' }), {
      state: 'inactive',
      reason: 'absent',
    });
    await write(
      root,
      'docs/agents/skills/tdd.md',
      '<!-- setup-workflow: state=stub -->\n',
    );
    assert.deepEqual(await inspectProjectSkillExtension({ root, skill: 'tdd' }), {
      state: 'inactive',
      reason: 'stub',
    });
    await write(root, 'docs/agents/skills/tdd.md', '# TDD Project Notes\n');
    assert.deepEqual(await inspectProjectSkillExtension({ root, skill: 'tdd' }), {
      state: 'active',
      schemaVersion: 0,
      path: 'docs/agents/skills/tdd.md',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unknown schema, mismatched identity, and non-regular files block actionably', async () => {
  const root = await workspace();
  try {
    await write(
      root,
      'docs/agents/skills/tdd.md',
      '<!-- agent-workflow-kit: project-extension/v2; skill=tdd -->\n# Future\n',
    );
    await assert.rejects(
      inspectProjectSkillExtension({ root, skill: 'tdd' }),
      /unsupported schema.*expected project-extension\/v1/,
    );
    await write(
      root,
      'docs/agents/skills/tdd.md',
      '<!-- agent-workflow-kit: project-extension/v1; skill=local-ci -->\n# Wrong\n',
    );
    await assert.rejects(
      inspectProjectSkillExtension({ root, skill: 'tdd' }),
      /identity mismatch.*expected skill=tdd/,
    );
    await write(
      root,
      'docs/agents/skills/tdd.md',
      '<!-- agent-workflow-kit: project-extension/v1; skill=tdd -->\n' +
      '# Policy\n\n## Commands\nOne.\n\n## Commands\nTwo.\n',
    );
    await assert.rejects(
      inspectProjectSkillExtension({
        root,
        skill: 'tdd',
        activation: { mode: 'all-sections-filled', sections: ['Commands'] },
      }),
      /duplicate section Commands/,
    );
    await rm(join(root, 'docs/agents/skills/tdd.md'));
    await mkdir(join(root, 'docs/agents/skills/tdd.md'));
    await assert.rejects(
      inspectProjectSkillExtension({ root, skill: 'tdd' }),
      /not a regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('every published skill surface carries the same universal Project extension preflight', async () => {
  const root = join(import.meta.dirname, '..');
  const manifest = JSON.parse(
    await readFile(join(root, '.claude/skills/skill-manifest.json'), 'utf8'),
  );
  for (const [skill, declaration] of Object.entries(manifest.skills)) {
    if (!declaration.publish) continue;
    for (const surface of declaration.surfaces) {
      const base = surface === 'claude' ? '.claude/skills' : '.agents/skills';
      const body = await readFile(join(root, base, skill, 'SKILL.md'), 'utf8');
      assert.ok(
        body.includes(
          `node scripts/project-skill-extension.mjs inspect --skill ${skill} --json`,
        ),
        `${surface}:${skill}`,
      );
      assert.match(body, /Project extensions may specialize Project details/);
      assert.match(body, /a contradiction blocks and requires an Explicit fork/i);
    }
  }
});
