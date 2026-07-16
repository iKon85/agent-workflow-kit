#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

async function defaultRunGit(cwd, args) {
  const result = await exec('git', args, { cwd });
  return result.stdout.trim();
}

export async function installGitHooks({
  cwd = process.cwd(),
  hooksPath = '.githooks',
  runGit = defaultRunGit,
} = {}) {
  try {
    await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch (error) {
    if (error?.code === 128) return { status: 'not-a-repository' };
    throw error;
  }

  let current = '';
  try {
    current = await runGit(cwd, ['config', '--get', 'core.hooksPath']);
  } catch (error) {
    if (error?.code !== 1) throw error;
  }
  if (current === hooksPath) return { status: 'unchanged', hooksPath };

  await runGit(cwd, ['config', 'core.hooksPath', hooksPath]);
  return { status: 'wired', hooksPath };
}

async function main() {
  const hooksPath = process.argv[2] ?? '.githooks';
  const result = await installGitHooks({ hooksPath });
  if (result.status === 'not-a-repository') {
    console.log('Git hooks not wired: current directory is not a Git work tree.');
    return;
  }
  console.log(`Git hooks ${result.status}: core.hooksPath=${result.hooksPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Git hook wiring failed: ${error.message}`);
    process.exitCode = 1;
  });
}
