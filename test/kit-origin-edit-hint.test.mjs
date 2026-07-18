import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { HELPER_FILES } from '../src/lib/bundle.mjs';

const HOOK = resolve('.claude/hooks/kit-origin-edit-hint.py');

async function runHook(t, { manifest, payload }) {
  const root = await mkdtemp(join(tmpdir(), 'awkit-origin-hint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (manifest !== undefined) {
    await writeFile(join(root, 'agent-workflow-kit.json'), manifest);
  }
  const result = spawnSync('python3', [HOOK], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout.trim();
}

const manifest = JSON.stringify({
  installed: [
    { path: '.claude/skills/tdd/SKILL.md', origin: 'kit' },
    { path: 'CLAUDE.md', origin: 'consumer' },
  ],
});

test('Edit and Write hint only for kit-origin manifest paths', async (t) => {
  for (const tool_name of ['Edit', 'Write']) {
    const output = await runHook(t, {
      manifest,
      payload: { tool_name, tool_input: { file_path: '.claude/skills/tdd/SKILL.md' } },
    });
    const parsed = JSON.parse(output);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(parsed.hookSpecificOutput.additionalContext, /upstream/i);
    assert.match(parsed.hookSpecificOutput.additionalContext, /consumer own/i);
  }
});

test('absolute paths beneath the consumer root resolve to manifest paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awkit-origin-absolute-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'agent-workflow-kit.json'), manifest);
  const result = spawnSync('python3', [HOOK], {
    cwd: root,
    input: JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: join(root, '.claude/skills/tdd/SKILL.md') },
    }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /upstream/i);
});

test('hook fails open for non-kit, unknown, missing, corrupt, unsupported, and malformed input', async (t) => {
  const cases = [
    { manifest, payload: { tool_name: 'Edit', tool_input: { file_path: 'CLAUDE.md' } } },
    { manifest, payload: { tool_name: 'Edit', tool_input: { file_path: 'unknown.md' } } },
    { manifest: undefined, payload: { tool_name: 'Edit', tool_input: { file_path: '.claude/skills/tdd/SKILL.md' } } },
    { manifest: '{broken', payload: { tool_name: 'Edit', tool_input: { file_path: '.claude/skills/tdd/SKILL.md' } } },
    { manifest, payload: { tool_name: 'Bash', tool_input: { command: 'printf x > file' } } },
    { manifest, payload: { tool_name: 'Edit', tool_input: {} } },
    { manifest, payload: null },
  ];
  for (const input of cases) assert.equal(await runHook(t, input), '');
});

test('hook header states advisory and exact covered and uncovered surfaces', async () => {
  const source = await readFile(HOOK, 'utf8');
  assert.match(source, /advisory/i);
  assert.match(source, /Edit\/Write/);
  assert.match(source, /shell redirection/i);
  assert.match(source, /formatters/i);
  assert.match(source, /IDE edits/i);
  assert.match(source, /single manifest read/i);
  assert.doesNotMatch(source, /urllib|requests|httpx|socket/);
});

test('hook ships as an executable helper', async () => {
  const helper = HELPER_FILES.find(({ path }) => path === '.claude/hooks/kit-origin-edit-hint.py');
  assert.deepEqual(helper, {
    path: '.claude/hooks/kit-origin-edit-hint.py',
    kind: 'hook',
    mode: 0o755,
  });
  assert.equal((await stat(HOOK)).mode & 0o777, 0o755);
});
