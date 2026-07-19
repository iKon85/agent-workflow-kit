import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync,
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
    if (name === 'active') writeFileSync(join(dir, 'runtime.json'), '{}');
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

test('auth failure is classified before launch and leaves no run state', () => {
  const fx = fixture();
  const result = invoke(fx, launchArgs(), { FAKE_CODEX_SCENARIO: 'auth-fail' });
  assert.equal(result.output.status, 'AUTH');
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
      FAKE_CODEX_SCENARIO: 'group-hang', FAKE_CODEX_PAUSE_MS: '2000', FAKE_CODEX_CHILD_PID: childPid,
    });
    assert.equal(result.output.status, 'TIMEOUT');
    assert.equal(alive(decoy.pid), true);
    assert.equal(alive(Number(readFileSync(childPid, 'utf8'))), false);
  } finally {
    decoy.kill('SIGKILL');
  }
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

test('abort cancels an active run, deletes its state, and spares a decoy', async () => {
  const fx = fixture();
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const running = spawn(helper, launchArgs('build'), {
    cwd: root, encoding: 'utf8', env: {
      ...process.env, CODEX_EXEC_STATE_ROOT: fx.stateRoot, FAKE_CODEX_SCENARIO: 'group-hang',
      FAKE_CODEX_PAUSE_MS: '5000', FAKE_CODEX_LAUNCH_LOG: fx.launchLog,
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

test('0.137 JSON pipe regression drains both streams without deadlock', () => {
  const fx = fixture();
  const result = invoke(fx, launchArgs(), {
    FAKE_CODEX_SCENARIO: 'pipe-burst', FAKE_CODEX_VERSION: '0.137.0',
  });
  assert.equal(result.output.status, 'OK');
});
