#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const scenario = process.env.FAKE_CODEX_SCENARIO ?? 'ok';
const pause = Number(process.env.FAKE_CODEX_PAUSE_MS ?? 1_000);

if (args.includes('--version') || args[0] === '--version') {
  console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? '0.144.6'}`);
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  if (scenario === 'auth-fail') {
    console.error('Not logged in');
    process.exit(1);
  }
  console.log('Logged in using fake credentials');
  process.exit(0);
}
if (args.includes('--help')) {
  const resumeHelp = args[0] === 'exec' && args[1] === 'resume';
  if (process.env.FAKE_CODEX_MISSING_CAPABILITY === '1'
      || (resumeHelp && process.env.FAKE_CODEX_RESUME_MISSING_CAPABILITY === '1')) {
    console.log('Usage: codex exec [PROMPT]');
  } else if (resumeHelp) {
    console.log('Usage: codex exec resume [--config key=value] [--json] THREAD PROMPT');
  } else {
    console.log('Usage: codex exec [--json] [--sandbox MODE] resume THREAD');
  }
  process.exit(0);
}

if (process.env.FAKE_CODEX_LAUNCH_LOG) {
  appendFileSync(process.env.FAKE_CODEX_LAUNCH_LOG, `${JSON.stringify(args)}\n`);
}

if (args[0] === 'exec' && args[1] === 'resume') {
  const configIndex = args.indexOf('-c');
  const expected = `sandbox_mode=${process.env.FAKE_EXPECTED_SANDBOX ?? 'read-only'}`;
  if (args.includes('--sandbox') || configIndex < 0 || args[configIndex + 1] !== expected) {
    console.error('invalid resume sandbox contract');
    process.exit(64);
  }
}

const emit = (value) => console.log(JSON.stringify(value));
const thread = process.env.FAKE_CODEX_THREAD ?? 'fake-thread-1';
const started = () => emit({ type: 'thread.started', thread_id: thread });
const verdict = () => emit({
  type: 'item.completed',
  item: { id: 'fake-item', type: 'agent_message', text: 'fake verdict' },
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

switch (scenario) {
  case 'silent':
    await sleep(pause);
    break;
  case 'startup-byte-silence':
    process.stderr.write('x');
    await sleep(pause);
    break;
  case 'quiet-post-thread':
    started();
    await sleep(pause);
    verdict();
    break;
  case 'malformed':
    console.log('{definitely-not-json');
    break;
  case 'json-null':
    emit(null);
    break;
  case 'json-array':
    emit([]);
    break;
  case 'json-scalar':
    emit('scalar');
    break;
  case 'item-null':
    emit({ type: 'item.completed', item: null });
    break;
  case 'item-array':
    emit({ type: 'item.completed', item: [] });
    break;
  case 'thread-non-string':
    emit({ type: 'thread.started', thread_id: 42 });
    break;
  case 'verdict-non-string':
    started();
    emit({ type: 'item.completed', item: { type: 'agent_message', text: 42 } });
    break;
  case 'missing-thread':
    verdict();
    break;
  case 'missing-verdict':
    started();
    emit({ type: 'turn.completed' });
    break;
  case 'exec-fail':
    started();
    console.error('fake execution failed token=super-secret');
    process.exit(23);
    break;
  case 'split-secret':
    started();
    writeFileSync(2, `${'x'.repeat(65_530)}token=super-secret`);
    process.exit(24);
    break;
  case 'signal':
    process.kill(process.pid, 'SIGTERM');
    break;
  case 'group-hang': {
    started();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    if (process.env.FAKE_CODEX_CHILD_PID) {
      writeFileSync(process.env.FAKE_CODEX_CHILD_PID, String(child.pid));
    }
    await sleep(pause);
    break;
  }
  case 'orphan-group': {
    started();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    if (process.env.FAKE_CODEX_CHILD_PID) {
      writeFileSync(process.env.FAKE_CODEX_CHILD_PID, String(child.pid));
    }
    child.unref();
    break;
  }
  case 'pipe-burst':
    process.stderr.write('x'.repeat(2 * 1024 * 1024));
    started();
    verdict();
    break;
  default:
    started();
    verdict();
}
