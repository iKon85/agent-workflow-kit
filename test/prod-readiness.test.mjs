import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { makeEmptyDir, cleanup } from './helpers.mjs';

const exec = promisify(execFile);
const repo = join(import.meta.dirname, '..');

async function write(root, path, body) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
}

async function readiness(root, ...args) {
  return exec(process.execPath, [join(repo, 'scripts/readiness.mjs'), ...args, '--root', root]);
}

test('defer then configure later activates only wrapup deploy reporting', async () => {
  const root = await makeEmptyDir();
  const workflow = '## Workflow\n\nKeep workflow exact.\n';
  const skills = '## Agent skills\n\nKeep agent skills exact.\n';
  const before = `# Consumer\n\n${workflow}\n${skills}`;
  try {
    await write(root, '.claude/skills/skill-manifest.json', await readFile(join(repo, '.claude/skills/skill-manifest.json')));
    await write(root, 'agent-workflow-kit.json', JSON.stringify({
      kitVersion: '1.0.0', readinessContractVersion: 1, readinessDecisions: {}, installed: [],
    }));
    await write(root, 'CLAUDE.md', before);
    await write(root, 'AGENTS.md', before);

    await readiness(root, 'decision', 'set', 'prodTarget', 'pending');
    let result = JSON.parse((await readiness(root, 'check', '--skill', 'wrapup', '--json')).stdout);
    assert.equal(result.capabilities.prodTarget.state, 'pending');
    assert.deepEqual(result.inactiveBlocks, ['deployReport']);
    assert.deepEqual(result.activeBlocks, []);

    const prod = '## Prod\n\nFly.io, deployed via the release workflow. Live: https://example.test.\n';
    await write(root, 'CLAUDE.md', `${before}\n${prod}`);
    await write(root, 'AGENTS.md', `${before}\n${prod}`);
    result = JSON.parse((await readiness(root, 'check', '--skill', 'wrapup', '--json')).stdout);
    assert.equal(result.capabilities.prodTarget.state, 'ready');
    assert.deepEqual(result.activeBlocks, ['deployReport']);
    assert.deepEqual(result.inactiveBlocks, []);
    assert.ok((await readFile(join(root, 'CLAUDE.md'), 'utf8')).includes(workflow));
    assert.ok((await readFile(join(root, 'CLAUDE.md'), 'utf8')).includes(skills));

    await write(root, 'AGENTS.md', `${before}\n## Prod\n\nA divergent target.\n`);
    result = JSON.parse((await readiness(root, 'check', '--skill', 'wrapup', '--json')).stdout);
    assert.equal(result.capabilities.prodTarget.state, 'invalid');
    assert.deepEqual(result.activeBlocks, []);
    assert.deepEqual(result.inactiveBlocks, ['deployReport']);
  } finally {
    await cleanup(root);
  }
});

test('setup and wrapup publish the bounded Prod readiness contract on both surfaces', async () => {
  for (const surface of ['.claude', '.agents']) {
    const setup = await readFile(join(repo, surface, 'skills/setup-workflow/SKILL.md'), 'utf8');
    const wrapup = await readFile(join(repo, surface, 'skills/wrapup/SKILL.md'), 'utf8');
    assert.match(setup, /Configure now/);
    assert.match(setup, /Configure later/);
    assert.match(setup, /decision set prodTarget pending/);
    assert.match(setup, /Workflow.*byte-for-byte/s);
    assert.match(setup, /Agent skills.*byte-for-byte/s);
    assert.match(wrapup, /readiness\.mjs check --skill wrapup --json/);
    assert.match(wrapup, /<!-- readiness:block deployReport -->/);
    assert.match(wrapup, /<!-- readiness:end -->/);
    assert.match(wrapup, /Prod readiness is pending or missing; deploy reporting omitted\./);
    assert.match(wrapup, /landing continues/);
  }
});

test('repository instruction surfaces keep wrapup Prod readiness coherent', async () => {
  const result = JSON.parse((await readiness(repo, 'check', '--skill', 'wrapup', '--json')).stdout);

  assert.equal(result.capabilities.prodTarget.state, 'ready');
  assert.deepEqual(result.activeBlocks, ['deployReport']);
  assert.deepEqual(result.inactiveBlocks, []);
});
