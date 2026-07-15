import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertReleaseParity, releaseIdentityFromTarball } from './release-parity.mjs';

const exec = promisify(execFile);

const assertMatches = (local, remote, label) => assertReleaseParity({
  local,
  npm: label === 'npm' ? remote : local,
  github: label === 'github' ? remote : local,
});

export async function inspectRelease(adapter) {
  const { identity } = await adapter.local();
  const npm = await adapter.npm(identity);
  const github = await adapter.github(identity);
  if (!npm) {
    if (github) throw new Error('GitHub release exists before npm package');
    return { status: 'awaiting-npm', identity };
  }
  assertMatches(identity, npm, 'npm');
  if (!github) return { status: 'awaiting-github', identity };
  assertReleaseParity({ local: identity, npm, github });
  return { status: 'released', identity };
}

export async function reconcileRelease(adapter) {
  const { identity, tarball } = await adapter.local();
  let npm = await adapter.npm(identity);
  let github = await adapter.github(identity);

  if (!npm) {
    if (github) throw new Error('GitHub release exists before npm package');
    await adapter.publishNpm({ identity, tarball });
    npm = await adapter.npm(identity);
    if (!npm) throw new Error('npm package missing after publish');
  }
  assertMatches(identity, npm, 'npm');

  if (!github) {
    await adapter.createGithub({ identity, tarball });
    github = await adapter.github(identity);
    if (!github) throw new Error('GitHub release missing after create');
  }
  assertReleaseParity({ local: identity, npm, github });
  return { status: 'released', identity };
}

export function isMissingRelease(error, service) {
  const detail = `${error.stderr ?? ''}\n${error.message ?? ''}`;
  return service === 'npm'
    ? /E404|404 Not Found|ETARGET|No matching version found/i.test(detail)
    : /release not found|HTTP 404/i.test(detail);
}

export function githubReleaseArgs({ exists, tag, tarball, target }) {
  if (exists) return ['release', 'upload', tag, tarball, '--clobber'];
  return [
    'release', 'create', tag, tarball, '--target', target,
    '--title', tag, '--generate-notes',
  ];
}

async function packedTarball(run, spec, directory, repoRoot) {
  const { stdout } = await run(
    'npm', ['pack', spec, '--json', '--pack-destination', directory], { cwd: repoRoot },
  );
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1 || !result[0].filename) {
    throw new Error(`unexpected npm pack result for ${spec}`);
  }
  return join(directory, result[0].filename);
}

function releaseReaders(context) {
  const { run, repoRoot, env, scratch, state } = context;
  async function local() {
    const tarball = await packedTarball(run, '.', scratch, repoRoot);
    return { tarball, identity: await releaseIdentityFromTarball(tarball) };
  }

  async function npm(identity) {
    try {
      state.npmTarball = await packedTarball(
        run, `${identity.name}@${identity.version}`, scratch, repoRoot,
      );
      return await releaseIdentityFromTarball(state.npmTarball);
    } catch (error) {
      if (isMissingRelease(error, 'npm')) return null;
      throw error;
    }
  }

  async function github(identity) {
    const tag = `v${identity.version}`;
    try {
      await run('gh', ['release', 'view', tag, '--json', 'tagName'], { cwd: repoRoot, env });
    } catch (error) {
      if (isMissingRelease(error, 'github')) return null;
      throw error;
    }
    try {
      const asset = `${identity.name}-${identity.version}.tgz`;
      await run('gh', ['release', 'download', tag, '--pattern', asset, '--dir', scratch, '--clobber'], {
        cwd: repoRoot, env,
      });
      return await releaseIdentityFromTarball(join(scratch, asset));
    } catch (error) {
      if (/no assets match|not found/i.test(`${error.stderr ?? ''}\n${error.message ?? ''}`)) return null;
      throw error;
    }
  }

  return { local, npm, github };
}

function releaseWriters(context) {
  const { run, repoRoot, env, state } = context;
  async function publishNpm({ tarball }) {
    await run('npm', ['publish', tarball, '--access', 'public', '--provenance'], { cwd: repoRoot, env });
  }

  async function createGithub({ identity }) {
    if (!state.npmTarball) throw new Error('verified npm tarball unavailable for GitHub release');
    const tag = `v${identity.version}`;
    let exists = true;
    try {
      await run('gh', ['release', 'view', tag, '--json', 'tagName'], { cwd: repoRoot, env });
    } catch (error) {
      if (!isMissingRelease(error, 'github')) throw error;
      exists = false;
    }
    await run('gh', githubReleaseArgs({
      exists, tag, tarball: state.npmTarball, target: env.GITHUB_SHA,
    }), { cwd: repoRoot, env });
  }

  return { publishNpm, createGithub };
}

export async function createCommandAdapter({ repoRoot, run = exec, env = process.env } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'awkit-publish-'));
  const context = { run, repoRoot, env, scratch, state: {} };
  return {
    ...releaseReaders(context),
    ...releaseWriters(context),
    dispose: () => rm(scratch, { recursive: true, force: true }),
  };
}

async function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const adapter = await createCommandAdapter({ repoRoot });
  try {
    const result = process.argv.includes('--status')
      ? await inspectRelease(adapter)
      : await reconcileRelease(adapter);
    console.log(`release ${result.identity.version}: ${result.status}`);
  } finally { await adapter.dispose(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(`release-state: ${error.message}`); process.exitCode = 1; });
}
