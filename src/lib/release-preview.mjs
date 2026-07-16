import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nextVersion, parseSemver } from './semver.mjs';

export const PROJECT_RELEASE_PROFILE = 'docs/agents/workflow-capabilities.json';

export async function loadProjectReleaseProfile(consumerRoot) {
  const profile = JSON.parse(
    await readFile(join(consumerRoot, PROJECT_RELEASE_PROFILE), 'utf8'),
  );
  if (profile.schemaVersion !== 1 || !profile.projectRelease) {
    throw new Error('project release profile must contain schemaVersion 1 and projectRelease');
  }
  if (!Array.isArray(profile.projectRelease.versionFiles)
      || profile.projectRelease.versionFiles.length === 0) {
    throw new Error('project release profile requires at least one versionFiles entry');
  }
  return profile.projectRelease;
}

async function readVersionFile(consumerRoot, path) {
  const raw = await readFile(join(consumerRoot, path), 'utf8');
  const body = JSON.parse(raw);
  return {
    path,
    version: body.version,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

export async function previewProjectRelease(options) {
  const {
    consumerRoot, profile, requestedVersion,
    repositoryFacts = { dirtyPaths: [], existingTags: [] },
  } = options;
  const files = await Promise.all(
    profile.versionFiles.map((path) => readVersionFile(consumerRoot, path)),
  );
  const currentVersion = files[0].version;
  const paths = files.map(({ path }) => path);
  const invalidFiles = files.filter(({ version }) => {
    try { parseSemver(version); return false; } catch { return true; }
  });
  if (invalidFiles.length) {
    return {
      status: 'blocked',
      summary: {
        currentVersion,
        targetVersion: null,
        packageCount: paths.length,
        synchronizedFiles: paths,
      },
      blockers: [{
        code: 'invalid-current-version',
        files: invalidFiles.map(({ path, version }) => ({ path, version })),
      }],
      actions: [],
      repositoryFacts,
    };
  }
  let targetVersion;
  try {
    targetVersion = nextVersion(currentVersion, requestedVersion);
  } catch {
    return {
      status: 'blocked',
      summary: {
        currentVersion,
        targetVersion: null,
        packageCount: paths.length,
        synchronizedFiles: paths,
      },
      blockers: [{ code: 'invalid-target-version', requestedVersion }],
      actions: [],
      repositoryFacts,
    };
  }
  const tag = `${profile.tagPrefix ?? 'v'}${targetVersion}`;
  const blockers = [];
  if (files.some(({ version }) => version !== currentVersion)) {
    blockers.push({
      code: 'divergent-versions',
      files: files.map(({ path, version }) => ({ path, version })),
    });
  }
  const dirtyTargets = paths.filter((path) => repositoryFacts.dirtyPaths.includes(path));
  if (dirtyTargets.length) blockers.push({ code: 'dirty-targets', paths: dirtyTargets });
  if (repositoryFacts.existingTags.includes(tag)) {
    blockers.push({ code: 'existing-tag', tag });
  }
  const snapshot = files.map(({ path, sha256 }) => ({ path, sha256 }));
  const confirmation = createHash('sha256').update(JSON.stringify({
    currentVersion, targetVersion, snapshot, tag,
  })).digest('hex');
  return {
    status: blockers.length ? 'blocked' : 'ready',
    summary: {
      currentVersion,
      targetVersion,
      packageCount: paths.length,
      synchronizedFiles: paths,
    },
    blockers,
    actions: [
      { type: 'write-version', version: targetVersion, paths },
      { type: 'commit', message: `chore: prepare project release ${targetVersion}` },
      { type: 'tag', name: tag },
    ],
    repositoryFacts,
    snapshot,
    confirmation,
  };
}
