import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { evaluateCapability, checkSkill, inspectProdSections } from '../scripts/readiness.mjs';
import { renderReadinessAvailability } from '../src/cli.mjs';
import { makeEmptyDir, cleanup } from './helpers.mjs';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

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
  const path = evidence.type === 'project-extension'
    ? `docs/agents/skills/${evidence.skill}.md`
    : evidence.paths[0];
  if (evidence.type === 'project-extension') {
    const version = valid ? 'v1' : 'v2';
    const sections = (evidence.activation?.sections ?? ['Project'])
      .map((name) => `## ${name}\nConfigured.`)
      .join('\n\n');
    return write(
      root,
      path,
      `<!-- agent-workflow-kit: project-extension/${version}; skill=${evidence.skill} -->\n` +
      `# Project layer\n\n${sections}\n`,
    );
  }
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

test('structured Project-extension readiness uses the runtime activation contract', async () => {
  const root = await makeEmptyDir();
  const path = 'docs/agents/skills/orchestrate-wave.md';
  const marker = '<!-- agent-workflow-kit: project-extension/v1; skill=orchestrate-wave -->';
  const manifest = {
    readiness: {
      contractVersion: 1,
      capabilities: {
        orchestrateWaveRecipe: {
          evidence: {
            type: 'project-extension',
            skill: 'orchestrate-wave',
            paths: [path],
            activation: {
              mode: 'all-sections-filled',
              sections: ['§Setup', '§Landing'],
            },
          },
        },
      },
    },
    skills: {
      'orchestrate-wave': {
        readiness: {
          optionalBlocks: { projectRecipe: 'orchestrateWaveRecipe' },
        },
      },
    },
  };
  try {
    await write(
      root,
      path,
      `${marker}\n# Recipe\n\n## §Setup\n<!-- configure -->\n\n## §Landing\n`,
    );
    let result = await checkSkill({ root, skill: 'orchestrate-wave', manifest });
    assert.equal(result.verdict, 'degraded');
    assert.equal(result.capabilities.orchestrateWaveRecipe.state, 'missing');
    assert.deepEqual(result.activeBlocks, []);
    assert.deepEqual(result.inactiveBlocks, ['projectRecipe']);

    await write(
      root,
      path,
      `${marker}\n# Recipe\n\n## §Setup\nRun setup.\n`,
    );
    result = await checkSkill({ root, skill: 'orchestrate-wave', manifest });
    assert.equal(result.verdict, 'degraded');
    assert.equal(result.capabilities.orchestrateWaveRecipe.state, 'missing');

    await write(
      root,
      path,
      `${marker}\n# Recipe\n\n## §Setup\nRun setup.\n\n## §Landing\nRun landing.\n`,
    );
    result = await checkSkill({ root, skill: 'orchestrate-wave', manifest });
    assert.equal(result.verdict, 'ready');
    assert.equal(result.capabilities.orchestrateWaveRecipe.state, 'ready');
    assert.deepEqual(result.activeBlocks, ['projectRecipe']);
    assert.deepEqual(result.inactiveBlocks, []);

    await write(
      root,
      path,
      '<!-- agent-workflow-kit: project-extension/v2; skill=orchestrate-wave -->\n',
    );
    result = await checkSkill({ root, skill: 'orchestrate-wave', manifest });
    assert.equal(result.verdict, 'blocked');
    assert.equal(result.capabilities.orchestrateWaveRecipe.state, 'invalid');
    assert.equal(result.capabilities.orchestrateWaveRecipe.blocking, true);
    assert.match(
      result.capabilities.orchestrateWaveRecipe.diagnostic,
      /unsupported schema.*expected project-extension\/v1/,
    );
    assert.deepEqual(result.activeBlocks, []);
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

test('locProfile evidence lives where the shipped readers and setup-workflow seed it (repo root)', async () => {
  const source = JSON.parse(await readFile(join(import.meta.dirname, '../.claude/skills/skill-manifest.json'), 'utf8'));
  const entry = source.readiness.capabilities.locProfile;
  const root = await makeEmptyDir();
  try {
    // The exact seed setup-workflow §8b writes at the repo root — the single
    // threshold SSOT that loc_offender_gate.py and board-sync.py read.
    await write(root, 'max-lines-allowlist.json',
      `${JSON.stringify({ maxLines: 300, vendored: [], offenders: [] })}\n`);
    assert.equal((await evaluateCapability({ root, capability: entry })).state, 'ready');
  } finally {
    await cleanup(root);
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

test('unresolved readiness renders as plain sentences with a next step per entry', () => {
  const lines = renderReadinessAvailability({
    stillUnresolved: ['alphaLayer:invalid', 'betaLayer:pending', 'gammaLayer:missing'],
    unresolved: [
      {
        capability: 'alphaLayer',
        state: 'invalid',
        title: 'Alpha layer',
        remedy: 'Replace the stub with the project rules.',
        evidencePaths: ['docs/agents/alpha.md'],
      },
      {
        capability: 'betaLayer',
        state: 'pending',
        title: null,
        remedy: null,
        evidencePaths: [],
      },
      {
        capability: 'gammaLayer',
        state: 'missing',
        title: 'Gamma layer',
        remedy: 'Record the gamma choice.',
        evidencePaths: ['docs/agents/gamma.json', 'docs/agents/gamma.md'],
      },
    ],
  });

  assert.deepEqual(lines, [
    'still unresolved:',
    '  Alpha layer is present but not valid (evidence: docs/agents/alpha.md).',
    '    next step: Replace the stub with the project rules.',
    '  betaLayer is deferred as pending.',
    '  Gamma layer is not configured yet '
      + '(evidence: docs/agents/gamma.json, docs/agents/gamma.md).',
    '    next step: Record the gamma choice.',
  ]);
});

test('readiness rendering stays generic and never emits manifest control characters', async () => {
  assert.deepEqual(
    renderReadinessAvailability({ stillUnresolved: [], unresolved: [] }),
    ['still unresolved: none'],
  );
  assert.deepEqual(
    renderReadinessAvailability({ stillUnresolved: ['alphaLayer:missing'] }),
    ['still unresolved: alphaLayer:missing'],
  );

  const rendered = renderReadinessAvailability({
    stillUnresolved: ['alphaLayer:invalid'],
    unresolved: [{
      capability: 'alphaLayer',
      state: 'invalid',
      title: 'Alpha\u001b[31m layer',
      remedy: 'Fix\u0007 it.\u001b]0;pwned\u0007',
      evidencePaths: ['docs/agents/alpha\u001b.md'],
    }],
  });
  for (const line of rendered) assert.doesNotMatch(line, CONTROL_CHARACTERS);
  assert.match(rendered.join(' '), /Alpha \[31m layer is present but not valid/);
  assert.match(rendered.join(' '), /next step: Fix it\. \]0;pwned/);

  const source = JSON.parse(await readFile(
    join(import.meta.dirname, '../.claude/skills/skill-manifest.json'), 'utf8',
  ));
  const cli = await readFile(join(import.meta.dirname, '../src/cli.mjs'), 'utf8');
  for (const [name, entry] of Object.entries(source.readiness.capabilities)) {
    assert.equal(cli.includes(name), false, `per-capability branch for ${name}`);
    assert.equal(typeof entry.title, 'string', `${name} has no catalog title`);
    assert.equal(typeof entry.remedy, 'string', `${name} has no catalog remedy`);
    assert.doesNotMatch(entry.title, CONTROL_CHARACTERS, name);
    assert.doesNotMatch(entry.remedy, CONTROL_CHARACTERS, name);
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

test('the ## Prod heading match is whole-word, not exact-string', async () => {
  const root = await makeEmptyDir();
  try {
    // Consumer wording with a trailing qualifier as a separate word — recognized.
    await write(root, 'wording.md', '# Consumer\n\n## Prod und Deployment\n\nFly.io.\n');
    let [wording] = await inspectProdSections(root, ['wording.md']);
    assert.equal(wording.state, 'valid');
    assert.equal(wording.problem, null);

    // A different word that merely starts with "Prod" — never matched, and
    // distinguishable from a genuinely absent section: it carries a line
    // number and echoes no consumer content.
    await write(root, 'production.md', '# Consumer\n\n## Production\n\nFly.io.\n');
    let [production] = await inspectProdSections(root, ['production.md']);
    assert.equal(production.state, 'missing');
    assert.equal(production.problem, 'heading-mismatch');
    assert.equal(production.line, 3);
    assert.equal(production.body, null);
    assert.doesNotMatch(JSON.stringify(production), /Fly\.io/);

    // Genuinely absent — still reports missing-section, no line number.
    await write(root, 'absent.md', '# Consumer\n\n## Deployment\n\nFly.io.\n');
    let [absent] = await inspectProdSections(root, ['absent.md']);
    assert.equal(absent.state, 'missing');
    assert.equal(absent.problem, 'missing-section');
    assert.equal(absent.line, undefined);
  } finally {
    await cleanup(root);
  }
});
