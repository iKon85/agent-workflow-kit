import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildKit } from './build-kit.mjs';
import { init } from '../src/commands/init.mjs';
import { HELPER_FILES } from '../src/lib/bundle.mjs';
import { CONSUMER_MANIFEST_NAME, readManifest } from '../src/lib/manifest.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_CENSUS_UNIT = JSON.parse(await readFile(
  join(REPO, 'test/fixtures/census-consumers/public-unit.json'), 'utf8',
)).paths;
const WAVE_152_HELPERS = [
  { path: 'scripts/marker_lib.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/find-by-marker.py', kind: 'script', mode: 0o755 },
  { path: 'scripts/codex-exec.sh', kind: 'script', mode: 0o755 },
  { path: 'scripts/codex_proc.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/render-anchor.py', kind: 'script', mode: 0o755 },
];
async function withBuild(fn) {
  const dist = await mkdtemp(join(tmpdir(), 'awkit-build-'));
  try { return await fn(dist, await buildKit({ repoRoot: REPO, distDir: dist })); }
  finally { await rm(dist, { recursive: true, force: true }); }
}
const exists = (path) => access(path).then(() => true, () => false);

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

test('current build assigns every file an explicit install role', async () => {
  await withBuild(async (dist) => {
    const manifest = JSON.parse(await readFile(join(dist, 'agent-workflow-kit.package.json'), 'utf8'));
    assert.ok(manifest.files.every(({ installRole }) => ['consumer', 'maintainer'].includes(installRole)));
    assert.deepEqual(
      manifest.files.filter(({ installRole }) => installRole === 'maintainer').map(({ path }) => path),
      [
        '.agents/skills/kit-release/SKILL.md',
        '.claude/skills/kit-release/SKILL.md',
        'scripts/kit-release.mjs',
        'scripts/release-delta-guard.mjs',
      ],
    );
  });
});

test('a built kit installs no maintainer-only release surface into a consumer', async () => {
  await withBuild(async (dist) => {
    const consumer = await mkdtemp(join(tmpdir(), 'awkit-role-consumer-'));
    try {
      await init({ kitRoot: dist, consumerRoot: consumer });
      const maintainerPaths = [
        '.agents/skills/kit-release/SKILL.md',
        '.claude/skills/kit-release/SKILL.md',
        'scripts/kit-release.mjs',
        'scripts/release-delta-guard.mjs',
      ];
      assert.deepEqual(
        await Promise.all(maintainerPaths.map((path) => exists(join(consumer, path)))),
        [false, false, false, false],
      );
      const manifest = await readManifest(join(consumer, CONSUMER_MANIFEST_NAME));
      assert.equal(manifest.installRole, 'consumer');
      assert.ok(manifest.installed.every(({ installRole }) => installRole === 'consumer'));
    } finally {
      await rm(consumer, { recursive: true, force: true });
    }
  });
});

test('current build contains post-tag public files and repository metadata', async () => {
  await withBuild(async (dist) => {
    await readFile(join(dist, '.agents/skills/codex-adapter-sync/SKILL.md'));
    await readFile(join(dist, 'scripts/program_graph.py'));
    const pkg = JSON.parse(await readFile(join(dist, 'package.json'), 'utf8'));
    assert.equal(pkg.name, '@ikon85/agent-workflow-kit');
    assert.equal(pkg.repository.url, 'git+https://github.com/iKon85/agent-workflow-kit.git');
    assert.equal(pkg.bin['agent-workflow-kit'], 'src/cli.mjs');
    assert.equal(pkg.bin['agent-workflow-kit-update-pr'], 'scripts/kit-update-pr.mjs');
    await readFile(join(dist, 'scripts/kit-update-pr.mjs'));
  });
});

test('Wave 152 helpers keep their bundle and built-manifest modes', async () => {
  assert.deepEqual(
    WAVE_152_HELPERS.map(({ path }) => HELPER_FILES.find((entry) => entry.path === path)),
    WAVE_152_HELPERS,
  );
  await withBuild(async (dist) => {
    const manifest = JSON.parse(await readFile(join(dist, 'agent-workflow-kit.package.json'), 'utf8'));
    const byPath = new Map(manifest.files.map((entry) => [entry.path, entry]));
    assert.deepEqual(
      WAVE_152_HELPERS.map(({ path }) => {
        const { kind, mode, installRole } = byPath.get(path);
        return { path, kind, mode, installRole };
      }),
      WAVE_152_HELPERS.map((entry) => ({ ...entry, installRole: 'consumer' })),
    );
  });
});

test('current build contains the complete dual-surface census consumer unit', async () => {
  await withBuild(async (dist, report) => {
    const manifest = JSON.parse(await readFile(join(dist, 'agent-workflow-kit.package.json'), 'utf8'));
    const paths = new Set(manifest.files.map(({ path }) => path));
    assert.deepEqual(PUBLIC_CENSUS_UNIT.filter((path) => !paths.has(path)), []);
    assert.equal(report.fileCount, manifest.files.length);
    assert.equal(
      await readFile(join(dist, '.claude/skills/census-update/SKILL.md'), 'utf8'),
      await readFile(join(dist, '.agents/skills/census-update/SKILL.md'), 'utf8'),
    );
  });
});

test('current build is self-contained and never reaches into a consumer checkout', async () => {
  const source = await readFile(join(REPO, 'scripts/build-kit.mjs'), 'utf8');
  assert.doesNotMatch(source, /testreporter|tools\/agent-workflow-kit/);
});

test('npm pack keeps product files but excludes runtime residue', async () => {
  const logsDir = join(REPO, '.claude/logs');
  await mkdir(logsDir, { recursive: true });
  const ownedLogDir = await mkdtemp(join(logsDir, 'pack-runtime-'));
  const runtimeLog = join(ownedLogDir, 'drift-guard.log');
  const sentinelLog = join(ownedLogDir, 'preexisting.log');
  const sentinelBytes = 'preexisting runtime log bytes\n';
  await writeFile(sentinelLog, sentinelBytes);
  await writeFile(runtimeLog, `${new Date().toISOString()} runtime-only\n`);
  try {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: REPO, encoding: 'utf8',
    });
    const files = JSON.parse(output)[0].files.map((file) => file.path);
    assert.ok(files.includes('scripts/build-kit.mjs'));
    assert.ok(files.includes('scripts/board-sync.py'));
    assert.ok(files.includes('scripts/kit-update-pr.mjs'));
    assert.ok(files.includes('.claude/hooks/drift-guard.py'));
    assert.ok(files.includes('.claude/skills/tdd/SKILL.md'));
    for (const path of PUBLIC_CENSUS_UNIT) {
      assert.ok(files.includes(path), `pack missing ${path}`);
    }
    const packedByPath = new Map(JSON.parse(output)[0].files.map((file) => [file.path, file]));
    assert.deepEqual(
      WAVE_152_HELPERS.map(({ path, mode }) => ({ path, mode: packedByPath.get(path)?.mode })),
      WAVE_152_HELPERS.map(({ path, mode }) => ({ path, mode })),
    );
    assert.ok(files.every((path) => !path.startsWith('.claude/logs/')));
    assert.ok(files.every((path) => !path.includes('__pycache__') && !path.endsWith('.pyc')));
    const pkg = JSON.parse(execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], {
      cwd: REPO, encoding: 'utf8',
    }));
    assert.ok(pkg.files.includes('scripts/'), 'package must ship future script file types');
    assert.equal(await readFile(sentinelLog, 'utf8'), sentinelBytes);
  } finally {
    await rm(ownedLogDir, { recursive: true, force: true });
  }
});

test('packed scoped artifact keeps the existing npx default-bin inference', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'awkit-pack-'));
  try {
    const packed = JSON.parse(execFileSync('npm', [
      'pack', '--pack-destination', destination, '--json',
    ], { cwd: REPO, encoding: 'utf8' }));
    const packedByPath = new Map(packed[0].files.map((file) => [file.path, file]));
    execFileSync('tar', ['-xzf', join(destination, packed[0].filename), '-C', destination]);
    for (const { path, mode } of WAVE_152_HELPERS) {
      assert.equal(packedByPath.get(path)?.mode, mode, `packed mode mismatch: ${path}`);
      assert.equal(
        (await stat(join(destination, 'package', path))).mode & 0o777,
        mode,
        `extracted mode mismatch: ${path}`,
      );
    }
    const output = execFileSync('npx', [
      '--yes', '--offline', `./${packed[0].filename}`,
    ], { cwd: destination, encoding: 'utf8' });
    assert.match(output, /Usage: agent-workflow-kit/);

    const updater = execFileSync('npm', [
      'exec', '--yes', '--offline', `--package=./${packed[0].filename}`,
      '--', 'agent-workflow-kit-update-pr', 'help',
    ], { cwd: destination, encoding: 'utf8' });
    assert.match(updater, /Usage: agent-workflow-kit-update-pr/);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});
