import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildKit } from './build-kit.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
async function withBuild(fn) {
  const dist = await mkdtemp(join(tmpdir(), 'awkit-build-'));
  try { return await fn(dist, await buildKit({ repoRoot: REPO, distDir: dist })); }
  finally { await rm(dist, { recursive: true, force: true }); }
}

test('historical v0.9.0 manifest remains an immutable golden fixture', async () => {
  const fixture = await readFile(join(REPO, 'test/fixtures/v0.9.0-agent-workflow-kit.package.json'));
  assert.equal(createHash('sha256').update(fixture).digest('hex'),
    'a209e14b1a2e5b3bba63c16ee6a7d713b6acd9a1d11379bb07fdd1e3e4ca8b6c');
  const manifest = JSON.parse(fixture);
  assert.equal(manifest.kitVersion, '0.9.0');
  assert.equal(manifest.files.length, 215);
});

test('current public SSOT builds deterministically', async () => {
  const first = await withBuild(async (dist) => readFile(join(dist, 'agent-workflow-kit.package.json'), 'utf8'));
  const second = await withBuild(async (dist) => readFile(join(dist, 'agent-workflow-kit.package.json'), 'utf8'));
  assert.equal(first, second);
});

test('current build contains post-tag public files and repository metadata', async () => {
  await withBuild(async (dist) => {
    await readFile(join(dist, '.agents/skills/codex-adapter-sync/SKILL.md'));
    await readFile(join(dist, 'scripts/program_graph.py'));
    const pkg = JSON.parse(await readFile(join(dist, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@ikon85/agent-workflow-kit');
    assert.equal(pkg.repository.url, 'git+https://github.com/iKon85/agent-workflow-kit.git');
  });
});

test('current build is self-contained and never reaches into a consumer checkout', async () => {
  const source = await readFile(join(REPO, 'scripts/build-kit.mjs'), 'utf8');
  assert.doesNotMatch(source, /testreporter|tools\/agent-workflow-kit/);
});

test('npm pack keeps the complete scripts tree but excludes Python caches', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO, encoding: 'utf8',
  });
  const files = JSON.parse(output)[0].files.map((file) => file.path);
  assert.ok(files.includes('scripts/build-kit.mjs'));
  assert.ok(files.includes('scripts/board-sync.py'));
  assert.ok(files.every((path) => !path.includes('__pycache__') && !path.endsWith('.pyc')));
  const pkg = JSON.parse(execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], {
    cwd: REPO, encoding: 'utf8',
  }));
  assert.ok(pkg.files.includes('scripts/'), 'package must ship future script file types');
});
