import assert from 'node:assert/strict';
import {
  closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmdirSync, rmSync,
  statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const helper = join(root, 'scripts/codex-exec.sh');
const fake = join(root, 'scripts/codex-exec-scenarios/fake-codex.mjs');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-exec-test-'));
  return { dir, stateRoot: join(dir, 'state'), launchLog: join(dir, 'launch.log') };
}

function invoke(fx, args, extraEnv = {}) {
  const result = spawnSync(helper, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 8_000,
    env: {
      ...process.env,
      CODEX_EXEC_STATE_ROOT: fx.stateRoot,
      FAKE_CODEX_LAUNCH_LOG: fx.launchLog,
      ...extraEnv,
    },
  });
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const output = lines.length ? JSON.parse(lines.at(-1)) : null;
  return { ...result, output };
}

const launchArgs = (profile = 'review') => [
  'new', '--codex-bin', fake, '--profile', profile, '--mode', 'read-only',
  '--prompt', 'Return a verdict', '--timeout', '2', '--probe-timeout', '0.15',
];
const exists = (path) => { try { statSync(path); return true; } catch { return false; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const waitFor = async (predicate, timeout = 2_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
};

test('preflight accepts only exact tested versions and capabilities before launch', () => {
  const fx = fixture();
  const ok = invoke(fx, ['preflight', '--codex-bin', fake]);
  assert.equal(ok.output.status, 'OK');
  assert.match(ok.output.auth, /Logged in/);

  const version = invoke(fx, ['preflight', '--codex-bin', fake], { FAKE_CODEX_VERSION: '9.9.9' });
  assert.equal(version.output.error, 'UNTESTED_VERSION');
  const capability = invoke(fx, ['preflight', '--codex-bin', fake], {
    FAKE_CODEX_MISSING_CAPABILITY: '1',
  });
  assert.equal(capability.output.error, 'MISSING_CAPABILITY');
  const resumeCapability = invoke(fx, ['preflight', '--codex-bin', fake], {
    FAKE_CODEX_RESUME_MISSING_CAPABILITY: '1',
  });
  assert.equal(resumeCapability.output.error, 'MISSING_CAPABILITY');
  assert.equal(exists(fx.launchLog), false);
});

test('new and resume preserve immutable rounds and reject mode drift', () => {
  const fx = fixture();
  const first = invoke(fx, launchArgs());
  assert.equal(first.output.status, 'OK');
  assert.ok(first.output.runId);
  assert.equal(first.output.threadId, 'fake-thread-1');
  assert.equal(statSync(first.output.stateDir).mode & 0o777, 0o700);
  assert.ok(exists(join(first.output.stateDir, 'round-1.result.json')));

  const second = invoke(fx, [
    'resume', first.output.runId, '--codex-bin', fake,
    '--prompt', 'Again', '--timeout', '2',
  ]);
  assert.equal(second.output.status, 'OK');
  assert.equal(second.output.round, 2);
  assert.ok(exists(join(first.output.stateDir, 'round-1.stdout.jsonl')));
  assert.ok(exists(join(first.output.stateDir, 'round-2.stdout.jsonl')));
  assert.equal(readFileSync(join(first.output.stateDir, 'latest'), 'utf8').trim(), 'round-2.result.json');
  const resumeCommand = JSON.parse(readFileSync(fx.launchLog, 'utf8').trim().split('\n').at(-1));
  assert.equal(resumeCommand.includes('--sandbox'), false);
  assert.deepEqual(resumeCommand.slice(0, 4), ['exec', 'resume', 'fake-thread-1', '-c']);
  assert.equal(resumeCommand[4], 'sandbox_mode=read-only');

  const mismatch = invoke(fx, [
    'resume', first.output.runId, '--codex-bin', fake,
    '--mode', 'workspace-write', '--prompt', 'No',
  ]);
  assert.equal(mismatch.output.error, 'MODE_MISMATCH');
  assert.equal(invoke(fx, ['resume', '--codex-bin', fake]).output.error, 'RUN_ID_REQUIRED');
});

test('resume rejects tampered persisted profile and sandbox before launch', () => {
  const fx = fixture();
  const sandboxRun = invoke(fx, launchArgs()).output;
  const launchesBeforeSandboxTamper = readFileSync(fx.launchLog, 'utf8');
  writeFileSync(join(sandboxRun.stateDir, 'sandbox'), 'danger-full-access\n');

  const sandboxTamper = invoke(fx, [
    'resume', sandboxRun.runId, '--codex-bin', fake, '--prompt', 'Again',
  ]);
  assert.equal(sandboxTamper.output.error, 'INVALID_STATE');
  assert.equal(readFileSync(fx.launchLog, 'utf8'), launchesBeforeSandboxTamper);

  const profileRun = invoke(fx, launchArgs()).output;
  const launchesBeforeProfileTamper = readFileSync(fx.launchLog, 'utf8');
  writeFileSync(join(profileRun.stateDir, 'profile'), 'unbounded\n');

  const profileTamper = invoke(fx, [
    'resume', profileRun.runId, '--codex-bin', fake, '--prompt', 'Again',
  ]);
  assert.equal(profileTamper.output.error, 'INVALID_STATE');
  assert.equal(readFileSync(fx.launchLog, 'utf8'), launchesBeforeProfileTamper);
});

test('invalid timeout and mode inputs fail before launch', () => {
  const fx = fixture();
  const timeout = invoke(fx, launchArgs().map((value, index, all) => (
    all[index - 1] === '--timeout' ? 'NaN' : value
  )));
  assert.equal(timeout.output.error, 'INVALID_TIMEOUT');
  const mode = invoke(fx, launchArgs().map((value, index, all) => (
    all[index - 1] === '--mode' ? 'anything-goes' : value
  )));
  assert.equal(mode.output.error, 'INVALID_MODE');
  const danger = invoke(fx, launchArgs().map((value, index, all) => (
    all[index - 1] === '--mode' ? 'danger-full-access' : value
  )));
  assert.equal(danger.output.error, 'DANGER_FULL_ACCESS_REJECTED');
  const legacyFlag = invoke(fx, launchArgs().map((value) => value === '--mode' ? '--sandbox' : value));
  assert.equal(legacyFlag.output.error, 'INVALID_ARGUMENT');
  assert.equal(exists(fx.launchLog), false);
});

test('approved route passes explicit model and effort controls to Codex', () => {
  const fx = fixture();
  const result = invoke(fx, [
    ...launchArgs(),
    '--model', 'coding-model',
    '--effort', 'high',
  ]);
  assert.equal(result.output.status, 'OK');
  const command = JSON.parse(readFileSync(fx.launchLog, 'utf8').trim());
  assert.ok(command.includes('model=coding-model'));
  assert.ok(command.includes('model_reasoning_effort=high'));

  const resumed = invoke(fx, [
    'resume', result.output.runId, '--codex-bin', fake,
    '--prompt', 'Again', '--timeout', '2',
  ]);
  assert.equal(resumed.output.status, 'OK');
  const resumeCommand = JSON.parse(readFileSync(fx.launchLog, 'utf8').trim().split('\n').at(-1));
  assert.ok(resumeCommand.includes('model=coding-model'));
  assert.ok(resumeCommand.includes('model_reasoning_effort=high'));

  const mismatch = invoke(fx, [
    'resume', result.output.runId, '--codex-bin', fake,
    '--model', 'other-model', '--effort', 'high', '--prompt', 'No',
  ]);
  assert.equal(mismatch.output.error, 'ROUTE_CONTROL_MISMATCH');
});

test('route controls fail closed when incomplete or unsafe', () => {
  for (const args of [
    [...launchArgs(), '--model', 'coding-model'],
    [...launchArgs(), '--effort', 'high'],
    [...launchArgs(), '--model', 'unsafe value', '--effort', 'high'],
    [...launchArgs(), '--model', 'coding-model', '--effort', 'unknown'],
  ]) {
    const fx = fixture();
    const result = invoke(fx, args);
    assert.equal(result.output.error, 'INVALID_ROUTE_CONTROL');
    assert.equal(exists(fx.launchLog), false);
  }
});

test('current extended reasoning efforts are passed through explicitly', () => {
  for (const effort of ['max', 'ultra']) {
    const fx = fixture();
    const result = invoke(fx, [
      ...launchArgs(),
      '--model', 'coding-model',
      '--effort', effort,
    ]);
    assert.equal(result.output.status, 'OK', effort);
    const command = JSON.parse(readFileSync(fx.launchLog, 'utf8').trim());
    assert.ok(command.includes(`model_reasoning_effort=${effort}`));
  }
});

test('finalize deletes state, debug-retain preserves diagnostics, and finalized resume fails', () => {
  const fx = fixture();
  const run = invoke(fx, launchArgs()).output;
  const finalized = invoke(fx, ['finalize', run.runId]);
  assert.equal(finalized.output.status, 'OK');
  assert.equal(exists(run.stateDir), false);
  assert.equal(invoke(fx, ['resume', run.runId]).output.error, 'RUN_NOT_FOUND');

  const retained = invoke(fx, launchArgs()).output;
  invoke(fx, ['finalize', retained.runId, '--debug-retain']);
  assert.ok(exists(join(retained.stateDir, 'round-1.prompt.txt')));
  assert.ok(exists(join(retained.stateDir, 'round-1.stderr.log')));
  assert.equal(invoke(fx, ['resume', retained.runId]).output.error, 'RUN_FINALIZED');
});

test('handle-failure preserves a failed new result without inventing an abort target', () => {
  const fx = fixture();
  const failure = {
    status: 'AUTH', error: 'AUTH_REQUIRED', message: 'Login required',
    originalExitStatus: 23, signal: null, diagnostic: { source: 'preflight' },
  };
  const handled = invoke(fx, ['handle-failure', '--result', JSON.stringify(failure)]);
  assert.notEqual(handled.status, 0);
  assert.deepEqual(handled.output, failure);
  assert.equal(exists(fx.stateRoot), false);
});

test('handle-failure prefers a failed resume result run id and aborts that run', () => {
  const fx = fixture();
  const run = invoke(fx, launchArgs()).output;
  const failed = invoke(fx, [
    'resume', run.runId, '--codex-bin', fake, '--prompt', 'Again',
    '--timeout', '2', '--probe-timeout', '0.15',
  ], { FAKE_CODEX_SCENARIO: 'silent', FAKE_CODEX_PAUSE_MS: '1000' });
  assert.equal(failed.output.status, 'HUNG');
  assert.equal(exists(run.stateDir), true);

  const handled = invoke(fx, [
    'handle-failure', '--result', JSON.stringify(failed.output), '--run-id', 'wrongFallback',
  ]);
  assert.notEqual(handled.status, 0);
  assert.equal(handled.output.status, 'HUNG');
  assert.equal(handled.output.runId, run.runId);
  assert.equal(exists(run.stateDir), false);
});

test('handle-failure aborts the explicit fallback after a valid resume preflight failure', () => {
  const fx = fixture();
  const run = invoke(fx, launchArgs()).output;
  const failed = invoke(fx, [
    'resume', run.runId, '--codex-bin', fake, '--prompt', 'Again',
  ], { FAKE_CODEX_VERSION: '9.9.9' });
  assert.equal(failed.output.error, 'UNTESTED_VERSION');
  assert.equal(failed.output.runId, undefined);

  const handled = invoke(fx, [
    'handle-failure', '--result', JSON.stringify(failed.output), '--run-id', run.runId,
  ]);
  assert.notEqual(handled.status, 0);
  assert.deepEqual(handled.output, failed.output);
  assert.equal(exists(run.stateDir), false);
});

test('handle-failure sanitizes malformed input and aborts only its explicit fallback', () => {
  const fx = fixture();
  const run = invoke(fx, launchArgs()).output;
  const handled = invoke(fx, [
    'handle-failure', '--result', 'not-json super-secret raw bytes', '--run-id', run.runId,
  ]);
  assert.notEqual(handled.status, 0);
  assert.equal(handled.output.status, 'MALFORMED_RESULT');
  assert.equal(handled.output.error, 'MALFORMED_RESULT');
  assert.doesNotMatch(handled.stdout, /super-secret|raw bytes/);
  assert.equal(exists(run.stateDir), false);
});

test('handle-failure sanitizes an empty result without inventing a cleanup target', () => {
  const fx = fixture();
  const handled = invoke(fx, ['handle-failure', '--result', '']);
  assert.notEqual(handled.status, 0);
  assert.equal(handled.output.status, 'MALFORMED_RESULT');
  assert.equal(handled.output.error, 'MALFORMED_RESULT');
  assert.equal(exists(fx.stateRoot), false);
});

test('handle-failure rejects an unknown result status as malformed', () => {
  const fx = fixture();
  const handled = invoke(fx, [
    'handle-failure', '--result', JSON.stringify({
      status: 'MYSTERY_FAILURE', message: 'do not surface this arbitrary value',
    }),
  ]);
  assert.notEqual(handled.status, 0);
  assert.equal(handled.output.status, 'MALFORMED_RESULT');
  assert.equal(handled.output.error, 'MALFORMED_RESULT');
  assert.doesNotMatch(handled.stdout, /MYSTERY_FAILURE|arbitrary value/);
});

test('handle-failure rejects OK results without aborting their run', () => {
  const fx = fixture();
  const run = invoke(fx, launchArgs()).output;
  const handled = invoke(fx, [
    'handle-failure', '--result', JSON.stringify({
      status: 'OK', runId: run.runId, message: 42,
    }), '--run-id', run.runId,
  ]);
  assert.notEqual(handled.status, 0);
  assert.equal(handled.output.error, 'RESULT_NOT_FAILED');
  assert.equal(exists(run.stateDir), true);
});

test('handle-failure treats an invalid embedded run id as malformed and aborts the valid fallback', () => {
  const fx = fixture();
  const run = invoke(fx, launchArgs()).output;
  const handled = invoke(fx, [
    'handle-failure',
    '--result', JSON.stringify({ status: 'HUNG', runId: `../${run.runId}` }),
    '--run-id', run.runId,
  ]);
  assert.notEqual(handled.status, 0);
  assert.equal(handled.output.status, 'MALFORMED_RESULT');
  assert.equal(handled.output.error, 'MALFORMED_RESULT');
  assert.equal(handled.output.runId, undefined);
  assert.equal(exists(run.stateDir), false);
});

test('handle-failure preserves classification when cleanup of a valid result id fails', () => {
  const fx = fixture();
  const fallback = invoke(fx, launchArgs()).output;
  const failure = {
    status: 'HUNG', runId: 'validButMissing', originalExitStatus: 17, signal: 'SIGTERM',
  };
  const handled = invoke(fx, [
    'handle-failure', '--result', JSON.stringify(failure), '--run-id', fallback.runId,
  ]);
  assert.notEqual(handled.status, 0);
  assert.equal(handled.output.status, failure.status);
  assert.equal(handled.output.runId, failure.runId);
  assert.equal(handled.output.originalExitStatus, failure.originalExitStatus);
  assert.equal(handled.output.signal, failure.signal);
  assert.equal(handled.output.cleanupStatus, 'FAILED');
  assert.equal(handled.output.cleanupError, 'RUN_NOT_FOUND');
  assert.equal(exists(fallback.stateDir), true);
});

test('automatic stale cleanup is bounded and never removes retained or active state', () => {
  const fx = fixture();
  mkdirSync(fx.stateRoot, { recursive: true, mode: 0o700 });
  for (const name of ['old1', 'old2', 'old3', 'retained', 'active']) {
    const dir = join(fx.stateRoot, `codex-exec.${name}`);
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'run-id'), `${name}\n`);
    if (name === 'retained') writeFileSync(join(dir, 'debug-retain'), '');
    if (name === 'active') writeFileSync(join(dir, 'runtime.json'), JSON.stringify({
      token: 'a'.repeat(64), round: 1, phase: 'running', heartbeat: Date.now() / 1000,
    }));
    utimesSync(dir, 0, 0);
  }
  const result = invoke(fx, launchArgs(), {
    CODEX_EXEC_STALE_SECONDS: '1', CODEX_EXEC_STALE_MAX_DELETE: '2',
  });
  assert.equal(result.output.status, 'OK');
  const remaining = readdirSync(fx.stateRoot);
  assert.equal(remaining.filter((name) => /^codex-exec\.old/.test(name)).length, 1);
  assert.ok(remaining.includes('codex-exec.retained'));
  assert.ok(remaining.includes('codex-exec.active'));
});

test('invalid stale cleanup limits fail before launch and preserve an active run', async () => {
  const fx = fixture();
  const ready = join(fx.dir, 'group-hang.ready');
  const running = spawn(helper, launchArgs('build'), {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, CODEX_EXEC_STATE_ROOT: fx.stateRoot,
      FAKE_CODEX_SCENARIO: 'group-hang', FAKE_CODEX_GROUP_HANG_READY: ready,
      FAKE_CODEX_LAUNCH_LOG: fx.launchLog,
    },
  });
  running.stdout.on('data', () => {});
  try {
    assert.ok(await waitFor(() => exists(ready)));
    const stateName = await waitFor(() => exists(fx.stateRoot) && readdirSync(fx.stateRoot)
      .find((name) => readJson(join(fx.stateRoot, name, 'runtime.json'))?.phase === 'running'));
    assert.ok(stateName);
    const stateDir = join(fx.stateRoot, stateName);
    const runId = readFileSync(join(stateDir, 'run-id'), 'utf8').trim();
    const invalidAge = invoke(fx, launchArgs(), { CODEX_EXEC_STALE_SECONDS: '-1' });
    assert.equal(invalidAge.output.error, 'INVALID_STALE_CONFIG');
    const invalidCount = invoke(fx, launchArgs(), { CODEX_EXEC_STALE_MAX_DELETE: '1.5' });
    assert.equal(invalidCount.output.error, 'INVALID_STALE_CONFIG');
    assert.equal(exists(join(stateDir, 'runtime.json')), true);
    assert.equal(readFileSync(fx.launchLog, 'utf8').trim().split('\n').length, 1);
    assert.equal(invoke(fx, ['abort', runId]).output.status, 'OK');
    assert.ok(await waitFor(() => running.exitCode !== null, 3_000));
  } finally {
    running.kill('SIGKILL');
  }
});

test('stale cleanup tolerates a state disappearing after candidate listing', async () => {
  const fx = fixture();
  mkdirSync(fx.stateRoot, { recursive: true, mode: 0o700 });
  const disappearing = join(fx.stateRoot, 'codex-exec.disappearing');
  mkdirSync(disappearing, { mode: 0o700 });
  writeFileSync(join(disappearing, 'run-id'), 'disappearing\n');
  utimesSync(disappearing, 0, 0);
  const marker = join(fx.dir, 'cleanup-listed');
  const running = spawn(helper, launchArgs(), {
    cwd: root, encoding: 'utf8', env: {
      ...process.env,
      CODEX_EXEC_STATE_ROOT: fx.stateRoot,
      CODEX_EXEC_STALE_SECONDS: '1',
      CODEX_EXEC_TEST_CLEANUP_PAUSE_MARKER: marker,
      FAKE_CODEX_LAUNCH_LOG: fx.launchLog,
    },
  });
  let stdout = '';
  running.stdout.on('data', (chunk) => { stdout += chunk; });
  try {
    assert.ok(await waitFor(() => exists(marker)));
    rmSync(disappearing, { recursive: true });
    assert.ok(await waitFor(() => running.exitCode !== null, 3_000));
    assert.equal(running.exitCode, 0);
    assert.equal(JSON.parse(stdout.trim().split('\n').at(-1)).status, 'OK');
  } finally {
    running.kill('SIGKILL');
  }
});

test('stale cleanup cannot delete a run whose resume acquired the shared lease', async () => {
  const fx = fixture();
  const original = invoke(fx, launchArgs()).output;
  utimesSync(original.stateDir, 0, 0);
  const marker = join(fx.dir, 'cleanup-listed');
  const cleanupRun = spawn(helper, launchArgs(), {
    cwd: root, encoding: 'utf8', env: {
      ...process.env,
      CODEX_EXEC_STATE_ROOT: fx.stateRoot,
      CODEX_EXEC_STALE_SECONDS: '1',
      CODEX_EXEC_TEST_CLEANUP_PAUSE_MARKER: marker,
      FAKE_CODEX_LAUNCH_LOG: fx.launchLog,
    },
  });
  cleanupRun.stdout.on('data', () => {});
  let resumed;
  try {
    assert.ok(await waitFor(() => exists(marker)));
    resumed = spawn(helper, [
      'resume', original.runId, '--codex-bin', fake, '--prompt', 'Again',
      '--timeout', '5', '--probe-timeout', '1',
    ], {
      cwd: root, encoding: 'utf8', env: {
        ...process.env,
        CODEX_EXEC_STATE_ROOT: fx.stateRoot,
        FAKE_CODEX_SCENARIO: 'group-hang',
        FAKE_CODEX_LAUNCH_LOG: fx.launchLog,
      },
    });
    resumed.stdout.on('data', () => {});
    assert.ok(await waitFor(() => readJson(join(original.stateDir, 'runtime.json'))?.round === 2));
    assert.ok(await waitFor(() => cleanupRun.exitCode !== null, 3_000));
    assert.equal(cleanupRun.exitCode, 0);
    assert.equal(exists(join(original.stateDir, 'runtime.json')), true);
    assert.equal(invoke(fx, ['abort', original.runId]).output.status, 'OK');
    assert.ok(await waitFor(() => resumed.exitCode !== null, 3_000));
  } finally {
    cleanupRun.kill('SIGKILL');
    resumed?.kill('SIGKILL');
  }
});

test('stale cleanup removes abandoned runtime state without signaling its persisted pgid', () => {
  const fx = fixture();
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true });
  try {
    const stateDir = join(fx.stateRoot, 'codex-exec.abandoned');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, 'run-id'), 'abandoned\n');
    writeFileSync(join(stateDir, 'runtime.json'), JSON.stringify({
      token: 'b'.repeat(64), round: 1, phase: 'running', heartbeat: 0,
      pid: decoy.pid, pgid: decoy.pid,
    }));
    utimesSync(stateDir, 0, 0);
    const result = invoke(fx, launchArgs(), {
      CODEX_EXEC_STALE_SECONDS: '1', CODEX_EXEC_STALE_MAX_DELETE: '8',
    });
    assert.equal(result.output.status, 'OK');
    assert.equal(exists(stateDir), false);
    assert.equal(alive(decoy.pid), true);
  } finally {
    decoy.kill('SIGKILL');
  }
});

for (const [scenario, status] of [
  ['malformed', 'MALFORMED-JSON'],
  ['missing-thread', 'NO-THREAD'],
  ['missing-verdict', 'NO-VERDICT'],
  ['exec-fail', 'EXEC_FAILED'],
  ['signal', 'SIGNALLED'],
]) {
  test(`${scenario} maps to ${status} and retains state`, () => {
    const fx = fixture();
    const result = invoke(fx, launchArgs(), { FAKE_CODEX_SCENARIO: scenario });
    assert.equal(result.output.status, status);
    assert.ok(exists(result.output.stateDir));
    if (scenario === 'exec-fail') {
      assert.equal(result.output.originalExitStatus, 23);
      assert.doesNotMatch(readFileSync(join(result.output.stateDir, 'round-1.stderr.log'), 'utf8'), /super-secret/);
    }
    if (scenario === 'signal') assert.equal(result.output.signal, 'SIGTERM');
  });
}

for (const scenario of [
  'json-null', 'json-array', 'json-scalar', 'item-null', 'item-array',
  'event-type-null', 'event-type-array', 'item-type-null', 'item-type-array',
  'thread-non-string', 'verdict-non-string',
]) {
  test(`${scenario} is a structured MALFORMED-JSON result without traceback`, () => {
    const fx = fixture();
    const result = invoke(fx, launchArgs(), { FAKE_CODEX_SCENARIO: scenario });
    assert.equal(result.output.status, 'MALFORMED-JSON');
    assert.equal(readFileSync(join(result.output.stateDir, 'latest'), 'utf8').trim(), 'round-1.result.json');
    assert.doesNotMatch(result.stderr, /Traceback/);
  });
}

test('auth failure is classified before launch and leaves no run state', () => {
  const fx = fixture();
  const result = invoke(fx, launchArgs(), { FAKE_CODEX_SCENARIO: 'auth-fail' });
  assert.equal(result.output.status, 'AUTH');
  assert.equal(result.output.originalExitStatus, 1);
  assert.equal(result.output.signal, null);
  assert.equal(exists(fx.launchLog), false);
  assert.equal(exists(fx.stateRoot) ? readdirSync(fx.stateRoot).length : 0, 0);
});

test('stderr redaction spans process-read boundaries', () => {
  const fx = fixture();
  const result = invoke(fx, launchArgs(), { FAKE_CODEX_SCENARIO: 'split-secret' });
  assert.equal(result.output.status, 'EXEC_FAILED');
  const log = readFileSync(join(result.output.stateDir, 'round-1.stderr.log'), 'utf8');
  assert.doesNotMatch(log, /super-secret|er-secret/);
  assert.match(log, /token=\[REDACTED\]/);
});

test('review profile declares a silent pre-thread process HUNG', () => {
  const fx = fixture();
  const result = invoke(fx, launchArgs(), {
    FAKE_CODEX_SCENARIO: 'silent', FAKE_CODEX_PAUSE_MS: '2000',
  });
  assert.equal(result.output.status, 'HUNG');
});

test('pre-thread activity resets the HUNG probe but later silence still becomes HUNG', () => {
  const fx = fixture();
  const result = invoke(fx, launchArgs(), {
    FAKE_CODEX_SCENARIO: 'startup-byte-silence', FAKE_CODEX_PAUSE_MS: '1000',
  });
  assert.equal(result.output.status, 'HUNG');
});

test('post-thread silence is governed only by the overall timeout', () => {
  const fx = fixture();
  const args = launchArgs('build').map((value, index, all) => all[index - 1] === '--timeout' ? '0.35' : value);
  const result = invoke(fx, args, {
    FAKE_CODEX_SCENARIO: 'quiet-post-thread', FAKE_CODEX_PAUSE_MS: '1000',
  });
  assert.equal(result.output.status, 'TIMEOUT');
});

test('timeout kills only the owned group and leaves a decoy sibling alive', () => {
  const fx = fixture();
  const childPid = join(fx.dir, 'child.pid');
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    const args = launchArgs().map((value, index, all) => all[index - 1] === '--timeout' ? '0.35' : value);
    const result = invoke(fx, args, {
      FAKE_CODEX_SCENARIO: 'group-hang', FAKE_CODEX_CHILD_PID: childPid,
    });
    assert.equal(result.output.status, 'TIMEOUT');
    assert.equal(exists(result.output.stateDir), true);
    assert.equal(readFileSync(join(result.output.stateDir, 'latest'), 'utf8').trim(), 'round-1.result.json');
    assert.equal(alive(decoy.pid), true);
    assert.equal(alive(Number(readFileSync(childPid, 'utf8'))), false);
  } finally {
    decoy.kill('SIGKILL');
  }
});

test('a concurrent resume and finalize cannot steal an owned round lease', async () => {
  const fx = fixture();
  const first = invoke(fx, launchArgs()).output;
  const running = spawn(helper, [
    'resume', first.runId, '--codex-bin', fake, '--prompt', 'Again',
    '--timeout', '5', '--probe-timeout', '1',
  ], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, CODEX_EXEC_STATE_ROOT: fx.stateRoot,
      FAKE_CODEX_SCENARIO: 'group-hang',
      FAKE_CODEX_LAUNCH_LOG: fx.launchLog,
    },
  });
  running.stdout.on('data', () => {});
  try {
    assert.ok(await waitFor(() => readJson(join(first.stateDir, 'runtime.json'))?.round === 2));
    const duplicate = invoke(fx, [
      'resume', first.runId, '--codex-bin', fake, '--prompt', 'Duplicate',
    ]);
    assert.equal(duplicate.output.error, 'ACTIVE_RUN');
    const finalized = invoke(fx, ['finalize', first.runId]);
    assert.equal(finalized.output.error, 'ACTIVE_RUN');
    const roundTwoLaunches = readFileSync(fx.launchLog, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line))
      .filter((args) => args[0] === 'exec' && args[1] === 'resume');
    assert.equal(roundTwoLaunches.length, 1);
    assert.equal(invoke(fx, ['abort', first.runId]).output.status, 'OK');
    assert.ok(await waitFor(() => running.exitCode !== null, 3_000));
  } finally {
    running.kill('SIGKILL');
  }
});

test('a broken result output sink cannot strand runtime or lease ownership', () => {
  if (process.platform !== 'linux') return;
  const fx = fixture();
  const full = openSync('/dev/full', 'w');
  try {
    spawnSync(helper, launchArgs(), {
      cwd: root,
      stdio: ['ignore', full, 'pipe'],
      timeout: 8_000,
      env: {
        ...process.env,
        CODEX_EXEC_STATE_ROOT: fx.stateRoot,
        FAKE_CODEX_LAUNCH_LOG: fx.launchLog,
      },
    });
  } finally {
    closeSync(full);
  }
  const [stateName] = readdirSync(fx.stateRoot);
  const stateDir = join(fx.stateRoot, stateName);
  assert.equal(exists(join(stateDir, 'round-1.result.json')), true);
  assert.equal(exists(join(stateDir, 'latest')), true);
  assert.equal(exists(join(stateDir, 'runtime.json')), false);
  assert.equal(exists(join(stateDir, 'round.lease')), false);
});

test('a runtime publication failure reaps the owned child before releasing its lease', async () => {
  const fx = fixture();
  const childPid = join(fx.dir, 'supervised.pid');
  const result = invoke(fx, launchArgs('build'), {
    CODEX_EXEC_TEST_CHILD_PID_FILE: childPid,
    CODEX_EXEC_TEST_RUNTIME_WRITE_FAIL: '1',
    FAKE_CODEX_SCENARIO: 'group-hang',
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.output.error, 'ROUND_SUPERVISOR_FAILED');
  assert.equal(result.output.originalExitStatus, 1);
  assert.equal(result.output.signal, null);
  const pid = Number(readFileSync(childPid, 'utf8'));
  assert.equal(await waitFor(() => !alive(pid), 1_000), true);
  const [stateName] = readdirSync(fx.stateRoot);
  const stateDir = join(fx.stateRoot, stateName);
  assert.equal(exists(join(stateDir, 'runtime.json')), false);
  assert.equal(exists(join(stateDir, 'round.lease')), false);
});

test('debug-retain marker failure is visible and never reports finalize success', () => {
  const fx = fixture();
  const run = invoke(fx, launchArgs()).output;
  mkdirSync(join(run.stateDir, 'debug-retain'));
  const finalized = invoke(fx, ['finalize', run.runId, '--debug-retain']);
  assert.notEqual(finalized.status, 0);
  assert.equal(finalized.output.error, 'DEBUG_RETAIN_FAILED');
  assert.equal(exists(run.stateDir), true);
  assert.equal(exists(join(run.stateDir, 'round.lease')), false);
  rmdirSync(join(run.stateDir, 'debug-retain'));
  assert.equal(invoke(fx, ['abort', run.runId]).output.status, 'OK');
});

test('lease release failure is structured and cannot masquerade as a successful round', () => {
  const fx = fixture();
  const result = invoke(fx, launchArgs(), { CODEX_EXEC_TEST_LEASE_RELEASE_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(result.output.status, 'OK');
  assert.equal(result.output.cleanupStatus, 'FAILED');
  assert.equal(result.output.cleanupError, 'LEASE_RELEASE_FAILED');
  assert.ok(result.output.runId);
  assert.doesNotMatch(result.stderr, /Traceback/);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const stateDir = join(fx.stateRoot, `codex-exec.${result.output.runId}`);
  assert.equal(exists(join(stateDir, 'round.lease')), true);
  assert.equal(invoke(fx, ['resume', result.output.runId]).output.error, 'ACTIVE_RUN');
  const handled = invoke(fx, ['handle-failure', '--result', JSON.stringify(result.output)]);
  assert.notEqual(handled.status, 0);
  assert.equal(handled.output.status, 'OK');
  assert.equal(handled.output.cleanupError, 'LEASE_RELEASE_FAILED');
  assert.equal(handled.output.recoveryCleanupStatus, 'FAILED');
  assert.equal(handled.output.recoveryCleanupError, 'ABORT_FAILED');
});

test('lease release failure preserves a non-OK round classification and signal', () => {
  const fx = fixture();
  const result = invoke(fx, launchArgs(), {
    CODEX_EXEC_TEST_LEASE_RELEASE_FAIL: '1',
    FAKE_CODEX_SCENARIO: 'silent',
    FAKE_CODEX_PAUSE_MS: '1000',
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.output.status, 'HUNG');
  assert.equal(result.output.signal, 'SIGTERM');
  assert.equal(result.output.cleanupStatus, 'FAILED');
  assert.equal(result.output.cleanupError, 'LEASE_RELEASE_FAILED');
});

test('timeout kills descendants after the process-group leader has exited', () => {
  const fx = fixture();
  const childPid = join(fx.dir, 'orphan.pid');
  const args = launchArgs().map((value, index, all) => {
    if (all[index - 1] === '--timeout') return '0.35';
    if (all[index - 1] === '--probe-timeout') return '1';
    return value;
  });
  const result = invoke(fx, args, {
    FAKE_CODEX_SCENARIO: 'orphan-group', FAKE_CODEX_CHILD_PID: childPid,
  });
  assert.equal(result.output.status, 'TIMEOUT');
  assert.equal(alive(Number(readFileSync(childPid, 'utf8'))), false);
});

test('abort never signals a pgid copied into stale runtime state', async () => {
  const fx = fixture();
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true });
  try {
    await new Promise((resolve) => decoy.once('spawn', resolve));
    const stateDir = join(fx.stateRoot, 'codex-exec.stale');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, 'run-id'), 'stale\n');
    writeFileSync(join(stateDir, 'runtime.json'), JSON.stringify({
      token: 'c'.repeat(64), round: 1, phase: 'running', heartbeat: 0,
      pid: decoy.pid, pgid: decoy.pid,
    }));
    const aborted = invoke(fx, ['abort', 'stale']);
    assert.equal(aborted.output.error, 'ABORT_FAILED');
    assert.equal(exists(stateDir), true);
    assert.equal(alive(decoy.pid), true);
    assert.equal(await waitFor(() => decoy.exitCode !== null, 300), null);
  } finally {
    decoy.kill('SIGKILL');
  }
});

test('settling keeps finalize out and lets abort await a published CANCELLED result', async () => {
  const fx = fixture();
  const settleMarker = join(fx.dir, 'settling.marker');
  const running = spawn(helper, launchArgs('build'), {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, CODEX_EXEC_STATE_ROOT: fx.stateRoot,
      FAKE_CODEX_LAUNCH_LOG: fx.launchLog, CODEX_EXEC_TEST_SETTLE_MARKER: settleMarker,
    },
  });
  let stdout = '';
  let stderr = '';
  running.stdout.on('data', (chunk) => { stdout += chunk; });
  running.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const stateName = await waitFor(() => exists(settleMarker) && exists(fx.stateRoot)
      && readdirSync(fx.stateRoot).find((name) => readJson(join(fx.stateRoot, name, 'runtime.json'))?.phase === 'settling'));
    assert.ok(stateName);
    const stateDir = join(fx.stateRoot, stateName);
    const runId = readFileSync(join(stateDir, 'run-id'), 'utf8').trim();
    const finalized = invoke(fx, ['finalize', runId]);
    assert.equal(finalized.output.error, 'ACTIVE_RUN');
    assert.equal(exists(stateDir), true);

    const aborted = invoke(fx, ['abort', runId]);
    assert.equal(aborted.output.status, 'OK');
    const exited = await waitFor(() => running.exitCode !== null, 3_000);
    assert.equal(exited, true);
    assert.equal(JSON.parse(stdout.trim().split('\n').at(-1)).status, 'CANCELLED');
    assert.doesNotMatch(stderr, /Traceback|FileNotFoundError/);
    assert.equal(exists(stateDir), false);
  } finally {
    running.kill('SIGKILL');
  }
});

test('abort cancels an active run, deletes its state, and spares a decoy', async () => {
  const fx = fixture();
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const running = spawn(helper, launchArgs('build'), {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, CODEX_EXEC_STATE_ROOT: fx.stateRoot, FAKE_CODEX_SCENARIO: 'group-hang',
      FAKE_CODEX_LAUNCH_LOG: fx.launchLog,
    },
  });
  let stdout = '';
  running.stdout.on('data', (chunk) => { stdout += chunk; });
  try {
    const stateName = await waitFor(() => exists(fx.stateRoot) && readdirSync(fx.stateRoot)
      .find((name) => exists(join(fx.stateRoot, name, 'run-id'))));
    assert.ok(stateName);
    const runId = readFileSync(join(fx.stateRoot, stateName, 'run-id'), 'utf8').trim();
    const aborted = invoke(fx, ['abort', runId]);
    assert.equal(aborted.output.status, 'OK');
    const exit = await waitFor(() => running.exitCode !== null && running.exitCode, 3_000);
    assert.notEqual(exit, null);
    assert.equal(JSON.parse(stdout.trim().split('\n').at(-1)).status, 'CANCELLED');
    assert.equal(exists(join(fx.stateRoot, stateName)), false);
    assert.equal(alive(decoy.pid), true);
  } finally {
    running.kill('SIGKILL');
    decoy.kill('SIGKILL');
  }
});

test('handle-failure selects one of two simultaneous live runs and leaves the other intact', async () => {
  const fx = fixture();
  const start = () => spawn(helper, launchArgs('build'), {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, CODEX_EXEC_STATE_ROOT: fx.stateRoot,
      FAKE_CODEX_SCENARIO: 'group-hang',
      FAKE_CODEX_LAUNCH_LOG: fx.launchLog,
    },
  });
  const first = start();
  const second = start();
  try {
    const states = await waitFor(() => {
      if (!exists(fx.stateRoot)) return null;
      const names = readdirSync(fx.stateRoot)
        .filter((name) => exists(join(fx.stateRoot, name, 'runtime.json')));
      return names.length === 2 ? names.sort() : null;
    }, 3_000);
    assert.ok(states);
    const selectedDir = join(fx.stateRoot, states[0]);
    const otherDir = join(fx.stateRoot, states[1]);
    const selectedId = readFileSync(join(selectedDir, 'run-id'), 'utf8').trim();
    const otherId = readFileSync(join(otherDir, 'run-id'), 'utf8').trim();

    const handled = invoke(fx, [
      'handle-failure', '--result', JSON.stringify({ status: 'HUNG', runId: selectedId }),
      '--run-id', otherId,
    ]);
    assert.equal(handled.output.status, 'HUNG');
    assert.equal(exists(selectedDir), false);
    assert.equal(exists(join(otherDir, 'runtime.json')), true);
    assert.ok(await waitFor(() => (
      [first, second].filter((child) => child.exitCode === null).length === 1
    ), 2_000));

    const cleanup = invoke(fx, ['abort', otherId]);
    assert.equal(cleanup.output.status, 'OK');
    assert.ok(await waitFor(() => first.exitCode !== null && second.exitCode !== null, 3_000));
  } finally {
    first.kill('SIGKILL');
    second.kill('SIGKILL');
  }
});

test('0.137 JSON pipe regression drains both streams without deadlock', () => {
  const fx = fixture();
  const result = invoke(fx, launchArgs(), {
    FAKE_CODEX_SCENARIO: 'pipe-burst', FAKE_CODEX_VERSION: '0.137.0',
  });
  assert.equal(result.output.status, 'OK');
});
