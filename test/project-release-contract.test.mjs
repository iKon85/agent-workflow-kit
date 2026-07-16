import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRepositoryFacts } from '../scripts/project-release.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

test('kit-release reuses the shared SemVer preview and apply engine', async () => {
  const source = await readFile(join(REPO, 'scripts/kit-release.mjs'), 'utf8');
  assert.match(source, /from '\.\.\/src\/lib\/semver\.mjs'/);
  assert.match(source, /from '\.\.\/src\/lib\/release-preview\.mjs'/);
  assert.match(source, /from '\.\.\/src\/lib\/release-apply\.mjs'/);
  assert.doesNotMatch(source, /export function nextVersion/);
});

test('project-release is a shipped dual-surface own-work entry point with one engine', async () => {
  const [manifestText, provenance, claude, codex, installManifest] = await Promise.all([
    readFile(join(REPO, '.claude/skills/skill-manifest.json'), 'utf8'),
    readFile(join(REPO, 'PROVENANCE.md'), 'utf8'),
    readFile(join(REPO, '.claude/skills/project-release/SKILL.md'), 'utf8'),
    readFile(join(REPO, '.agents/skills/project-release/SKILL.md'), 'utf8'),
    readFile(join(REPO, 'agent-workflow-kit.package.json'), 'utf8'),
  ]);
  assert.deepEqual(JSON.parse(manifestText).skills['project-release'], {
    class: 'generic',
    publish: true,
    entryPoint: true,
    surfaces: ['claude', 'codex'],
    provenance: 'own',
  });
  assert.match(provenance, /Own work[\s\S]*project-release/);
  assert.equal(codex, claude);
  for (const token of [
    'docs/agents/workflow-capabilities.json',
    'node scripts/project-release.mjs preview',
    'node scripts/project-release.mjs apply',
    '--confirm',
    'does not commit, tag, push, publish, or merge',
  ]) assert.match(claude, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const paths = JSON.parse(installManifest).files.map(({ path }) => path);
  for (const path of [
    'src/lib/release-apply.mjs',
    'scripts/project-release.mjs',
    '.claude/skills/project-release/SKILL.md',
    '.agents/skills/project-release/SKILL.md',
  ]) assert.ok(paths.includes(path), `missing shipped path ${path}`);
});

test('repository facts include staged, unstaged, renamed, and untracked targets plus tags', () => {
  const calls = [];
  const facts = readRepositoryFacts('/consumer', (_root, args) => {
    calls.push(args);
    if (args[0] === 'status') {
      return ' M package.json\0A  packages/api/package.json\0R  packages/new/package.json\0packages/old/package.json\0?? packages/fresh/package.json\0';
    }
    return 'v1.0.0\nv2.0.0\n';
  });
  assert.deepEqual(facts, {
    dirtyPaths: [
      'package.json',
      'packages/api/package.json',
      'packages/new/package.json',
      'packages/fresh/package.json',
    ],
    existingTags: ['v1.0.0', 'v2.0.0'],
  });
  assert.deepEqual(calls[0], [
    'status', '--porcelain=v1', '-z', '--untracked-files=all',
  ]);
});
