import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const HOOKS = resolve('.claude/hooks');
const CANARY = 'fixture-value-must-never-appear';
const TESTREPORTER_PROFILE = resolve('test/fixtures/safety-guardrails/testreporter.json');

const profile = {
  version: 1,
  safetyGuardrails: {
    secrets: {
      enabled: true,
      sensitiveNames: ['.env', '.npmrc', 'credentials.json'],
      sensitivePathFragments: ['secrets/', '.ssh/'],
      safeTemplateSuffixes: ['.example', '.sample', '.template', '.dist'],
    },
    packageManager: {
      enabled: true,
      lockfiles: {
        'pnpm-lock.yaml': 'pnpm',
        'yarn.lock': 'yarn',
        'bun.lockb': 'bun',
        'package-lock.json': 'npm',
      },
    },
    doubleBackground: {
      enabled: true,
      surfaces: ['claude'],
    },
    searchShim: {
      enabled: true,
      commandNames: ['grep', 'rg'],
      detected: true,
    },
  },
};

async function fixture(customProfile = profile) {
  const root = await mkdtemp(join(tmpdir(), 'awkit-safety-'));
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await mkdir(join(root, 'secrets'), { recursive: true });
  await writeFile(join(root, 'docs/agents/workflow-capabilities.json'), JSON.stringify(customProfile));
  await writeFile(join(root, 'secrets/credentials.txt'), `${CANARY}\n`);
  return root;
}

async function runHook(root, name, payload) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('python3', [join(HOOKS, name)], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('secret guard blocks a sensitive read without exposing the file value', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runHook(root, 'block-secrets.py', {
    tool_name: 'Read',
    tool_input: { file_path: join(root, 'secrets/credentials.txt') },
  });

  assert.equal(result.code, 2);
  assert.match(result.stderr, /sensitive/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(CANARY));
  const log = await readFile(join(root, '.claude/logs/block-secrets.log'), 'utf8');
  assert.doesNotMatch(log, new RegExp(CANARY));
});

test('secret guard blocks shell dumps but allows safe templates', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), `${CANARY}\n`);
  await writeFile(join(root, '.env.example'), 'PLACEHOLDER=value\n');

  const blocked = await runHook(root, 'block-secrets.py', {
    tool_name: 'Bash',
    tool_input: { command: 'cat .env' },
  });
  const allowed = await runHook(root, 'block-secrets.py', {
    tool_name: 'Read',
    tool_input: { file_path: join(root, '.env.example') },
  });

  assert.equal(blocked.code, 2);
  assert.doesNotMatch(`${blocked.stdout}${blocked.stderr}`, new RegExp(CANARY));
  assert.equal(allowed.code, 0);
});

test('package-manager guard follows the effective lockfile instead of hardcoding pnpm', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

  const blocked = await runHook(root, 'block-npm-install-in-pnpm.py', {
    tool_name: 'Bash',
    tool_input: { command: 'npm install' },
  });
  const allowed = await runHook(root, 'block-npm-install-in-pnpm.py', {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm install' },
  });

  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, /pnpm install/);
  assert.equal(allowed.code, 0);
});

test('package-manager guard supports npm, pnpm, yarn, and bun lockfile policies', async (t) => {
  const cases = [
    ['package-lock.json', 'npm', 'yarn install'],
    ['pnpm-lock.yaml', 'pnpm', 'npm install'],
    ['yarn.lock', 'yarn', 'bun install'],
    ['bun.lockb', 'bun', 'pnpm install'],
  ];
  for (const [lockfile, manager, wrongCommand] of cases) {
    const root = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, lockfile), '{}\n');
    const wrong = await runHook(root, 'block-npm-install-in-pnpm.py', {
      tool_name: 'Bash',
      tool_input: { command: wrongCommand },
    });
    const correct = await runHook(root, 'block-npm-install-in-pnpm.py', {
      tool_name: 'Bash',
      tool_input: { command: `${manager} install` },
    });
    assert.equal(wrong.code, 2, lockfile);
    assert.match(wrong.stderr, new RegExp(`${manager} install`));
    assert.equal(correct.code, 0, lockfile);
  }
});

test('package-manager guard resolves the install command effective cwd', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await mkdir(join(root, 'npm-probe'));
  await writeFile(join(root, 'npm-probe/package-lock.json'), '{}\n');

  const result = await runHook(root, 'block-npm-install-in-pnpm.py', {
    tool_name: 'Bash',
    tool_input: { command: 'cd npm-probe && npm install' },
  });

  assert.equal(result.code, 0);
});

test('double-background guard applies only on configured agent surfaces', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = {
    tool_name: 'Bash',
    tool_input: { command: 'npm run dev &', run_in_background: true },
  };

  const claude = await runHook(root, 'block-bg-double-background.py', {
    ...payload,
    surface: 'claude',
  });
  const codex = await runHook(root, 'block-bg-double-background.py', {
    ...payload,
    surface: 'codex',
  });

  assert.equal(claude.code, 2);
  assert.match(claude.stderr, /run_in_background/);
  assert.equal(codex.code, 0);
});

test('search-shim guard blocks verified breakers only when the shim is present', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = {
    tool_name: 'Bash',
    tool_input: { command: 'grep -n "describe(" src' },
  };

  const present = await runHook(root, 'grep-shim-guard.py', command);
  const absentProfile = structuredClone(profile);
  absentProfile.safetyGuardrails.searchShim.detected = false;
  const absentRoot = await fixture(absentProfile);
  t.after(() => rm(absentRoot, { recursive: true, force: true }));
  const absent = await runHook(absentRoot, 'grep-shim-guard.py', command);

  assert.equal(present.code, 2);
  assert.match(present.stderr, /fixed-strings|command grep/i);
  assert.equal(absent.code, 0);
});

test('independently disabled guardrails are no-ops without audit-log writes', async (t) => {
  const disabled = structuredClone(profile);
  for (const policy of Object.values(disabled.safetyGuardrails)) policy.enabled = false;
  const root = await fixture(disabled);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  const cases = [
    ['block-secrets.py', { tool_name: 'Read', tool_input: { file_path: join(root, 'secrets/credentials.txt') } }],
    ['block-npm-install-in-pnpm.py', { tool_name: 'Bash', tool_input: { command: 'npm install' } }],
    ['block-bg-double-background.py', { tool_name: 'Bash', surface: 'claude', tool_input: { command: 'npm run dev &', run_in_background: true } }],
    ['grep-shim-guard.py', { tool_name: 'Bash', tool_input: { command: 'grep "foo(" src' } }],
  ];
  for (const [hook, payload] of cases) {
    const result = await runHook(root, hook, payload);
    assert.equal(result.code, 0, hook);
  }
  await assert.rejects(access(join(root, '.claude/logs')));
});

test('frozen Testreporter profile preserves positive and negative verdicts for all four guards', async (t) => {
  const frozen = JSON.parse(await readFile(TESTREPORTER_PROFILE, 'utf8'));
  const root = await fixture(frozen);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(join(root, '.env.example'), 'PLACEHOLDER=value\n');
  const cases = [
    ['block-secrets.py',
      { tool_name: 'Read', tool_input: { file_path: join(root, 'secrets/credentials.txt') } },
      { tool_name: 'Read', tool_input: { file_path: join(root, '.env.example') } }],
    ['block-npm-install-in-pnpm.py',
      { tool_name: 'Bash', tool_input: { command: 'npm install' } },
      { tool_name: 'Bash', tool_input: { command: 'pnpm install' } }],
    ['block-bg-double-background.py',
      { tool_name: 'Bash', surface: 'claude', tool_input: { command: 'pnpm dev &', run_in_background: true } },
      { tool_name: 'Bash', surface: 'claude', tool_input: { command: 'pnpm dev', run_in_background: true } }],
    ['grep-shim-guard.py',
      { tool_name: 'Bash', tool_input: { command: 'grep "describe(" src' } },
      { tool_name: 'Bash', tool_input: { command: 'grep -F "describe(" src' } }],
  ];
  for (const [hook, blockedPayload, allowedPayload] of cases) {
    assert.equal((await runHook(root, hook, blockedPayload)).code, 2, `${hook} positive`);
    assert.equal((await runHook(root, hook, allowedPayload)).code, 0, `${hook} negative`);
  }
});

test('all four safety adapters stay thin and delegate profile, verdict, and logging', async () => {
  const hooks = [
    'block-secrets.py',
    'block-npm-install-in-pnpm.py',
    'block-bg-double-background.py',
    'grep-shim-guard.py',
  ];
  for (const hook of hooks) {
    const source = await readFile(join(HOOKS, hook), 'utf8');
    assert.match(source, /from _safety_guard import load_core/);
    assert.match(source, /core\.evaluate/);
    assert.match(source, /log\(HOOK_NAME, decision\.log_message\)/);
    assert.doesNotMatch(source, /import re|import shlex|lockfiles|sensitiveNames/);
  }
});
