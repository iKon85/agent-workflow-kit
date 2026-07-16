#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyProjectRelease, assertSafeReleaseTargets } from '../src/lib/release-apply.mjs';
import { loadProjectReleaseProfile, previewProjectRelease } from '../src/lib/release-preview.mjs';

function gitOutput(consumerRoot, args) {
  return execFileSync('git', args, { cwd: consumerRoot, encoding: 'utf8' });
}

export function readRepositoryFacts(consumerRoot, run = gitOutput) {
  const records = run(
    consumerRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
  ).split('\0').filter(Boolean);
  const dirtyPaths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    dirtyPaths.push(record.slice(3));
    if (record[0] === 'R' || record[0] === 'C'
        || record[1] === 'R' || record[1] === 'C') index += 1;
  }
  const existingTags = run(consumerRoot, ['tag', '--list'])
    .split('\n').filter(Boolean);
  return { dirtyPaths, existingTags };
}

function argument(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
}

export async function runProjectRelease(options) {
  const {
    consumerRoot, args,
    repositoryFacts = readRepositoryFacts(consumerRoot),
    output = console.log,
  } = options;
  const [command, requestedVersion] = args;
  if (!['preview', 'apply'].includes(command) || !requestedVersion) {
    throw new Error('usage: project-release <preview|apply> <patch|minor|major|version> [--confirm <token>]');
  }
  const profile = await loadProjectReleaseProfile(consumerRoot);
  await assertSafeReleaseTargets(consumerRoot, profile.versionFiles);
  const preview = await previewProjectRelease({
    consumerRoot, profile, requestedVersion, repositoryFacts,
  });
  if (command === 'preview') {
    output(JSON.stringify(preview));
    return preview;
  }
  const result = await applyProjectRelease({
    consumerRoot,
    preview,
    confirmation: argument(args, '--confirm'),
  });
  output(JSON.stringify(result));
  return result;
}

async function main() {
  await runProjectRelease({ consumerRoot: process.cwd(), args: process.argv.slice(2) });
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`project-release: ${error.message}`);
    process.exitCode = 1;
  });
}
