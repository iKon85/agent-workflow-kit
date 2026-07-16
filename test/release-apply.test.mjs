import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyProjectRelease } from '../src/lib/release-apply.mjs';
import {
  loadProjectReleaseProfile, previewProjectRelease,
} from '../src/lib/release-preview.mjs';
import { writeAtomic } from '../src/lib/atomicWrite.mjs';
import { runProjectRelease } from '../scripts/project-release.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(name) {
  const root = await mkdtemp(join(tmpdir(), `project-release-${name}-`));
  await cp(join(REPO, 'test/fixtures/project-release', name), root, { recursive: true });
  return root;
}

async function versionAt(root, path) {
  return JSON.parse(await readFile(join(root, path), 'utf8')).version;
}

async function readyPreview(root, requestedVersion = 'minor') {
  const profile = await loadProjectReleaseProfile(root);
  const preview = await previewProjectRelease({
    consumerRoot: root,
    profile,
    requestedVersion,
    repositoryFacts: { dirtyPaths: [], existingTags: [] },
  });
  return { profile, preview };
}

test('an approved preview updates exactly the profiled Testreporter package set', async () => {
  const root = await fixture('testreporter');
  try {
    const { profile, preview } = await readyPreview(root);
    const result = await applyProjectRelease({
      consumerRoot: root,
      preview,
      confirmation: preview.confirmation,
    });
    assert.deepEqual(result, {
      status: 'prepared',
      version: '2.9.0',
      updated: profile.versionFiles,
      plannedTag: 'v2.9.0',
    });
    assert.deepEqual(
      await Promise.all(profile.versionFiles.map((path) => versionAt(root, path))),
      ['2.9.0', '2.9.0', '2.9.0'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('patch, minor, major, and explicit previews update the exact generic package set', async () => {
  for (const [requestedVersion, expectedVersion] of [
    ['patch', '0.4.10'],
    ['minor', '0.5.0'],
    ['major', '1.0.0'],
    ['3.2.1', '3.2.1'],
  ]) {
    const root = await fixture('generic');
    try {
      const { profile, preview } = await readyPreview(root, requestedVersion);
      const result = await applyProjectRelease({
        consumerRoot: root,
        preview,
        confirmation: preview.confirmation,
      });
      assert.equal(result.version, expectedVersion);
      assert.deepEqual(
        await Promise.all(profile.versionFiles.map((path) => versionAt(root, path))),
        [expectedVersion, expectedVersion],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('invalid, dirty, and existing-tag previews fail without changing package bytes', async () => {
  const cases = [
    {
      requestedVersion: 'banana',
      repositoryFacts: { dirtyPaths: [], existingTags: [] },
      error: /preview is blocked/,
    },
    {
      requestedVersion: 'minor',
      repositoryFacts: { dirtyPaths: ['modules/cli/package.json'], existingTags: [] },
      error: /preview is blocked/,
    },
    {
      requestedVersion: 'minor',
      repositoryFacts: { dirtyPaths: [], existingTags: ['release-0.5.0'] },
      error: /preview is blocked/,
    },
  ];
  for (const scenario of cases) {
    const root = await fixture('generic');
    try {
      const profile = await loadProjectReleaseProfile(root);
      const before = await Promise.all(
        profile.versionFiles.map((path) => readFile(join(root, path), 'utf8')),
      );
      const preview = await previewProjectRelease({
        consumerRoot: root,
        profile,
        requestedVersion: scenario.requestedVersion,
        repositoryFacts: scenario.repositoryFacts,
      });
      await assert.rejects(applyProjectRelease({
        consumerRoot: root,
        preview,
        confirmation: preview.confirmation,
      }), scenario.error);
      const after = await Promise.all(
        profile.versionFiles.map((path) => readFile(join(root, path), 'utf8')),
      );
      assert.deepEqual(after, before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('a stale or mismatched confirmation fails before the first write', async () => {
  const root = await fixture('generic');
  try {
    const { profile, preview } = await readyPreview(root);
    const before = await Promise.all(
      profile.versionFiles.map((path) => readFile(join(root, path), 'utf8')),
    );
    await assert.rejects(applyProjectRelease({
      consumerRoot: root,
      preview,
      confirmation: 'wrong-confirmation',
    }), /confirmation does not match/);
    const changedPath = join(root, profile.versionFiles[1]);
    const changed = JSON.parse(await readFile(changedPath, 'utf8'));
    changed.consumerField = 'changed after preview';
    await writeFile(changedPath, `${JSON.stringify(changed, null, 2)}\n`);
    await assert.rejects(applyProjectRelease({
      consumerRoot: root,
      preview,
      confirmation: preview.confirmation,
    }), /target changed after preview/);
    assert.deepEqual(
      await readFile(join(root, profile.versionFiles[0]), 'utf8'),
      before[0],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a partial write failure rolls every package back to its exact original bytes', async () => {
  const root = await fixture('testreporter');
  try {
    const { profile, preview } = await readyPreview(root);
    const before = await Promise.all(
      profile.versionFiles.map((path) => readFile(join(root, path))),
    );
    let writes = 0;
    await assert.rejects(applyProjectRelease({
      consumerRoot: root,
      preview,
      confirmation: preview.confirmation,
      write: async (path, body) => {
        writes += 1;
        if (writes === 2) throw new Error('injected partial write');
        await writeAtomic(path, body);
      },
    }), /injected partial write/);
    const after = await Promise.all(
      profile.versionFiles.map((path) => readFile(join(root, path))),
    );
    assert.deepEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('re-running an applied preview fails without a second bump or tag action', async () => {
  const root = await fixture('generic');
  try {
    const { profile, preview } = await readyPreview(root, 'patch');
    await applyProjectRelease({
      consumerRoot: root,
      preview,
      confirmation: preview.confirmation,
    });
    await assert.rejects(applyProjectRelease({
      consumerRoot: root,
      preview,
      confirmation: preview.confirmation,
    }), /already prepared at 0\.4\.10/);
    assert.deepEqual(
      await Promise.all(profile.versionFiles.map((path) => versionAt(root, path))),
      ['0.4.10', '0.4.10'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the thin project-release entry point previews, confirms, and applies without commit or tag writes', async () => {
  const root = await fixture('generic');
  const facts = { dirtyPaths: [], existingTags: [] };
  try {
    const previewLines = [];
    const preview = await runProjectRelease({
      consumerRoot: root,
      args: ['preview', 'minor'],
      repositoryFacts: facts,
      output: (line) => previewLines.push(line),
    });
    assert.equal(JSON.parse(previewLines[0]).status, 'ready');
    const applyLines = [];
    const result = await runProjectRelease({
      consumerRoot: root,
      args: ['apply', 'minor', '--confirm', preview.confirmation],
      repositoryFacts: facts,
      output: (line) => applyLines.push(line),
    });
    assert.equal(result.status, 'prepared');
    assert.deepEqual(JSON.parse(applyLines[0]), result);
    assert.equal(await versionAt(root, 'package.json'), '0.5.0');
    await assert.rejects(readFile(join(root, '.git/refs/tags/release-0.5.0')), {
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('apply rejects absolute, escaping, and symlinked targets before any write', async () => {
  const root = await fixture('generic');
  const outside = await mkdtemp(join(tmpdir(), 'project-release-outside-'));
  try {
    for (const path of ['/tmp/outside-package.json', '../outside/package.json']) {
      await assert.rejects(applyProjectRelease({
        consumerRoot: root,
        preview: {
          status: 'ready',
          confirmation: 'token',
          snapshot: [{ path, sha256: 'unused' }],
          summary: { targetVersion: '1.0.0' },
          actions: [{ type: 'tag', name: 'v1.0.0' }],
        },
        confirmation: 'token',
      }), /outside consumer root/);
    }
    const link = join(root, 'linked-package.json');
    await writeFile(join(outside, 'package.json'), '{"version":"0.4.9"}\n');
    await symlink(join(outside, 'package.json'), link);
    await assert.rejects(applyProjectRelease({
      consumerRoot: root,
      preview: {
        status: 'ready',
        confirmation: 'token',
        snapshot: [{ path: 'linked-package.json', sha256: 'unused' }],
        summary: { targetVersion: '1.0.0' },
        actions: [{ type: 'tag', name: 'v1.0.0' }],
      },
      confirmation: 'token',
    }), /symlinked release target/);
    assert.equal(await readFile(join(outside, 'package.json'), 'utf8'), '{"version":"0.4.9"}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
