/** Block shipped changes whose version or checked manifest does not match a fresh build. */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUB_TARGETS, isPublishExcluded } from '../src/lib/bundle.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { buildKit } from './build-kit.mjs';

const byPath = (manifest) => new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));

export function manifestDelta(before, after) {
  const old = byPath(before);
  const fresh = byPath(after);
  return {
    added: [...fresh.keys()].filter((path) => !old.has(path)).sort(),
    removed: [...old.keys()].filter((path) => !fresh.has(path)).sort(),
    changed: [...fresh.keys()].filter((path) => old.has(path) && old.get(path) !== fresh.get(path)).sort(),
  };
}

const hasDelta = (delta) => Object.values(delta).some((paths) => paths.length);
const describe = (delta) => ['added', 'removed', 'changed']
  .filter((kind) => delta[kind].length)
  .map((kind) => `${kind}: ${delta[kind].join(', ')}`).join('; ');

function mergeDeltas(...deltas) {
  return Object.fromEntries(['added', 'removed', 'changed'].map((kind) => [
    kind, [...new Set(deltas.flatMap((delta) => delta[kind]))].sort(),
  ]));
}

export function recommendBump(delta, { minorRemovals = [] } = {}) {
  const minorRemovalSet = new Set(minorRemovals);
  if (delta.removed.some((path) => !minorRemovalSet.has(path))) return 'major';
  if (delta.added.length || delta.removed.length) return 'minor';
  return delta.changed.length ? 'patch' : null;
}

function bumpKind(before, after) {
  const a = before.split('.').map(Number);
  const b = after.split('.').map(Number);
  if (b[0] > a[0]) return 'major';
  if (b[0] === a[0] && b[1] > a[1]) return 'minor';
  if (b[0] === a[0] && b[1] === a[1] && b[2] > a[2]) return 'patch';
  return null;
}

export function assessRelease(input) {
  const bundleDelta = manifestDelta(input.baseManifest, input.builtManifest);
  const packageDelta = input.basePackagePayload && input.currentPackagePayload
    ? manifestDelta(input.basePackagePayload, input.currentPackagePayload)
    : { added: [], removed: [], changed: [] };
  const delta = mergeDeltas(bundleDelta, packageDelta);
  const checkedDrift = manifestDelta(input.checkedManifest, input.builtManifest);
  const payloadDrift = manifestDelta(input.builtManifest, input.payloadManifest);
  const errors = [];
  if (hasDelta(delta) && input.currentVersion === input.baseVersion) {
    errors.push(`shipped delta has no version bump (${describe(delta)}); version remains ${input.currentVersion}`);
  }
  if (input.checkedManifest.kitVersion !== input.currentVersion) {
    errors.push(`checked manifest version ${input.checkedManifest.kitVersion} != package ${input.currentVersion}`);
  }
  for (const path of checkedDrift.removed) errors.push(`checked manifest dead entry: ${path}`);
  if (checkedDrift.added.length || checkedDrift.changed.length) {
    errors.push(`checked manifest is stale (${describe(checkedDrift)})`);
  }
  if (hasDelta(payloadDrift)) {
    errors.push(`npm package payload does not match built manifest (${describe(payloadDrift)})`);
  }
  // Merging integrates a prepared version; only its annotated tag publishes it.
  // Nothing else notices when that tag never arrives, so the next release PR
  // would silently stack on top and the skipped version would never exist as
  // its own artifact. Block that here, where a human is present anyway. A
  // repository without any matching tag is bootstrapping, not stacking.
  const { baseTag } = input;
  if (baseTag?.repoHasTags && !baseTag.exists && input.currentVersion !== input.baseVersion) {
    errors.push(
      `previous release ${input.baseVersion} is still awaiting-tag (no ${baseTag.name} tag); `
      + `tag and publish it before preparing ${input.currentVersion}`,
    );
  }
  // Project-layer stubs are seed inputs, never installed Consumer files, and
  // publish-excluded sources (tests, build tooling, maintainer docs) are never
  // installed either. Removing an accidentally packed copy of either is
  // additive hygiene, unless the same path also disappeared from the actual
  // Consumer bundle.
  const payloadOnlyRemovals = packageDelta.removed.filter(
    (path) => (STUB_TARGETS.includes(path) || isPublishExcluded(path))
      && !bundleDelta.removed.includes(path),
  );
  const recommendedBump = recommendBump(delta, { minorRemovals: payloadOnlyRemovals });
  const actual = bumpKind(input.baseVersion, input.currentVersion);
  const rank = { patch: 1, minor: 2, major: 3 };
  if (hasDelta(delta) && input.currentVersion !== input.baseVersion && !actual) {
    errors.push(`invalid version transition: ${input.baseVersion} -> ${input.currentVersion}`);
  }
  if (recommendedBump && actual && rank[actual] < rank[recommendedBump]) {
    errors.push(`${actual} bump is smaller than recommended ${recommendedBump} (${describe(delta)})`);
  }
  return { ok: errors.length === 0, errors, delta, recommendedBump };
}

function gitShowJson(repoRoot, ref, path) {
  return JSON.parse(execFileSync('git', ['show', `${ref}:${path}`], { cwd: repoRoot, encoding: 'utf8' }));
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export function resolveBaseTag({ repoRoot, baseVersion, tagPrefix = 'v' }) {
  const name = `${tagPrefix}${baseVersion}`;
  let exists = true;
  try {
    git(repoRoot, ['rev-parse', '-q', '--verify', `refs/tags/${name}`]);
  } catch { exists = false; }
  return { name, exists, repoHasTags: git(repoRoot, ['tag', '-l', `${tagPrefix}*`]) !== '' };
}

export async function packedPayloadManifest({ repoRoot, manifest }) {
  const payload = await packedPackagePayload({ repoRoot });
  const indexed = byPath(payload);
  return {
    kitVersion: manifest.kitVersion,
    files: manifest.files.map((entry) => ({
      ...entry,
      sha256: indexed.get(entry.path),
    })),
  };
}

export async function packedPackagePayload({ repoRoot }) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'awkit-package-payload-'));
  try {
    const packOutput = execFileSync(
      'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tempRoot],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const [{ filename }] = JSON.parse(packOutput);
    const unpackDir = join(tempRoot, 'unpacked');
    await mkdir(unpackDir);
    execFileSync('tar', ['-xzf', join(tempRoot, filename), '-C', unpackDir]);
    return {
      files: await packageFiles(join(unpackDir, 'package')),
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function packageFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await packageFiles(root, path));
    else if (entry.isFile()) {
      files.push({ path, sha256: sha256(await readFile(join(root, path))) });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function packagePayloadAtRef(repoRoot, ref) {
  const archiveRoot = await mkdtemp(join(tmpdir(), 'awkit-package-base-'));
  try {
    const archive = execFileSync('git', ['archive', '--format=tar', ref], {
      cwd: repoRoot, maxBuffer: 50 * 1024 * 1024,
    });
    execFileSync('tar', ['-xf', '-', '-C', archiveRoot], { input: archive });
    return await packedPackagePayload({ repoRoot: archiveRoot });
  } finally {
    await rm(archiveRoot, { recursive: true, force: true });
  }
}

export async function checkReleaseDelta({ repoRoot, baseRef = 'origin/main' } = {}) {
  repoRoot ??= join(dirname(fileURLToPath(import.meta.url)), '..');
  const distDir = await mkdtemp(join(tmpdir(), 'awkit-release-guard-'));
  try {
    await buildKit({ repoRoot, distDir });
    const currentPackage = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    const builtManifest = JSON.parse(await readFile(join(distDir, 'agent-workflow-kit.package.json'), 'utf8'));
    const baseVersion = gitShowJson(repoRoot, baseRef, 'package.json').version;
    const currentPackagePayload = await packedPackagePayload({ repoRoot });
    return assessRelease({
      baseVersion,
      baseTag: resolveBaseTag({ repoRoot, baseVersion }),
      currentVersion: currentPackage.version,
      baseManifest: gitShowJson(repoRoot, baseRef, 'agent-workflow-kit.package.json'),
      checkedManifest: JSON.parse(await readFile(join(repoRoot, 'agent-workflow-kit.package.json'), 'utf8')),
      builtManifest,
      payloadManifest: {
        kitVersion: builtManifest.kitVersion,
        files: builtManifest.files.map((entry) => ({
          ...entry,
          sha256: byPath(currentPackagePayload).get(entry.path),
        })),
      },
      basePackagePayload: await packagePayloadAtRef(repoRoot, baseRef),
      currentPackagePayload,
    });
  } finally { await rm(distDir, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const baseIndex = process.argv.indexOf('--base');
  checkReleaseDelta({ baseRef: baseIndex < 0 ? undefined : process.argv[baseIndex + 1] })
    .then((result) => {
      if (result.ok) return console.log(`release:guard — OK${result.recommendedBump ? ` (${result.recommendedBump})` : ''}`);
      console.error('release:guard — BLOCKED');
      for (const error of result.errors) console.error(`  ${error}`);
      process.exitCode = 1;
    }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
