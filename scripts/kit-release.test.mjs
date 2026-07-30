import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { nextVersion, prepareRelease, runReleaseCommand } from './kit-release.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);

async function releaseWorkflow() {
  return readFile(join(REPO, '.github/workflows/release.yml'), 'utf8');
}

function workflowRunScript(workflow, stepName) {
  const lines = workflow.split('\n');
  const nameIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(nameIndex, -1, `workflow step not found: ${stepName}`);
  const runIndex = lines.findIndex(
    (line, index) => index > nameIndex && line.trim() === 'run: |',
  );
  assert.notEqual(runIndex, -1, `run block not found for workflow step: ${stepName}`);
  const indent = lines[runIndex].match(/^\s*/)[0].length + 2;
  const body = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() && line.match(/^\s*/)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

async function git(runCwd, args, options = {}) {
  return exec('git', args, { cwd: runCwd, ...options });
}

async function releaseIntentFixture({
  packageVersion = '1.2.3',
  annotated = true,
  onMain = true,
  mainAhead = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kit-release-intent-'));
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  await git(root, ['init', '--bare', origin]);
  await git(root, ['init', '--initial-branch=main', repo]);
  await git(repo, ['config', 'user.name', 'Release Test']);
  await git(repo, ['config', 'user.email', 'release-test@example.invalid']);
  await writeFile(join(repo, 'package.json'), `${JSON.stringify({
    name: '@ikon85/agent-workflow-kit',
    version: packageVersion,
  }, null, 2)}\n`);
  await git(repo, ['add', 'package.json']);
  await git(repo, ['commit', '-m', 'release fixture']);
  await git(repo, ['remote', 'add', 'origin', origin]);
  await git(repo, ['push', '-u', 'origin', 'main']);
  if (!onMain) {
    await git(repo, ['checkout', '-b', 'not-main']);
    await writeFile(join(repo, 'outside-main.txt'), 'not canonical\n');
    await git(repo, ['add', 'outside-main.txt']);
    await git(repo, ['commit', '-m', 'outside main']);
  }
  const tag = 'v1.2.3';
  await git(repo, annotated
    ? ['tag', '-a', tag, '-m', `Release ${tag}`]
    : ['tag', tag]);
  if (mainAhead) {
    await writeFile(join(repo, 'after-release.txt'), 'main moved\n');
    await git(repo, ['add', 'after-release.txt']);
    await git(repo, ['commit', '-m', 'move canonical main']);
    await git(repo, ['push', 'origin', 'main']);
  }
  return { root, repo, tag };
}

async function validateReleaseIntent(fixture, releaseTag = fixture.tag) {
  const workflow = await releaseWorkflow();
  const script = workflowRunScript(workflow, 'Validate release intent');
  const output = join(fixture.root, 'github-output');
  try {
    const result = await exec('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: fixture.repo,
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        RELEASE_TAG: releaseTag,
      },
    });
    return { ...result, output: await readFile(output, 'utf8') };
  } catch (error) {
    return { error, stderr: error.stderr ?? '', stdout: error.stdout ?? '' };
  }
}

test('release workflow treats an annotated version tag as normal intent and merge as integration only', async () => {
  const workflow = await releaseWorkflow();
  assert.match(workflow, /push:\s*\n\s+tags:\s*\n\s+- ['"]v\*\.\*\.\*['"]/);
  assert.doesNotMatch(workflow, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+tag:/);
  assert.match(workflow, /tag:[\s\S]*?required:\s*true/);
  assert.match(
    workflow,
    /group:\s*release-\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref_name \}\}/,
  );
  assert.doesNotMatch(workflow, /git diff --name-only[\s\S]*package\.json/);
  assert.ok(
    workflow.indexOf('- name: Validate release intent')
      < workflow.indexOf('node scripts/release-state.mjs'),
    'release intent must be validated before the reconciler can publish',
  );
  assert.equal(workflow.match(/node scripts\/release-state\.mjs/g)?.length, 1);
});

test('the same pre-publish validator accepts a matching annotated tag', async () => {
  const fixture = await releaseIntentFixture();
  try {
    const result = await validateReleaseIntent(fixture);
    assert.equal(result.error, undefined, result.stderr);
    assert.match(result.output, /^tag=v1\.2\.3$/m);
    assert.match(result.output, /^commit=[0-9a-f]{40}$/m);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: 'missing manual recovery tag',
    options: {},
    tag: 'v9.9.9',
    error: /does not exist/,
  },
  {
    name: 'tag/package version mismatch',
    options: { packageVersion: '1.2.4' },
    error: /does not match package version/,
  },
  {
    name: 'lightweight tag',
    options: { annotated: false },
    error: /must be annotated/,
  },
  {
    name: 'tag outside canonical main ancestry',
    options: { onMain: false },
    error: /not an ancestor of origin\/main/,
  },
  {
    name: 'stale canonical main commit with the same package version',
    options: { mainAhead: true },
    error: /does not identify the current origin\/main commit/,
  },
]) {
  test(`the pre-publish validator rejects a ${scenario.name}`, async () => {
    const fixture = await releaseIntentFixture(scenario.options);
    try {
      const result = await validateReleaseIntent(fixture, scenario.tag);
      assert.ok(result.error, 'validation unexpectedly succeeded');
      assert.match(`${result.stderr}\n${result.stdout}`, scenario.error);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test('the install manifest ships both release primitives named by the skill', async () => {
  const manifest = JSON.parse(await readFile(join(REPO, 'agent-workflow-kit.package.json')));
  const paths = manifest.files.map((entry) => entry.path);
  assert.ok(paths.includes('scripts/kit-release.mjs'));
  assert.ok(paths.includes('scripts/release-delta-guard.mjs'));
  assert.ok(paths.includes('scripts/release-parity.mjs'));
  assert.ok(paths.includes('scripts/release-state.mjs'));
});

test('both release skill surfaces name only the owned scoped npm package', async () => {
  const claude = await readFile(join(REPO, '.claude/skills/kit-release/SKILL.md'), 'utf8');
  const codex = await readFile(join(REPO, '.agents/skills/kit-release/SKILL.md'), 'utf8');
  assert.equal(codex, claude);
  for (const body of [claude, codex]) {
    assert.match(body, /`@ikon85\/agent-workflow-kit`/);
  }
});

// Amended by #257: one gate, at the Semver. The previous contract required a
// second confirmation before the tag; that gate left prepared versions stranded
// in `awaiting-tag` and is gone. What must survive is the narrowing rule — a
// build-only request never becomes release authority.
test('one confirmed Semver authorizes the release through tag and publish', async () => {
  const claude = await readFile(join(REPO, '.claude/skills/kit-release/SKILL.md'), 'utf8');
  const codex = await readFile(join(REPO, '.agents/skills/kit-release/SKILL.md'), 'utf8');
  assert.equal(codex.split('\n---\n')[1], claude.split('\n---\n')[1]);
  for (const body of [claude, codex]) {
    assert.match(body, /explicit AFK end-to-end mandate/i);
    assert.match(body, /deterministic recommendation/i);
    assert.match(body, /annotated\s+`v<version>` tag/i);
    assert.match(body, /confirmed Semver authorizes[\s\S]*without asking again/i);
    assert.match(body, /narrower build-only or single-action request/i);
    assert.doesNotMatch(body, /separate explicit confirmation/i);
  }
});

test('maintainer docs and the accepted ADR agree that merge integrates and an annotated tag publishes', async () => {
  const paths = [
    'CLAUDE.md',
    'AGENTS.md',
    'README.md',
    '.claude/skills/kit-release/SKILL.md',
    '.agents/skills/kit-release/SKILL.md',
    'docs/adr/0004-release-intent-is-a-version-tag.md',
  ];
  const bodies = await Promise.all(
    paths.map((path) => readFile(join(REPO, path), 'utf8')),
  );
  for (const [index, body] of bodies.entries()) {
    assert.match(body, /annotated\s+[`*]?v<version>[`*]?\s+tag/i, paths[index]);
    assert.match(body, /integrat/i, paths[index]);
  }
  assert.match(bodies.at(-1), /Status: accepted \(2026-07-22, issue #204\)/);
});

test('patch, minor, and major confirmations select exactly one target version', () => {
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kit-release-'));
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'package.json'), '{"name":"kit","version":"1.2.3"}\n');
  await writeFile(join(root, 'README.md'), '# Kit\n\n## Release notes\n\n### 1.2.3\n\n- Old.\n');
  await writeFile(join(root, 'agent-workflow-kit.package.json'), '{"kitVersion":"1.2.3","files":[]}\n');
  return root;
}

const ROUTING_UNIT = [
  'src/lib/routingInventory.mjs',
  'src/lib/routingInventory/snapshots/claude.json',
  'src/lib/routingInventory/snapshots/codex.json',
];

/**
 * A buildBundle stub that materializes the real pinned routing unit, so the
 * release path runs the real bundle verification against real bytes.
 */
async function bundleStub(kitVersion, { tamper = false } = {}) {
  const bundleRoot = await mkdtemp(join(tmpdir(), 'kit-release-bundle-'));
  const files = [];
  for (const path of ROUTING_UNIT) {
    const content = await readFile(join(REPO, path));
    await mkdir(dirname(join(bundleRoot, path)), { recursive: true });
    await writeFile(join(bundleRoot, path), content);
    files.push({
      path, kind: 'script', installRole: 'consumer', mode: 0o644,
      sha256: tamper && path.endsWith('.mjs')
        ? '0'.repeat(64)
        : createHash('sha256').update(content).digest('hex'),
    });
  }
  return async () => ({
    manifest: { kitVersion, files },
    bundleRoot,
    cleanup: () => rm(bundleRoot, { recursive: true, force: true }),
  });
}

test('confirmed target updates package, release notes, and regenerated manifest', async () => {
  const root = await fixture();
  const commands = [];
  try {
    const result = await prepareRelease({
      repoRoot: root, targetVersion: '1.3.0',
      delta: { added: ['scripts/new.mjs'], removed: [], changed: ['README.md'] },
      buildBundle: await bundleStub('1.3.0'),
      run: async (command, args) => commands.push([command, ...args].join(' ')),
    });
    assert.equal(result.status, 'prepared');
    assert.equal(JSON.parse(await readFile(join(root, 'package.json'))).version, '1.3.0');
    assert.equal(JSON.parse(await readFile(join(root, 'agent-workflow-kit.package.json'))).kitVersion, '1.3.0');
    assert.match(await readFile(join(root, 'README.md'), 'utf8'), /### 1\.3\.0[\s\S]*scripts\/new\.mjs/);
    assert.deepEqual(commands, [
      'npm run release:guard', 'npm test', 'npm pack --dry-run',
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed gate leaves an explainable target that retries without another bump', async () => {
  const root = await fixture();
  const options = {
    repoRoot: root, targetVersion: '1.2.4',
    delta: { added: [], removed: [], changed: ['README.md'] },
  };
  try {
    await assert.rejects(prepareRelease({
      ...options,
      buildBundle: await bundleStub('1.2.4'),
      run: async () => { throw new Error('test red'); },
    }), /test red/);
    assert.equal(JSON.parse(await readFile(join(root, 'package.json'))).version, '1.2.4');
    const retried = await prepareRelease({
      ...options, buildBundle: await bundleStub('1.2.4'), run: async () => {},
    });
    assert.equal(retried.status, 'resumed');
    assert.equal(JSON.parse(await readFile(join(root, 'package.json'))).version, '1.2.4');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release gate failure preserves stderr and stdout diagnostics', async () => {
  const executor = async () => {
    const error = new Error('Command failed: npm test');
    error.stderr = 'npm ERR! lifecycle command failed\n';
    error.stdout = 'not ok 42 - concrete regression test\n';
    throw error;
  };

  await assert.rejects(
    runReleaseCommand('npm', ['test'], REPO, executor),
    (error) => {
      assert.match(error.message, /npm ERR! lifecycle command failed/);
      assert.match(error.message, /not ok 42 - concrete regression test/);
      return true;
    },
  );
});

test('release preparation consumes the pinned inventory and makes no network call', async () => {
  const root = await fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('release preparation must never reach the network'); };
  try {
    const result = await prepareRelease({
      repoRoot: root, targetVersion: '1.3.0',
      delta: { added: [], removed: [], changed: [] },
      buildBundle: await bundleStub('1.3.0'),
      run: async () => {},
    });
    assert.match(result.inventoryRevision, /^sha256-[A-Za-z0-9_-]{43}$/);
    const { loadRoutingInventory } = await import('../src/lib/routingInventory.mjs');
    assert.equal(result.inventoryRevision, (await loadRoutingInventory()).revision);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('release preparation refuses a bundle that fails verification', async () => {
  const root = await fixture();
  const commands = [];
  try {
    await assert.rejects(prepareRelease({
      repoRoot: root, targetVersion: '1.3.0',
      delta: { added: [], removed: [], changed: [] },
      buildBundle: await bundleStub('1.3.0', { tamper: true }),
      run: async (command, args) => commands.push([command, ...args].join(' ')),
    }), /bundle verification failed[\s\S]*manifestHashes/);
    assert.deepEqual(commands, [], 'the gates must not run on an unverified bundle');
    assert.equal(
      JSON.parse(await readFile(join(root, 'agent-workflow-kit.package.json'))).kitVersion,
      '1.2.3',
      'an unverified bundle never overwrites the checked-in install manifest',
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
