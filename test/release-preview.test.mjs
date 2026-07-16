import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadProjectReleaseProfile, previewProjectRelease,
} from '../src/lib/release-preview.mjs';
import { nextVersion } from '../src/lib/semver.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

test('patch, minor, major, and explicit targets resolve from one SemVer primitive', () => {
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(nextVersion('1.2.3', '2.4.0'), '2.4.0');
});

async function consumerFixture(versions = ['1.2.3', '1.2.3', '1.2.3']) {
  const root = await mkdtemp(join(tmpdir(), 'project-release-preview-'));
  const paths = ['package.json', 'packages/api/package.json', 'packages/web/package.json'];
  for (const [index, path] of paths.entries()) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), `${JSON.stringify({
      name: path, version: versions[index],
    }, null, 2)}\n`);
  }
  return { root, paths };
}

test('a multi-package preview reports the exact version, package set, and planned actions without writes', async () => {
  const fixture = await consumerFixture();
  try {
    const before = await Promise.all(fixture.paths.map((path) => readFile(join(fixture.root, path), 'utf8')));
    const preview = await previewProjectRelease({
      consumerRoot: fixture.root,
      profile: { versionFiles: fixture.paths, tagPrefix: 'v' },
      requestedVersion: 'minor',
      repositoryFacts: { dirtyPaths: [], existingTags: [] },
    });
    assert.deepEqual(preview.summary, {
      currentVersion: '1.2.3',
      targetVersion: '1.3.0',
      packageCount: 3,
      synchronizedFiles: fixture.paths,
    });
    assert.deepEqual(preview.actions, [
      { type: 'write-version', version: '1.3.0', paths: fixture.paths },
      { type: 'commit', message: 'chore: prepare project release 1.3.0' },
      { type: 'tag', name: 'v1.3.0' },
    ]);
    assert.deepEqual(preview.blockers, []);
    assert.equal(preview.status, 'ready');
    const after = await Promise.all(fixture.paths.map((path) => readFile(join(fixture.root, path), 'utf8')));
    assert.deepEqual(after, before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('divergent package versions are a visible blocker', async () => {
  const fixture = await consumerFixture(['1.2.3', '1.2.4', '1.2.3']);
  try {
    const preview = await previewProjectRelease({
      consumerRoot: fixture.root,
      profile: { versionFiles: fixture.paths, tagPrefix: 'v' },
      requestedVersion: 'patch',
      repositoryFacts: { dirtyPaths: [], existingTags: [] },
    });
    assert.equal(preview.status, 'blocked');
    assert.deepEqual(preview.blockers, [{
      code: 'divergent-versions',
      files: [
        { path: 'package.json', version: '1.2.3' },
        { path: 'packages/api/package.json', version: '1.2.4' },
        { path: 'packages/web/package.json', version: '1.2.3' },
      ],
    }]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('dirty version targets block the preview before any write', async () => {
  const fixture = await consumerFixture();
  try {
    const preview = await previewProjectRelease({
      consumerRoot: fixture.root,
      profile: { versionFiles: fixture.paths, tagPrefix: 'v' },
      requestedVersion: 'patch',
      repositoryFacts: {
        dirtyPaths: ['README.md', 'packages/api/package.json'],
        existingTags: [],
      },
    });
    assert.equal(preview.status, 'blocked');
    assert.deepEqual(preview.blockers, [{
      code: 'dirty-targets',
      paths: ['packages/api/package.json'],
    }]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('an existing target tag is a visible blocker', async () => {
  const fixture = await consumerFixture();
  try {
    const preview = await previewProjectRelease({
      consumerRoot: fixture.root,
      profile: { versionFiles: fixture.paths, tagPrefix: 'release-' },
      requestedVersion: '2.0.0',
      repositoryFacts: { dirtyPaths: [], existingTags: ['release-2.0.0'] },
    });
    assert.equal(preview.status, 'blocked');
    assert.deepEqual(preview.blockers, [{
      code: 'existing-tag',
      tag: 'release-2.0.0',
    }]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('an invalid package version is reported instead of escaping as an opaque error', async () => {
  const fixture = await consumerFixture(['not-semver', 'not-semver', 'not-semver']);
  try {
    const preview = await previewProjectRelease({
      consumerRoot: fixture.root,
      profile: { versionFiles: fixture.paths, tagPrefix: 'v' },
      requestedVersion: 'patch',
      repositoryFacts: { dirtyPaths: [], existingTags: [] },
    });
    assert.equal(preview.status, 'blocked');
    assert.deepEqual(preview.blockers, [{
      code: 'invalid-current-version',
      files: fixture.paths.map((path) => ({ path, version: 'not-semver' })),
    }]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('an invalid requested version is a visible blocker', async () => {
  const fixture = await consumerFixture();
  try {
    const preview = await previewProjectRelease({
      consumerRoot: fixture.root,
      profile: { versionFiles: fixture.paths, tagPrefix: 'v' },
      requestedVersion: 'banana',
      repositoryFacts: { dirtyPaths: [], existingTags: [] },
    });
    assert.equal(preview.status, 'blocked');
    assert.deepEqual(preview.blockers, [{
      code: 'invalid-target-version',
      requestedVersion: 'banana',
    }]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('the structured preview is repeatable and carries a stable confirmation token', async () => {
  const fixture = await consumerFixture();
  const options = {
    consumerRoot: fixture.root,
    profile: { versionFiles: fixture.paths, tagPrefix: 'v' },
    requestedVersion: 'patch',
    repositoryFacts: { dirtyPaths: [], existingTags: [] },
  };
  try {
    const first = await previewProjectRelease(options);
    const second = await previewProjectRelease(options);
    assert.deepEqual(second, first);
    assert.match(first.confirmation, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.snapshot.map(({ path }) => path), fixture.paths);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('consumer-owned generic and frozen Testreporter profiles produce the same external preview verdict', async () => {
  const cases = [
    {
      name: 'generic',
      version: '0.4.9',
      target: '0.5.0',
      paths: ['package.json', 'modules/cli/package.json'],
    },
    {
      name: 'testreporter',
      version: '2.8.1',
      target: '2.9.0',
      paths: ['package.json', 'frontend/package.json', 'backend/package.json'],
    },
  ];
  for (const expected of cases) {
    const consumerRoot = join(REPO, 'test/fixtures/project-release', expected.name);
    const profile = await loadProjectReleaseProfile(consumerRoot);
    const preview = await previewProjectRelease({
      consumerRoot,
      profile,
      requestedVersion: 'minor',
      repositoryFacts: { dirtyPaths: [], existingTags: [] },
    });
    assert.equal(preview.status, 'ready');
    assert.deepEqual(preview.summary, {
      currentVersion: expected.version,
      targetVersion: expected.target,
      packageCount: expected.paths.length,
      synchronizedFiles: expected.paths,
    });
  }
});

test('the install manifest ships the shared release preview primitives', async () => {
  const manifest = JSON.parse(
    await readFile(join(REPO, 'agent-workflow-kit.package.json'), 'utf8'),
  );
  const paths = manifest.files.map(({ path }) => path);
  assert.ok(paths.includes('src/lib/semver.mjs'));
  assert.ok(paths.includes('src/lib/release-preview.mjs'));
});
