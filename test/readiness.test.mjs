import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { evaluateCapability, checkSkill } from '../scripts/readiness.mjs';
import { makeEmptyDir, cleanup } from './helpers.mjs';

const capability = {
  evidence: { type: 'sentinel', paths: ['docs/agents/example.md'] },
  allowNotApplicable: true,
};
const exec = promisify(execFile);

async function write(root, path, body) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
}

function nestedJson(keys, leaf = { configured: true }) {
  return keys.reduceRight((value, key) => ({ [key]: value }), leaf);
}

async function writeEvidence(root, evidence, valid) {
  const path = evidence.paths[0];
  if (evidence.type === 'sentinel') {
    const state = valid ? 'filled' : 'stub';
    return write(root, path, `<!-- setup-workflow: state=${state} -->\n${valid ? 'configured' : ''}\n`);
  }
  if (evidence.type === 'nonempty') return write(root, path, valid ? 'configured\n' : '');
  if (evidence.type === 'prod-section') {
    return write(root, path, valid ? '# Project\n\n## Prod\nDeploy target\n' : '# Project\n\n## Prod\n');
  }
  if (evidence.type === 'board-profile') {
    const profile = valid ? {
      repo: 'owner/repo', project: { owner: 'owner', number: 1, nodeId: 'node' },
      fields: { status: { id: 'status', options: { Done: 'done' }, roles: { done: 'Done' } }, wave: 'wave', cluster: 'cluster' },
      labels: { readyForAgent: 'ready' },
    } : {};
    return write(root, path, `<!-- board-sync:profile -->\n\`\`\`json\n${JSON.stringify(profile)}\n\`\`\`\n`);
  }
  if (evidence.type === 'runbook-reference') {
    const reference = valid ? '`docs/security/audit-runbook.md`' : 'no runbook';
    await write(root, path, `<!-- setup-workflow: state=filled -->\n${reference}\n`);
    if (valid) await write(root, 'docs/security/audit-runbook.md', '# Audit runbook\nConcrete checks.\n');
    return;
  }
  const body = evidence.validator === 'project-release'
    ? (valid ? { schemaVersion: 1, projectRelease: { versionFiles: ['package.json'], tagPrefix: 'v' } } : {})
    : (valid ? nestedJson(evidence.required ?? []) : {});
  await write(root, path, `${JSON.stringify(body)}\n`);
}

test('capability evidence and decisions resolve with fixed precedence', async () => {
  const root = await makeEmptyDir();
  try {
    assert.equal((await evaluateCapability({ root, capability })).state, 'missing');
    assert.equal((await evaluateCapability({ root, capability, decision: 'pending' })).state, 'pending');
    assert.equal((await evaluateCapability({ root, capability, decision: 'not-applicable' })).state, 'not-applicable');

    await write(root, 'docs/agents/example.md', '<!-- setup-workflow: state=stub -->\npartial\n');
    assert.equal((await evaluateCapability({ root, capability, decision: 'pending' })).state, 'invalid');

    await write(root, 'docs/agents/example.md', '<!-- setup-workflow: state=filled -->\nconfigured\n');
    const ready = await evaluateCapability({ root, capability, decision: 'pending' });
    assert.equal(ready.state, 'ready');
    assert.equal(ready.clearDecision, true);
  } finally {
    await cleanup(root);
  }
});

test('every manifest catalog entry has deterministic absent, invalid, and valid evidence', async () => {
  const source = JSON.parse(await readFile(join(import.meta.dirname, '../.claude/skills/skill-manifest.json'), 'utf8'));
  for (const [name, entry] of Object.entries(source.readiness.capabilities)) {
    const root = await makeEmptyDir();
    try {
      assert.equal((await evaluateCapability({ root, capability: entry })).state, 'missing', name);
      assert.equal((await evaluateCapability({ root, capability: entry, decision: 'pending' })).state, 'pending', name);
      await writeEvidence(root, entry.evidence, false);
      assert.equal((await evaluateCapability({ root, capability: entry, decision: 'pending' })).state, 'invalid', name);
      await writeEvidence(root, entry.evidence, true);
      const ready = await evaluateCapability({ root, capability: entry, decision: 'pending' });
      assert.equal(ready.state, 'ready', name);
      assert.equal(ready.clearDecision, true, name);
    } finally {
      await cleanup(root);
    }
  }
});

test('skill verdict reports required failures and optional active/inactive block IDs', async () => {
  const root = await makeEmptyDir();
  const manifest = {
    readiness: { contractVersion: 1, capabilities: {
      requiredThing: capability,
      optionalThing: { ...capability, evidence: { ...capability.evidence, paths: ['docs/agents/optional.md'] } },
    } },
    skills: { example: { readiness: {
      required: ['requiredThing'],
      optionalBlocks: { enrichment: 'optionalThing' },
    } } },
  };
  try {
    let result = await checkSkill({ root, skill: 'example', manifest });
    assert.equal(result.verdict, 'blocked');
    assert.deepEqual(result.activeBlocks, []);
    assert.deepEqual(result.inactiveBlocks, ['enrichment']);

    await write(root, 'docs/agents/example.md', '<!-- setup-workflow: state=filled -->\nconfigured\n');
    result = await checkSkill({ root, skill: 'example', manifest });
    assert.equal(result.verdict, 'degraded');
    assert.deepEqual(result.inactiveBlocks, ['enrichment']);

    await write(root, 'docs/agents/optional.md', '<!-- setup-workflow: state=filled -->\nconfigured\n');
    result = await checkSkill({ root, skill: 'example', manifest });
    assert.equal(result.verdict, 'ready');
    assert.deepEqual(result.activeBlocks, ['enrichment']);
    assert.deepEqual(result.inactiveBlocks, []);
  } finally {
    await cleanup(root);
  }
});

test('readiness composes a consumer-owned local skill with canonical Core capabilities', async () => {
  const root = await makeEmptyDir();
  const core = {
    schema_version: 1,
    readiness: { contractVersion: 1, capabilities: { requiredThing: capability } },
    skills: {},
  };
  const project = {
    schemaVersion: 1,
    coreSchemaVersion: 1,
    skills: {
      local: {
        class: 'project-private',
        publish: false,
        surfaces: ['claude', 'codex'],
        readiness: { required: ['requiredThing'] },
      },
    },
    annotations: {},
  };
  try {
    await write(root, '.claude/skills/skill-manifest.json', `${JSON.stringify(core)}\n`);
    await write(root, 'docs/agents/skill-registry.json', `${JSON.stringify(project)}\n`);
    await write(root, 'agent-workflow-kit.json', JSON.stringify({
      kitVersion: '1.0.0',
      readinessContractVersion: 1,
      readinessDecisions: {},
      installed: [],
    }));

    let result = await checkSkill({ root, skill: 'local' });
    assert.equal(result.verdict, 'blocked');
    await write(
      root,
      'docs/agents/example.md',
      '<!-- setup-workflow: state=filled -->\nconfigured\n',
    );
    result = await checkSkill({ root, skill: 'local' });
    assert.equal(result.verdict, 'ready');
  } finally {
    await cleanup(root);
  }
});

test('CLI owns narrow decisions and the late-Prod degraded to ready tracer', async () => {
  const root = await makeEmptyDir();
  const manifest = {
    readiness: { contractVersion: 1, capabilities: {
      prodTarget: { evidence: { type: 'prod-section', paths: ['CLAUDE.md', 'AGENTS.md'] } },
    } },
    skills: { wrapup: { readiness: { optionalBlocks: { deployReport: 'prodTarget' } } } },
  };
  try {
    await write(root, '.claude/skills/skill-manifest.json', `${JSON.stringify(manifest)}\n`);
    await write(root, 'agent-workflow-kit.json', JSON.stringify({
      kitVersion: '1.0.0', readinessContractVersion: 1,
      readinessDecisions: { prodTarget: 'pending' }, installed: [],
    }));
    await write(root, 'CLAUDE.md', '# Project\n');
    const run = (...args) => exec(process.execPath, [
      join(import.meta.dirname, '../scripts/readiness.mjs'), ...args, '--root', root,
    ]);

    let result = JSON.parse((await run('check', '--skill', 'wrapup', '--json')).stdout);
    assert.equal(result.verdict, 'degraded');
    assert.deepEqual(result.inactiveBlocks, ['deployReport']);

    await write(root, 'CLAUDE.md', '# Project\n\n## Prod\nDeploy with release workflow.\n');
    result = JSON.parse((await run('check', '--skill', 'wrapup', '--json')).stdout);
    assert.equal(result.verdict, 'ready');
    assert.deepEqual(result.activeBlocks, ['deployReport']);

    await write(root, 'AGENTS.md', '# Agents\n');
    result = JSON.parse((await run('check', '--skill', 'wrapup', '--json')).stdout);
    assert.equal(result.capabilities.prodTarget.state, 'invalid');
    assert.deepEqual(result.capabilities.prodTarget.diagnostics, [
      { path: 'AGENTS.md', problem: 'missing-section' },
    ]);

    await write(root, 'AGENTS.md', '# Agents\n\n## Prod\n');
    result = JSON.parse((await run('check', '--skill', 'wrapup', '--json')).stdout);
    assert.deepEqual(result.capabilities.prodTarget.diagnostics, [
      { path: 'AGENTS.md', problem: 'empty-section' },
    ]);

    await write(root, 'AGENTS.md', '# Agents\n\n## Prod\nDifferent target.\n');
    result = JSON.parse((await run('check', '--skill', 'wrapup', '--json')).stdout);
    assert.equal(result.capabilities.prodTarget.state, 'invalid');
    assert.deepEqual(result.capabilities.prodTarget.diagnostics, [
      { path: 'CLAUDE.md', problem: 'divergent-section' },
      { path: 'AGENTS.md', problem: 'divergent-section' },
    ]);
    assert.doesNotMatch(JSON.stringify(result.capabilities.prodTarget.diagnostics),
      /Deploy with release workflow|Different target/);

    await run('decision', 'clear', 'prodTarget');
    const consumer = JSON.parse(await readFile(join(root, 'agent-workflow-kit.json'), 'utf8'));
    assert.deepEqual(consumer.readinessDecisions, {});
    await assert.rejects(run('decision', 'set', 'prodTarget', 'not-applicable'), /does not allow/);
  } finally {
    await cleanup(root);
  }
});
