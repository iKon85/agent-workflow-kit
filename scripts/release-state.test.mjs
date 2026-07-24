import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
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

function adapter({
  npmPublished = false,
  githubReleased = false,
  npmIdentity = identity,
  npmInvisibleReads = 0,
  githubInvisibleReads = 0,
  publishNpmError,
  createGithubError,
} = {}) {
  const events = [];
  let npmExists = npmPublished;
  let githubExists = githubReleased;
  let npmReadsUntilVisible = npmInvisibleReads;
  let githubReadsUntilVisible = githubInvisibleReads;
  return {
    events,
    local: async () => ({ identity, tarball: '/tmp/kit.tgz' }),
    npm: async () => {
      events.push('read npm');
      if (!npmExists) return null;
      if (npmReadsUntilVisible > 0) {
        npmReadsUntilVisible -= 1;
        return null;
      }
      return npmIdentity;
    },
    github: async () => {
      events.push('read github');
      if (!githubExists) return null;
      if (githubReadsUntilVisible > 0) {
        githubReadsUntilVisible -= 1;
        return null;
      }
      return identity;
    },
    publishNpm: async () => {
      events.push('publish npm');
      if (publishNpmError) throw publishNpmError;
      npmExists = true;
    },
    createGithub: async () => {
      events.push('create github');
      if (createGithubError) throw createGithubError;
      githubExists = true;
    },
  };
}

function visibilityOptions(attempts, delays = []) {
  return {
    visibility: {
      attempts,
      initialDelayMs: 10,
      backoffFactor: 2,
      sleep: async (delay) => delays.push(delay),
    },
  };
}

test('a fresh release publishes npm, verifies registry readback, then creates GitHub release', async () => {
  const fixture = adapter();
  assert.deepEqual(await reconcileRelease(fixture), { status: 'released', identity });
  assert.deepEqual(fixture.events, [
    'read npm', 'read github', 'publish npm', 'read npm', 'create github', 'read github',
  ]);
});

test('npm visibility is retried with bounded backoff after a successful publish', async () => {
  const fixture = adapter({ npmInvisibleReads: 2 });
  const delays = [];
  assert.deepEqual(
    await reconcileRelease(fixture, visibilityOptions(4, delays)),
    { status: 'released', identity },
  );
  assert.deepEqual(fixture.events, [
    'read npm', 'read github', 'publish npm',
    'read npm', 'read npm', 'read npm',
    'create github', 'read github',
  ]);
  assert.deepEqual(delays, [10, 20]);
});

test('GitHub visibility is retried with bounded backoff after a successful create', async () => {
  const fixture = adapter({ npmPublished: true, githubInvisibleReads: 2 });
  const delays = [];
  assert.deepEqual(
    await reconcileRelease(fixture, visibilityOptions(4, delays)),
    { status: 'released', identity },
  );
  assert.deepEqual(fixture.events, [
    'read npm', 'read github', 'create github', 'read github', 'read github', 'read github',
  ]);
  assert.deepEqual(delays, [10, 20]);
});

test('permanent npm absence fails at the bound with post-publish phase evidence', async () => {
  const fixture = adapter({ npmInvisibleReads: 4 });
  const delays = [];
  await assert.rejects(
    reconcileRelease(fixture, visibilityOptions(3, delays)),
    /npm publish succeeded but package was not visible after 3 npm read attempts/,
  );
  assert.deepEqual(delays, [10, 20]);
  assert.equal(fixture.events.filter((event) => event === 'read npm').length, 4);
  assert.ok(!fixture.events.includes('create github'));
});

test('permanent GitHub absence fails at the bound with post-create phase evidence', async () => {
  const fixture = adapter({ npmPublished: true, githubInvisibleReads: 4 });
  const delays = [];
  await assert.rejects(
    reconcileRelease(fixture, visibilityOptions(3, delays)),
    /GitHub release creation succeeded but release was not visible after 3 GitHub read attempts/,
  );
  assert.deepEqual(delays, [10, 20]);
  assert.equal(fixture.events.filter((event) => event === 'read github').length, 4);
  assert.ok(!fixture.events.includes('publish npm'));
});

test('a rejected publish is not reported as a post-publish visibility timeout', async () => {
  const rejected = new Error('registry rejected publish');
  const fixture = adapter({ publishNpmError: rejected });
  await assert.rejects(reconcileRelease(fixture, visibilityOptions(3)), (error) => error === rejected);
  assert.deepEqual(fixture.events, ['read npm', 'read github', 'publish npm']);
});

test('a rejected GitHub create is not reported as a post-create visibility timeout', async () => {
  const rejected = new Error('GitHub rejected release create');
  const fixture = adapter({ npmPublished: true, createGithubError: rejected });
  await assert.rejects(reconcileRelease(fixture, visibilityOptions(3)), (error) => error === rejected);
  assert.deepEqual(fixture.events, ['read npm', 'read github', 'create github']);
});

test('an npm-published release resumes at GitHub without a second npm publish', async () => {
  const fixture = adapter({ npmPublished: true });
  await reconcileRelease(fixture);
  assert.deepEqual(fixture.events, ['read npm', 'read github', 'create github', 'read github']);
  assert.ok(!fixture.events.includes('publish npm'));
});

test('an already-published release at parity is a read-only no-op', async () => {
  const fixture = adapter({ npmPublished: true, githubReleased: true });
  assert.deepEqual(await reconcileRelease(fixture), { status: 'released', identity });
  assert.deepEqual(fixture.events, ['read npm', 'read github']);
});

test('post-merge status inspection is read-only and reports the reconstructable phase', async () => {
  const fixture = adapter({ npmPublished: true });
  assert.deepEqual(await inspectRelease(fixture), { status: 'awaiting-github', identity });
  assert.deepEqual(fixture.events, ['read npm', 'read github']);
});

test('local Claude overrides cannot change the packed release identity or enter the tarball', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'awkit-local-overrides-'));
  await mkdir(join(fixture, '.claude'), { recursive: true });
  await Promise.all([
    ['package.json', 'package.json'],
    ['agent-workflow-kit.package.json', 'agent-workflow-kit.package.json'],
    ['.claude/.npmignore', '.claude/.npmignore'],
  ].map(([source, destination]) => copyFile(join(REPO, source), join(fixture, destination))));
  await writeFile(join(fixture, '.claude/shipped.json'), '{"shipped":true}\n');

  const overrides = [
    ['.claude/settings.local.json', randomUUID()],
    ['.claude/settings.local.json.backup', randomUUID()],
  ];

  const clean = await createCommandAdapter({ repoRoot: fixture });
  const local = await createCommandAdapter({ repoRoot: fixture });
  try {
    const { identity: publishedIdentity } = await clean.local();
    for (const [path, canary] of overrides) {
      await writeFile(join(fixture, path), `${canary}\n`);
    }

    const { identity, tarball } = await local.local();
    assert.deepEqual(identity, publishedIdentity);
    assert.deepEqual(await inspectRelease({
      local: async () => ({ identity, tarball }),
      npm: async () => publishedIdentity,
      github: async () => publishedIdentity,
    }), { status: 'released', identity: publishedIdentity });

    const paths = new Set(
      execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
        .trim().split('\n').map((path) => path.replace(/^package\//, '')),
    );
    assert.ok(paths.has('.claude/shipped.json'));
    const contents = execFileSync('tar', ['-xOzf', tarball], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    for (const [path, canary] of overrides) {
      assert.ok(!paths.has(path), `packed local override: ${path}`);
      assert.doesNotMatch(contents, new RegExp(canary));
    }
  } finally {
    await Promise.all([clean.dispose(), local.dispose()]);
    await rm(fixture, { recursive: true, force: true });
  }
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
