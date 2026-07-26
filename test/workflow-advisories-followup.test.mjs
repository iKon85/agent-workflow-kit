import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const HOOKS = resolve('.claude/hooks');

async function git(root, args, date) {
  return run('git', args, {
    cwd: root,
    env: date ? {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    } : process.env,
  });
}

async function runHook(root, name, payload = {}) {
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

async function freshnessFixture() {
  const root = await mkdtemp(join(tmpdir(), 'awkit-freshness-'));
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.email', 'test@example.invalid']);
  await git(root, ['config', 'user.name', 'Test User']);
  await mkdir(join(root, '.claude/skills/demo'), { recursive: true });
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await mkdir(join(root, 'docs/conventions'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, '.claude/skills/demo/SKILL.md'), '# Demo\n');
  await writeFile(join(root, '.claude/skills/demo/SOURCES.txt'), 'src/code.py\n');
  await writeFile(join(root, 'docs/conventions/api.md'), '# API convention\n');
  await writeFile(join(root, 'src/code.py'), 'value = 1\n');
  await writeFile(join(root, 'docs/agents/workflow-capabilities.json'), JSON.stringify({
    version: 1,
    workflowAdvisories: {
      enabled: true,
      freshness: {
        documents: [{
          document: 'docs/conventions/api.md',
          sources: ['src/code.py'],
        }],
        outputBudget: 500,
      },
    },
  }));
  await git(root, ['add', '.']);
  await git(root, ['commit', '-m', 'documents'], '2026-01-01T00:00:00Z');
  await writeFile(join(root, 'src/code.py'), 'value = 2\n');
  await git(root, ['add', 'src/code.py']);
  await git(root, ['commit', '-m', 'source moved'], '2026-01-02T00:00:00Z');
  return root;
}

test('skill and convention freshness share one source-map and commit-time core', async (t) => {
  const root = await freshnessFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const skill = await runHook(root, 'skill-drift-hint.py');
  const convention = await runHook(root, 'convention-drift-hint.py');

  assert.equal(skill.code, 0);
  assert.equal(convention.code, 0);
  assert.match(JSON.parse(skill.stdout).hookSpecificOutput.additionalContext, /src\/code\.py/);
  assert.match(JSON.parse(convention.stdout).hookSpecificOutput.additionalContext, /docs\/conventions\/api\.md/);
  for (const hook of ['skill-drift-hint.py', 'convention-drift-hint.py']) {
    assert.match(
      await readFile(join(HOOKS, hook), 'utf8'),
      /load_workflow_advisories_core/,
    );
  }
});

test('migration reminder is profile-driven and non-matching commands are no-ops', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awkit-migration-reminder-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await writeFile(join(root, 'docs/agents/workflow-capabilities.json'), JSON.stringify({
    version: 1,
    workflowAdvisories: {
      enabled: true,
      migration: {
        commandMatchers: ['db migrate', 'schema apply'],
        artifact: 'schema/snapshot.json',
        refreshCommand: ['npm', 'run', 'schema:snapshot'],
        outputBudget: 240,
      },
    },
  }));

  const ignored = await runHook(root, 'migration-snapshot-reminder.py', {
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });
  const matched = await runHook(root, 'migration-snapshot-reminder.py', {
    session_id: 'session-177',
    tool_name: 'Bash',
    tool_input: { command: 'db migrate --latest' },
  });
  const repeated = await runHook(root, 'migration-snapshot-reminder.py', {
    session_id: 'session-177',
    tool_name: 'Bash',
    tool_input: { command: 'schema apply --latest' },
  });
  const quotedMention = await runHook(root, 'migration-snapshot-reminder.py', {
    session_id: 'session-quoted',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "document db migrate --latest usage"' },
  });
  const directAfterQuoted = await runHook(root, 'migration-snapshot-reminder.py', {
    session_id: 'session-quoted',
    tool_name: 'Bash',
    tool_input: { command: 'db migrate --latest' },
  });

  assert.equal(ignored.stdout, '');
  const payload = JSON.parse(matched.stdout);
  assert.equal(payload.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(payload.hookSpecificOutput.additionalContext, /schema\/snapshot\.json/);
  assert.match(payload.hookSpecificOutput.additionalContext, /npm run schema:snapshot/);
  assert.equal(repeated.stdout, '');
  assert.equal(quotedMention.stdout, '');
  assert.notEqual(directAfterQuoted.stdout, '');
});

test('LoC forewarning consumes the gate threshold and issue marker without weakening failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awkit-loc-forewarn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await writeFile(join(root, 'max-lines-allowlist.json'), JSON.stringify({
    maxLines: 321,
    offenders: ['src/large.py'],
  }));
  await writeFile(join(root, 'docs/agents/workflow-capabilities.json'), JSON.stringify({
    version: 1,
    workflowAdvisories: {
      enabled: true,
      locForewarn: {
        branchRegex: '^(?:feat|fix)/(\\d+)-',
        issueCommand: [
          'python3',
          '-c',
          "print('<!-- loc-offender: src/large.py -->')",
        ],
        timeoutSeconds: 2,
        outputBudget: 300,
      },
    },
  }));
  await git(root, ['init', '--initial-branch=feat/93-advisory']);

  const warned = await runHook(root, 'loc-offender-forewarn.py');
  assert.equal(warned.code, 0);
  const payload = JSON.parse(warned.stdout);
  assert.match(payload.hookSpecificOutput.additionalContext, /src\/large\.py/);
  assert.match(payload.hookSpecificOutput.additionalContext, /321/);

  const profilePath = join(root, 'docs/agents/workflow-capabilities.json');
  const profile = JSON.parse(await readFile(profilePath, 'utf8'));
  profile.workflowAdvisories.locForewarn.issueCommand = [
    'python3', '-c', 'raise SystemExit(7)',
  ];
  await writeFile(profilePath, JSON.stringify(profile));
  const unavailable = await runHook(root, 'loc-offender-forewarn.py');
  assert.equal(unavailable.code, 0);
  assert.equal(unavailable.stdout, '');

  const gate = await readFile(resolve('scripts/loc_offender_gate.py'), 'utf8');
  assert.match(gate, /GateError.*fail-closed/s);
  assert.match(await readFile(join(HOOKS, 'loc-offender-forewarn.py'), 'utf8'), /load_loc_offender_gate/);
});

test('frozen Testreporter profile covers all seven advisory capability rows', async () => {
  const census = JSON.parse(await readFile(
    resolve('scripts/workflow-advisories/capabilities.json'), 'utf8',
  ));
  const fixture = JSON.parse(await readFile(
    resolve('test/fixtures/workflow-advisories/testreporter.json'), 'utf8',
  ));
  assert.equal(census.capabilities.length, 7);
  assert.deepEqual(
    census.capabilities.map(({ profileKey }) => profileKey).sort(),
    Object.keys(fixture.workflowAdvisories)
      .filter((key) => !['enabled'].includes(key))
      .sort(),
  );
  for (const { artifact } of census.capabilities) {
    await readFile(resolve(artifact), 'utf8');
  }
});
