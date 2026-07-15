import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextVersion, prepareRelease } from './kit-release.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  for (const body of [claude, codex]) {
    assert.match(body, /`@ikon85\/agent-workflow-kit`/);
  }
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

test('confirmed target updates package, release notes, and regenerated manifest', async () => {
  const root = await fixture();
  const commands = [];
  try {
    const result = await prepareRelease({
      repoRoot: root, targetVersion: '1.3.0',
      delta: { added: ['scripts/new.mjs'], removed: [], changed: ['README.md'] },
      buildManifest: async () => ({ kitVersion: '1.3.0', files: [{ path: 'scripts/new.mjs' }] }),
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
    buildManifest: async () => ({ kitVersion: '1.2.4', files: [] }),
  };
  try {
    await assert.rejects(prepareRelease({ ...options, run: async () => { throw new Error('test red'); } }), /test red/);
    assert.equal(JSON.parse(await readFile(join(root, 'package.json'))).version, '1.2.4');
    const retried = await prepareRelease({ ...options, run: async () => {} });
    assert.equal(retried.status, 'resumed');
    assert.equal(JSON.parse(await readFile(join(root, 'package.json'))).version, '1.2.4');
  } finally { await rm(root, { recursive: true, force: true }); }
});
