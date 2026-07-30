import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { HELPER_FILES } from '../src/lib/bundle.mjs';

const HOOKS = resolve('.claude/hooks');
const TESTREPORTER_PROFILE = resolve('test/fixtures/safety-guardrails/testreporter.json');

const profile = {
  version: 1,
  safetyGuardrails: {
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
  await writeFile(join(root, 'docs/agents/workflow-capabilities.json'), JSON.stringify(customProfile));
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

test('a disabled search-shim guardrail is a no-op without audit-log writes', async (t) => {
  const disabled = structuredClone(profile);
  disabled.safetyGuardrails.searchShim.enabled = false;
  const root = await fixture(disabled);
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runHook(root, 'grep-shim-guard.py', {
    tool_name: 'Bash',
    tool_input: { command: 'grep "foo(" src' },
  });
  assert.equal(result.code, 0);
  await assert.rejects(access(join(root, '.claude/logs')));
});

test('frozen Testreporter profile preserves the search-shim verdicts; retired guard keys stay inert consumer data', async (t) => {
  const frozen = JSON.parse(await readFile(TESTREPORTER_PROFILE, 'utf8'));
  const root = await fixture(frozen);
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal((await runHook(root, 'grep-shim-guard.py', {
    tool_name: 'Bash',
    tool_input: { command: 'grep "describe(" src' },
  })).code, 2, 'positive');
  assert.equal((await runHook(root, 'grep-shim-guard.py', {
    tool_name: 'Bash',
    tool_input: { command: 'grep -F "describe(" src' },
  })).code, 0, 'negative');

  // The 2026-07 hook review retired the secrets / packageManager /
  // doubleBackground adapters. Their profile keys are consumer data and stay
  // verbatim in the frozen fixture; nothing reads them any more.
  assert.ok(frozen.safetyGuardrails.secrets, 'frozen fixture keeps its retired keys');
});

test('the search-shim adapter stays thin and delegates profile, verdict, and logging', async () => {
  const source = await readFile(join(HOOKS, 'grep-shim-guard.py'), 'utf8');
  assert.match(source, /from _safety_guard import load_core/);
  assert.match(source, /core\.evaluate/);
  assert.match(source, /log\(HOOK_NAME, decision\.log_message\)/);
  assert.doesNotMatch(source, /import re|import shlex|lockfiles|sensitiveNames/);

  // The 2026-07 hook review: adapters without a named incident are no longer
  // shipped; the search-shim guard is the one incident-backed safety adapter.
  const shipped = new Set(HELPER_FILES.map(({ path }) => path));
  assert.equal(shipped.has('.claude/hooks/grep-shim-guard.py'), true);
  for (const retired of [
    '.claude/hooks/block-secrets.py',
    '.claude/hooks/block-npm-install-in-pnpm.py',
    '.claude/hooks/block-bg-double-background.py',
  ]) {
    assert.equal(shipped.has(retired), false, retired);
  }
});
