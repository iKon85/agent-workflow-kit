import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCommandAdapter, githubReleaseArgs, inspectRelease, isMissingRelease,
  npmTarballFilename, reconcileRelease,
} from './release-state.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const identity = {
  name: '@ikon85/agent-workflow-kit', version: '1.2.3',
  tarballIntegrity: 'sha512-example', manifestSha256: 'abc123',
};

function adapter({ npmPublished = false, githubReleased = false, npmIdentity = identity } = {}) {
  const events = [];
  let npmExists = npmPublished;
  let githubExists = githubReleased;
  return {
    events,
    local: async () => ({ identity, tarball: '/tmp/kit.tgz' }),
    npm: async () => { events.push('read npm'); return npmExists ? npmIdentity : null; },
    github: async () => { events.push('read github'); return githubExists ? identity : null; },
    publishNpm: async () => { events.push('publish npm'); npmExists = true; },
    createGithub: async () => { events.push('create github'); githubExists = true; },
  };
}

test('a fresh release publishes npm, verifies registry readback, then creates GitHub release', async () => {
  const fixture = adapter();
  assert.deepEqual(await reconcileRelease(fixture), { status: 'released', identity });
  assert.deepEqual(fixture.events, [
    'read npm', 'read github', 'publish npm', 'read npm', 'create github', 'read github',
  ]);
});

test('an npm-published release resumes at GitHub without a second npm publish', async () => {
  const fixture = adapter({ npmPublished: true });
  await reconcileRelease(fixture);
  assert.deepEqual(fixture.events, ['read npm', 'read github', 'create github', 'read github']);
  assert.ok(!fixture.events.includes('publish npm'));
});

test('post-merge status inspection is read-only and reports the reconstructable phase', async () => {
  const fixture = adapter({ npmPublished: true });
  assert.deepEqual(await inspectRelease(fixture), { status: 'awaiting-github', identity });
  assert.deepEqual(fixture.events, ['read npm', 'read github']);
});

test('an unpublished npm version is reconstructable when npm reports ETARGET', () => {
  assert.equal(isMissingRelease({
    stderr: 'npm error code ETARGET\nnpm error notarget No matching version found',
  }, 'npm'), true);
});

test('a mismatching npm package blocks GitHub release creation', async () => {
  const fixture = adapter({
    npmPublished: true,
    npmIdentity: { ...identity, manifestSha256: 'wrong' },
  });
  await assert.rejects(reconcileRelease(fixture), /npm manifestSha256 mismatch/);
  assert.ok(!fixture.events.includes('create github'));
});

test('release workflow uses supported OIDC trusted publishing without a long-lived npm token', async () => {
  const workflow = await readFile(join(REPO, '.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /node-version:\s*22\.14/);
  assert.match(workflow, /npm@11\.5\.1/);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /contents:\s*write/);
  assert.match(workflow, /registry-url:\s*['"]https:\/\/registry\.npmjs\.org['"]/);
  assert.match(workflow, /node scripts\/release-state\.mjs/);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|npm_[A-Za-z0-9]/);
});

test('the production publisher explicitly requests npm provenance', async () => {
  const commands = [];
  const fixture = await createCommandAdapter({
    repoRoot: REPO,
    run: async (command, args) => { commands.push([command, ...args]); return { stdout: '' }; },
  });
  try {
    await fixture.publishNpm({ tarball: '/tmp/kit.tgz' });
    assert.deepEqual(commands, [[
      'npm', 'publish', '/tmp/kit.tgz', '--access', 'public', '--provenance',
    ]]);
  } finally { await fixture.dispose(); }
});

test('an incomplete GitHub release resumes by uploading the verified registry tarball', () => {
  assert.deepEqual(githubReleaseArgs({
    exists: true, tag: 'v1.2.3', tarball: '/tmp/ikon85-agent-workflow-kit-1.2.3.tgz', target: 'abc123',
  }), [
    'release', 'upload', 'v1.2.3', '/tmp/ikon85-agent-workflow-kit-1.2.3.tgz', '--clobber',
  ]);
});

test('a scoped npm identity maps to the registry tarball asset name', () => {
  assert.equal(
    npmTarballFilename('@ikon85/agent-workflow-kit', '1.2.3'),
    'ikon85-agent-workflow-kit-1.2.3.tgz',
  );
});
