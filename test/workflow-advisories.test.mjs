import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const HOOKS = resolve('.claude/hooks');

async function fixture(advisories) {
  const root = await mkdtemp(join(tmpdir(), 'awkit-advisories-'));
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await writeFile(join(root, 'docs/agents/workflow-capabilities.json'), JSON.stringify({
    version: 1,
    workflowAdvisories: { enabled: true, ...advisories },
  }));
  return root;
}

async function runHook(root, name, payload) {
  return new Promise((resolvePromise, reject) => {
    const hook = join(HOOKS, name);
    const child = name.endsWith('.sh')
      ? spawn(hook, [], { cwd: root })
      : spawn('python3', [hook], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

test('large reads emit profile-threshold context without blocking the tool', async (t) => {
  const root = await fixture({
    largeRead: { tools: ['Read'], lineThreshold: 3, outputBudget: 180 },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'large.txt'), 'one\ntwo\nthree\nfour\nfive\n');

  const result = await runHook(root, 'recon-size-hint.py', {
    tool_name: 'Read',
    tool_input: { file_path: join(root, 'large.txt') },
  });
  const payload = JSON.parse(result.stdout);

  assert.equal(result.code, 0);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(payload.hookSpecificOutput.additionalContext, /large\.txt/);
  assert.match(payload.hookSpecificOutput.additionalContext, /5 lines/);
  assert.ok(payload.hookSpecificOutput.additionalContext.length <= 180);
  assert.equal(result.stderr, '');
});

test('baseline advice emits once per matching branch until a valid branch manifest exists', async (t) => {
  const root = await fixture({
    baseline: {
      sourceGlobs: ['src/**'],
      branchRegex: '^(?:feat|fix)/',
      manifestPath: '.agent/baseline.json',
      stateDir: '.claude/logs/advisory-state',
      outputBudget: 220,
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/index.mjs'), 'export const value = 1;\n');
  const event = {
    tool_name: 'Edit',
    branch: 'feat/92-advisory',
    tool_input: { file_path: join(root, 'src/index.mjs') },
  };

  const first = await runHook(root, 'baseline-capture-hint.py', event);
  const repeated = await runHook(root, 'baseline-capture-hint.py', event);
  const nextBranch = await runHook(root, 'baseline-capture-hint.py', {
    ...event, branch: 'fix/93-next',
  });

  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /baseline/i);
  assert.equal(repeated.stdout, '');
  assert.match(JSON.parse(nextBranch.stdout).hookSpecificOutput.additionalContext, /fix\/93-next/);
  assert.match(
    await readFile(join(root, '.claude/logs/advisory-state/feat-92-advisory.hinted'), 'utf8'),
    /feat\/92-advisory/,
  );
});

test('pre-refactor sweep runs only affected profile commands and reports failures as failures', async (t) => {
  const root = await fixture({
    preRefactor: {
      promptMatchers: ['refactor'],
      surfaces: [
        {
          globs: ['src/**'],
          commands: [
            ['python3', '-c', "print('types clean')"],
            ['python3', '-c', "import sys; print('lint red'); sys.exit(3)"],
          ],
        },
        {
          globs: ['docs/**'],
          commands: [['python3', '-c', "print('docs only')"]],
        },
      ],
      timeoutSeconds: 2,
      outputBudget: 400,
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runHook(root, 'pre-refactor-sweep.py', {
    prompt: 'Please refactor this module',
    changed_files: ['src/index.mjs'],
  });
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;

  assert.equal(result.code, 0);
  assert.match(context, /PASS.*types clean/s);
  assert.match(context, /FAIL \(exit 3\).*lint red/s);
  assert.doesNotMatch(context, /docs only/);
});

test('stop verification runs only affected surface checks and keeps failures visible without blocking', async (t) => {
  const root = await fixture({
    stopChecks: {
      surfaces: [
        {
          globs: ['src/**'],
          command: ['python3', '-c', "import sys; print('typecheck red'); sys.exit(2)"],
        },
        {
          globs: ['docs/**'],
          command: ['python3', '-c', "print('docs check')"],
        },
      ],
      timeoutSeconds: 2,
      outputBudget: 300,
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runHook(root, 'typecheck-on-stop.sh', {
    changed_files: ['src/index.mjs'],
  });
  assert.notEqual(result.stdout, '', JSON.stringify(result));
  const payload = JSON.parse(result.stdout);
  const context = payload.hookSpecificOutput.additionalContext;

  assert.equal(result.code, 0);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(context, /FAIL \(exit 2\).*typecheck red/s);
  assert.doesNotMatch(context, /docs check/);
});

test('frozen Testreporter profile preserves all four change-lifecycle advisory outcomes', async (t) => {
  const frozen = JSON.parse(await readFile(
    resolve('test/fixtures/workflow-advisories/testreporter.json'), 'utf8',
  ));
  const root = await fixture(frozen.workflowAdvisories);
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'frontend/src'), { recursive: true });
  await mkdir(join(root, 'backend/src'), { recursive: true });
  await writeFile(join(root, 'frontend/src/large.ts'), '1\n2\n3\n4\n5\n');

  const large = await runHook(root, 'recon-size-hint.py', {
    tool_name: 'Read',
    tool_input: { file_path: join(root, 'frontend/src/large.ts') },
  });
  const baseline = await runHook(root, 'baseline-capture-hint.py', {
    tool_name: 'Edit',
    branch: 'feat/92-parity',
    tool_input: { file_path: join(root, 'frontend/src/large.ts') },
  });
  const sweep = await runHook(root, 'pre-refactor-sweep.py', {
    prompt: 'refactor frontend',
    changed_files: ['frontend/src/large.ts'],
  });
  const stop = await runHook(root, 'typecheck-on-stop.sh', {
    changed_files: ['backend/src/index.ts'],
  });

  for (const result of [large, baseline, sweep, stop]) assert.equal(result.code, 0);
  assert.match(large.stdout, /5 lines/);
  assert.match(baseline.stdout, /feat\/92-parity/);
  assert.match(sweep.stdout, /frontend sweep green/);
  assert.match(stop.stdout, /backend typecheck green/);
});

test('profile timeout turns a slow advisory command into a bounded visible failure', async (t) => {
  const root = await fixture({
    preRefactor: {
      promptMatchers: ['refactor'],
      surfaces: [{
        globs: ['src/**'],
        commands: [['python3', '-c', "import time; time.sleep(1)"]],
      }],
      timeoutSeconds: 0.01,
      outputBudget: 120,
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await runHook(root, 'pre-refactor-sweep.py', {
    prompt: 'refactor now',
    changed_files: ['src/index.mjs'],
  });
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;

  assert.match(context, /FAIL \(timeout 0\.01s\)/);
  assert.ok(context.length <= 120);
});
