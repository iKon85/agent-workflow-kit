import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILDER_REPORT_SCHEMA,
  RECON_REPORT_SCHEMA,
  semanticVerify,
  validateBuilderReport,
  validateReconReport,
} from '../src/lib/reportValidator.mjs';

const SHA1 = 'a'.repeat(40);

const builderReport = (overrides = {}) => ({
  status: 'pass',
  filesTouched: ['src/lib/example.mjs'],
  testDecisions: ['EXTEND public contract coverage'],
  commands: [{ command: 'npm test', exitCode: 0, summary: 'green' }],
  commitSha: SHA1,
  stopItems: [],
  visualVerify: 'No browser verification required for kit tooling.',
  ...overrides,
});

const reconReport = (overrides = {}) => ({
  sliceId: '168',
  plannedFiles: [
    { path: 'src/lib/reportValidator.mjs', role: 'edit' },
    { path: 'src/lib/bundle.mjs', role: 'sharedMutable' },
  ],
  dependencyEdges: [{ from: '168', to: '170' }],
  ...overrides,
});

test('schema layer accepts well-formed recon and builder reports', () => {
  assert.deepEqual(validateReconReport(reconReport()), { ok: true, errors: [] });
  assert.deepEqual(validateBuilderReport(builderReport()), { ok: true, errors: [] });
  assert.equal(validateBuilderReport(builderReport({
    commands: [{ command: 'npm test', exitCode: 7, summary: 'schema only' }],
  })).ok, true);
});

test('schema layer rejects malformed shape and broken PASS/STOP discrimination', () => {
  const cases = [
    ['wrong type', { ...builderReport(), filesTouched: 'not-an-array' }],
    ['missing required', (() => { const value = builderReport(); delete value.commands; return value; })()],
    ['extra property', { ...builderReport(), prose: 'not contracted' }],
    ['PASS without SHA', { ...builderReport(), commitSha: null }],
    ['STOP without stop items', { ...builderReport(), status: 'stop', commitSha: null }],
  ];
  for (const [label, report] of cases) assert.equal(validateBuilderReport(report).ok, false, label);
});

test('semantic layer rejects a passing report with a nonzero command exit', () => {
  const report = builderReport({
    commands: [{ command: 'npm test', exitCode: 1, summary: 'failed' }],
  });
  const result = semanticVerify(report, {
    gitFacts: {
      objectFormat: 'sha1', commitSha: SHA1, baseIsAncestorOfCommit: true,
      changedFiles: report.filesTouched,
    },
    allowlist: report.filesTouched,
    requiredCommands: ['npm test'],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /nonzero exit/i);
});

test('semantic layer accepts independently verified PASS and nonzero STOP reports', () => {
  const options = {
    gitFacts: {
      objectFormat: 'sha1', commitSha: SHA1, baseIsAncestorOfCommit: true,
      changedFiles: ['src/lib/example.mjs'],
    },
    allowlist: ['src/lib/example.mjs'],
    requiredCommands: ['npm test'],
  };
  assert.deepEqual(semanticVerify(builderReport(), options), { ok: true, errors: [] });
  assert.deepEqual(semanticVerify(builderReport({
    status: 'stop',
    commitSha: null,
    stopItems: ['Tests are red'],
    commands: [{ command: 'npm test', exitCode: 1, summary: 'red' }],
  }), options), { ok: true, errors: [] });
});

test('semantic layer independently verifies git ancestry, allowlist, commands, and object format', () => {
  const report = builderReport();
  const base = {
    gitFacts: {
      objectFormat: 'sha1', commitSha: SHA1, baseIsAncestorOfCommit: true,
      changedFiles: report.filesTouched,
    },
    allowlist: report.filesTouched,
    requiredCommands: ['npm test'],
  };
  const cases = [
    ['base is not an ancestor of commit', {
      ...base,
      gitFacts: { ...base.gitFacts, baseIsAncestorOfCommit: false },
    }, /integration base is not an ancestor/i],
    ['fabricated SHA', { ...base, gitFacts: { ...base.gitFacts, commitSha: 'b'.repeat(40) } }, /commit sha/i],
    ['out-of-allowlist diff', { ...base, gitFacts: { ...base.gitFacts, changedFiles: ['secrets.txt'] } }, /allowlist/i],
    ['missing command', { ...base, requiredCommands: ['npm test', 'npm run lint'] }, /required command/i],
    ['sha1 cross-format hash', { ...base, gitFacts: { ...base.gitFacts, objectFormat: 'sha1', commitSha: 'a'.repeat(64) } }, /sha1/i],
    ['sha256 cross-format hash', {
      ...base,
      gitFacts: { ...base.gitFacts, objectFormat: 'sha256', commitSha: SHA1 },
    }, /sha256/i],
  ];

  for (const [label, facts, message] of cases) {
    const candidate = label === 'sha1 cross-format hash'
      ? builderReport({ commitSha: 'a'.repeat(64) })
      : report;
    const result = semanticVerify(candidate, facts);
    assert.equal(result.ok, false, label);
    assert.match(result.errors.join('\n'), message, label);
  }
});

function schemaBlock(markdown, name) {
  const pattern = '<!-- schema:' + name + ':start -->\\n```json\\n([\\s\\S]+?)\\n```\\n'
    + '<!-- schema:' + name + ':end -->';
  const match = markdown.match(new RegExp(pattern));
  assert.ok(match, `missing ${name} schema block`);
  return JSON.parse(match[1]);
}

function documentedFields(markdown, name) {
  const match = markdown.match(new RegExp(`<!-- fields:${name} -->([^\\n]+)`));
  assert.ok(match, `missing ${name} field list`);
  return match[1].trim().split(',').map((field) => field.trim()).sort();
}

test('report contract Markdown mirrors canonical schemas and required fields on both surfaces', async () => {
  const claude = await readFile('.claude/skills/orchestrate-wave/references/report-contracts.md', 'utf8');
  const codex = await readFile('.agents/skills/orchestrate-wave/references/report-contracts.md', 'utf8');
  assert.equal(codex, claude);
  for (const [name, schema] of [['recon', RECON_REPORT_SCHEMA], ['builder', BUILDER_REPORT_SCHEMA]]) {
    assert.deepEqual(schemaBlock(claude, name), schema);
    assert.deepEqual(documentedFields(claude, name), [...schema.required].sort());
  }
});
