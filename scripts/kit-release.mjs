/** Deterministic release preparation; landing remains owned by wrapup. */
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { applyProjectRelease } from '../src/lib/release-apply.mjs';
import { previewProjectRelease } from '../src/lib/release-preview.mjs';
import { nextVersion } from '../src/lib/semver.mjs';
import { buildKit } from './build-kit.mjs';
import { checkReleaseDelta } from './release-delta-guard.mjs';

const exec = promisify(execFile);

export { nextVersion };

function note(version, delta) {
  const lines = ['added', 'removed', 'changed'].flatMap((kind) =>
    delta[kind].map((path) => `- ${kind}: \`${path}\``));
  return `### ${version}\n\n${lines.join('\n') || '- Metadata-only release.'}\n\n`;
}

async function updateMetadata(repoRoot, targetVersion, delta) {
  const packagePath = join(repoRoot, 'package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  const resumed = pkg.version === targetVersion;
  if (!resumed) {
    const preview = await previewProjectRelease({
      consumerRoot: repoRoot,
      profile: { versionFiles: ['package.json'], tagPrefix: 'v' },
      requestedVersion: targetVersion,
      repositoryFacts: { dirtyPaths: [], existingTags: [] },
    });
    await applyProjectRelease({
      consumerRoot: repoRoot,
      preview,
      confirmation: preview.confirmation,
    });
  }
  const readmePath = join(repoRoot, 'README.md');
  const readme = await readFile(readmePath, 'utf8');
  const marker = '## Release notes\n\n';
  if (!readme.includes(marker)) throw new Error('README release-notes marker not found');
  const heading = `### ${targetVersion}\n\n`;
  const next = readme.includes(heading)
    ? readme.replace(new RegExp(`### ${targetVersion.replaceAll('.', '\\.')}\\n\\n[\\s\\S]*?(?=### |$)`), note(targetVersion, delta))
    : readme.replace(marker, marker + note(targetVersion, delta));
  if (next !== readme) await writeFile(readmePath, next);
  return resumed;
}

async function freshManifest(repoRoot) {
  const distDir = await mkdtemp(join(tmpdir(), 'awkit-release-'));
  try {
    await buildKit({ repoRoot, distDir });
    return JSON.parse(await readFile(join(distDir, 'agent-workflow-kit.package.json'), 'utf8'));
  } finally { await rm(distDir, { recursive: true, force: true }); }
}

async function defaultRun(command, args, repoRoot) {
  await exec(command, args, { cwd: repoRoot });
}

export async function prepareRelease(options) {
  const { repoRoot, targetVersion, delta } = options;
  if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) throw new Error(`invalid target version: ${targetVersion}`);
  const resumed = await updateMetadata(repoRoot, targetVersion, delta);
  const manifest = await (options.buildManifest ?? freshManifest)(repoRoot);
  if (manifest.kitVersion !== targetVersion) {
    throw new Error(`built manifest version ${manifest.kitVersion} != target ${targetVersion}`);
  }
  await writeFile(join(repoRoot, 'agent-workflow-kit.package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const run = options.run ?? ((command, args) => defaultRun(command, args, repoRoot));
  await run('npm', ['run', 'release:guard']);
  await run('npm', ['test']);
  await run('npm', ['pack', '--dry-run']);
  return { status: resumed ? 'resumed' : 'prepared', targetVersion };
}

async function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const baseAt = process.argv.indexOf('--base');
  const versionAt = process.argv.indexOf('--version');
  const baseRef = baseAt < 0 ? 'origin/main' : process.argv[baseAt + 1];
  const plan = await checkReleaseDelta({ repoRoot, baseRef });
  if (versionAt < 0) {
    console.log(JSON.stringify({ ...plan, confirmedTargetRequired: true }, null, 2));
    return;
  }
  const targetVersion = process.argv[versionAt + 1];
  const releasedVersion = JSON.parse(execFileSync('git', ['show', `${baseRef}:package.json`], {
    cwd: repoRoot, encoding: 'utf8',
  })).version;
  const allowed = ['patch', 'minor', 'major'].map((bump) => nextVersion(releasedVersion, bump));
  if (!allowed.includes(targetVersion)) {
    throw new Error(`target ${targetVersion} is not one Semver bump from ${releasedVersion}`);
  }
  const result = await prepareRelease({ repoRoot, targetVersion, delta: plan.delta });
  console.log(`release prepared at ${result.targetVersion} (${result.status}); hand off to wrapup`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(`kit-release: ${error.message}`); process.exitCode = 1; });
}
