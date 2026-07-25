#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const UPDATE_BRANCH = 'agent-workflow-kit/update';
export const UPDATE_TITLE = 'chore: update agent workflow kit';
const UPDATE_BODY = [
  'Automated, parity-verified update of `@ikon85/agent-workflow-kit`.',
  '',
  'The transactional update candidate passed the built-in Kit invariants before this branch was published.',
  '',
  'This pull request is never merged automatically.',
].join('\n');
const exec = promisify(execFile);

export async function orchestrateUpdatePullRequest(options) {
  const {
    runUpdate, hasChanges, listPullRequests, publishBranch,
    createPullRequest, updatePullRequest, branch = UPDATE_BRANCH,
  } = options;
  const update = await runUpdate();
  if (update.exitCode !== 0) {
    return { status: update.exitCode === 2 ? 'conflicted' : 'failed', branch, update };
  }
  if (!await hasChanges()) return { status: 'current', branch };

  const pulls = await listPullRequests(branch);
  if (pulls.length > 1) {
    return { status: 'failed', branch, reason: 'multiple-open-pull-requests' };
  }
  await publishBranch(branch);
  const input = { title: UPDATE_TITLE, body: pullRequestBody(update.stdout), branch };
  if (pulls.length === 1) {
    await updatePullRequest(pulls[0].number, input);
    return { status: 'updated', branch, pullRequest: pulls[0].number };
  }
  await createPullRequest(input);
  return { status: 'created', branch };
}

function pullRequestBody(stdout = '') {
  const labels = ['newly available:', 'newly degraded:', 'newly blocked:', 'still unresolved:'];
  const clean = stdout.replaceAll(/\x1b\[[0-9;]*m/g, '');
  const summary = clean.split('\n')
    .map((line) => line.trim())
    .filter((line) => labels.some((label) => line.includes(label)))
    .map((line) => line.slice(Math.min(...labels.map((label) => {
      const index = line.indexOf(label);
      return index < 0 ? line.length : index;
    }))));
  return [UPDATE_BODY, '## Availability', summary.join('\n') || 'No readiness availability changes reported.'].join('\n\n');
}

export function createSystemAdapters({
  cwd = process.cwd(), env = process.env, execute = exec,
} = {}) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const command = async (file, args) => {
    try {
      const result = await execute(file, args, { cwd, env, encoding: 'utf8' });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { exitCode: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
  };
  const checked = async (file, args) => {
    const result = await command(file, args);
    if (result.exitCode !== 0) throw new Error(result.stderr || `${file} exited ${result.exitCode}`);
    return result.stdout.trim();
  };

  return {
    runUpdate: () => command(process.execPath, [join(packageRoot, 'src/cli.mjs'), 'update', '--yes']),
    hasChanges: async () => Boolean(await checked('git', ['status', '--porcelain', '--untracked-files=all'])),
    listPullRequests: async (branch) => JSON.parse(await checked('gh', [
      'pr', 'list', '--state', 'open', '--head', branch, '--json', 'number,url',
    ]) || '[]'),
    publishBranch: async (branch) => {
      await checked('git', ['config', 'user.name', 'agent-workflow-kit[bot]']);
      await checked('git', ['config', 'user.email', 'agent-workflow-kit[bot]@users.noreply.github.com']);
      await checked('git', ['add', '--all']);
      await checked('git', ['commit', '-m', UPDATE_TITLE]);
      const remote = await checked('git', ['ls-remote', 'origin', `refs/heads/${branch}`]);
      const expected = remote.split(/\s+/)[0] || '';
      await checked('git', [
        'push', `--force-with-lease=refs/heads/${branch}:${expected}`,
        'origin', `HEAD:refs/heads/${branch}`,
      ]);
    },
    createPullRequest: ({ title, body, branch }) => checked('gh', [
      'pr', 'create', '--head', branch, '--title', title, '--body', body,
    ]),
    updatePullRequest: (number, { title, body }) => checked('gh', [
      'pr', 'edit', String(number), '--title', title, '--body', body,
    ]),
  };
}

export async function runCli(options = {}) {
  let report;
  try {
    report = await orchestrateUpdatePullRequest(createSystemAdapters(options));
  } catch (error) {
    report = { status: 'failed', branch: UPDATE_BRANCH, reason: error.message };
  }
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(rendered);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Agent Workflow Kit update\n\n\`\`\`json\n${rendered}\`\`\`\n`);
  }
  if (report.status === 'conflicted') process.exitCode = 2;
  else if (report.status === 'failed') process.exitCode = 1;
  return report;
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.includes('help')) {
    process.stdout.write('Usage: agent-workflow-kit-update-pr\n');
  } else {
    await runCli();
  }
}
