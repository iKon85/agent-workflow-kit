import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemAdapters, orchestrateUpdatePullRequest } from './kit-update-pr.mjs';

function harness({ update = { exitCode: 0 }, changed = true, pulls = [] } = {}) {
  const calls = [];
  return {
    calls,
    options: {
      runUpdate: async () => (calls.push('update'), update),
      hasChanges: async () => (calls.push('changes'), changed),
      listPullRequests: async (branch) => (calls.push(['list', branch]), pulls),
      publishBranch: async (branch) => calls.push(['publish', branch]),
      createPullRequest: async (input) => calls.push(['create', input]),
      updatePullRequest: async (number, input) => calls.push(['upsert', number, input]),
    },
  };
}

test('a successful update creates one stable update pull request', async () => {
  const h = harness();
  const report = await orchestrateUpdatePullRequest(h.options);

  assert.equal(report.status, 'created');
  assert.equal(report.branch, 'agent-workflow-kit/update');
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'update', 'changes', 'list', 'publish', 'create',
  ]);
});

test('a conflict produces a structured report without touching the stable branch', async () => {
  const h = harness({ update: { exitCode: 2, stdout: 'conflicts: 1', stderr: '' } });
  const report = await orchestrateUpdatePullRequest(h.options);

  assert.deepEqual(report, {
    status: 'conflicted',
    branch: 'agent-workflow-kit/update',
    update: { exitCode: 2, stdout: 'conflicts: 1', stderr: '' },
  });
  assert.deepEqual(h.calls, ['update']);
});

test('a release mismatch fails without touching the consumer update branch', async () => {
  const h = harness({ update: { exitCode: 1, stdout: '', stderr: 'release mismatch' } });
  const report = await orchestrateUpdatePullRequest(h.options);

  assert.equal(report.status, 'failed');
  assert.equal(report.update.stderr, 'release mismatch');
  assert.deepEqual(h.calls, ['update']);
});

test('ambiguous existing pull requests fail before the last good branch is changed', async () => {
  const h = harness({ pulls: [{ number: 7 }, { number: 9 }] });
  const report = await orchestrateUpdatePullRequest(h.options);

  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'multiple-open-pull-requests');
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'update', 'changes', 'list',
  ]);
});

test('an already current consumer is a no-op', async () => {
  const h = harness({ changed: false });
  const report = await orchestrateUpdatePullRequest(h.options);

  assert.equal(report.status, 'current');
  assert.deepEqual(h.calls, ['update', 'changes']);
});

test('a repeated run updates the one existing stable pull request', async () => {
  const h = harness({ pulls: [{ number: 7 }] });
  const report = await orchestrateUpdatePullRequest(h.options);

  assert.equal(report.status, 'updated');
  assert.equal(report.pullRequest, 7);
  assert.deepEqual(h.calls.map((call) => Array.isArray(call) ? call[0] : call), [
    'update', 'changes', 'list', 'publish', 'upsert',
  ]);
});

test('publishing commits in place and lease-protects the stable remote branch', async () => {
  const commands = [];
  const execute = async (file, args) => {
    commands.push([file, ...args]);
    if (args[0] === 'ls-remote') return { stdout: 'abc123\trefs/heads/agent-workflow-kit/update\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const adapter = createSystemAdapters({ cwd: '/consumer', env: {}, execute });

  await adapter.publishBranch('agent-workflow-kit/update');

  const gitCommands = commands.map((command) => command.slice(1));
  assert.equal(gitCommands.some(([verb]) => ['switch', 'checkout', 'reset'].includes(verb)), false);
  assert.deepEqual(gitCommands.at(-1), [
    'push', '--force-with-lease=refs/heads/agent-workflow-kit/update:abc123',
    'origin', 'HEAD:refs/heads/agent-workflow-kit/update',
  ]);
});
