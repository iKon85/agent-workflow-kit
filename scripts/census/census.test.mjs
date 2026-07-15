import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CENSUS_VERDICTS,
  diffCensus,
  scanCensus,
  serializeCensus,
} from './index.mjs';

const exec = promisify(execFile);
const FIXTURE = new URL('../../test/fixtures/census-recipes/known/', import.meta.url);

async function makeRepository() {
  const root = await mkdtemp(join(tmpdir(), 'awk-census-'));
  await cp(FIXTURE, root, { recursive: true });
  await exec('git', ['init', '--quiet'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['add', '-f', 'ignored/src/ignored.mjs'], { cwd: root });
  return root;
}

test('known recipe scans are byte-identical and separate denominator from evidence', async () => {
  const root = await makeRepository();
  try {
    const first = await scanCensus({ repoRoot: root });
    const second = await scanCensus({ repoRoot: root });

    assert.equal(serializeCensus(first), serializeCensus(second));
    assert.deepEqual(first.denominator.map(({ path }) => path), [
      'package.json',
      'src/index.mjs',
    ]);
    assert.deepEqual(first.evidence.map(({ path }) => path), [
      'docs/architecture.md',
      'test/index.test.mjs',
    ]);
    assert.equal(first.fingerprints.builder.length, 64);
    assert.equal(first.fingerprints.topology.length, 64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scan state reflects explicit activation and active-census facts', async () => {
  const root = await makeRepository();
  try {
    assert.equal((await scanCensus({ repoRoot: root })).state, 'disabled');
    assert.equal((await scanCensus({ repoRoot: root, enabled: true })).state, 'bootstrap');
    assert.equal((await scanCensus({ repoRoot: root, enabled: true, hasActive: true })).state, 'current');

    await mkdir(join(root, 'new-service', 'src'), { recursive: true });
    await writeFile(join(root, 'new-service', 'src', 'index.mjs'), 'export const newService = true;\n');
    assert.equal(
      (await scanCensus({ repoRoot: root, enabled: true, hasActive: true })).state,
      'refresh_required',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('secret, ignored, generated, and vendor paths are never read or counted', async () => {
  const root = await makeRepository();
  try {
    const reads = [];
    const result = await scanCensus({
      repoRoot: root,
      readText: async (path) => {
        reads.push(path);
        return (await import('node:fs/promises')).readFile(path, 'utf8');
      },
    });
    const output = serializeCensus(result);

    assert.ok(!reads.some((path) => path.includes('secrets')));
    assert.ok(!reads.some((path) => path.includes('credentials')));
    assert.ok(!output.includes('CENSUS_SECRET_CANARY'));
    assert.ok(!output.includes('secrets/'));
    assert.ok(!output.includes('credentials.txt'));
    assert.ok(!output.includes('vendor/src'));
    assert.ok(!output.includes('dist/src'));
    assert.ok(!output.includes('ignored/src'));
    assert.equal(result.denominator.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tracked product symlinks stay unread and force an open refresh', async () => {
  const root = await makeRepository();
  const external = await mkdtemp(join(tmpdir(), 'awk-census-external-'));
  const externalPath = join(external, 'canary.mjs');
  await writeFile(externalPath, 'CENSUS_EXTERNAL_SECRET_CANARY\n');
  await symlink(externalPath, join(root, 'src', 'external.mjs'));
  await exec('git', ['add', 'src/external.mjs'], { cwd: root });
  try {
    const reads = [];
    const result = await scanCensus({
      repoRoot: root,
      enabled: true,
      hasActive: true,
      readText: async (path) => {
        reads.push(path);
        return (await import('node:fs/promises')).readFile(path, 'utf8');
      },
    });

    assert.ok(!reads.includes(join(root, 'src', 'external.mjs')));
    assert.ok(!reads.includes(externalPath));
    assert.ok(!serializeCensus(result).includes('CENSUS_EXTERNAL_SECRET_CANARY'));
    assert.ok(!result.denominator.some(({ path }) => path === 'src/external.mjs'));
    assert.deepEqual(result.families.surfaces, [
      { name: 'production-config', status: 'abgedeckt', type: 'surface' },
      { name: 'src', status: 'offen', type: 'surface' },
    ]);
    assert.equal(result.state, 'refresh_required');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('a tracked product file missing from the working tree forces an open refresh', async () => {
  const root = await makeRepository();
  try {
    await rm(join(root, 'src', 'index.mjs'));

    const result = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });

    assert.deepEqual(result.denominator.map(({ path }) => path), ['package.json']);
    assert.deepEqual(result.families.surfaces, [
      { name: 'production-config', status: 'abgedeckt', type: 'surface' },
      { name: 'src', status: 'offen', type: 'surface' },
    ]);
    assert.equal(result.state, 'refresh_required');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unreadable tracked product file makes its family open without a duplicate covered verdict', async () => {
  const root = await makeRepository();
  try {
    const result = await scanCensus({
      repoRoot: root,
      enabled: true,
      hasActive: true,
      readText: async (path) => {
        if (path === join(root, 'src', 'index.mjs')) throw new Error('simulated unreadable product file');
        return (await import('node:fs/promises')).readFile(path, 'utf8');
      },
    });

    assert.deepEqual(result.families.surfaces, [
      { name: 'production-config', status: 'abgedeckt', type: 'surface' },
      { name: 'src', status: 'offen', type: 'surface' },
    ]);
    assert.equal(result.state, 'refresh_required');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an untracked source root is open and prevents current', async () => {
  const root = await makeRepository();
  try {
    await mkdir(join(root, 'new-service', 'src'), { recursive: true });
    await writeFile(join(root, 'new-service', 'src', 'index.mjs'), 'export const newService = true;\n');

    const result = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });

    assert.equal(result.state, 'refresh_required');
    assert.deepEqual(result.families.surfaces.filter(({ status }) => status === 'offen'), [
      { name: 'new-service/src', status: 'offen', type: 'surface' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delta reports compact path changes and open families', async () => {
  const root = await makeRepository();
  try {
    const previous = await scanCensus({ repoRoot: root });
    await writeFile(join(root, 'src', 'index.mjs'), 'export const answer = 43;\n');
    await mkdir(join(root, 'new-service', 'src'), { recursive: true });
    await writeFile(join(root, 'new-service', 'src', 'index.mjs'), 'export const newService = true;\n');
    const next = await scanCensus({ repoRoot: root });

    assert.deepEqual(diffCensus(previous, next), {
      added: [],
      changed: ['src/index.mjs'],
      open: ['new-service/src'],
      removed: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('content-only edits do not change the topology fingerprint', async () => {
  const root = await makeRepository();
  try {
    const previous = await scanCensus({ repoRoot: root });
    await writeFile(join(root, 'src', 'index.mjs'), 'export const answer = 99;\n');
    const next = await scanCensus({ repoRoot: root });

    assert.equal(previous.fingerprints.topology, next.fingerprints.topology);
    assert.deepEqual(diffCensus(previous, next).changed, ['src/index.mjs']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('family verdicts expose every machine-readable contract value', () => {
  assert.deepEqual(CENSUS_VERDICTS, {
    covered: 'abgedeckt',
    notRelevant: 'nicht relevant',
    open: 'offen',
  });
});

test('behavior families represent covered, not-relevant, and open verdicts separately', async () => {
  const root = await makeRepository();
  try {
    const result = await scanCensus({
      repoRoot: root,
      enabled: true,
      hasActive: true,
      behaviorFamilies: [
        { name: 'auth-session', status: CENSUS_VERDICTS.covered },
        { name: 'billing', status: CENSUS_VERDICTS.notRelevant },
        { name: 'email-delivery', status: CENSUS_VERDICTS.open },
      ],
    });

    assert.deepEqual(result.families.behaviors, [
      { name: 'auth-session', status: 'abgedeckt', type: 'behavior' },
      { name: 'billing', status: 'nicht relevant', type: 'behavior' },
      { name: 'email-delivery', status: 'offen', type: 'behavior' },
    ]);
    assert.ok(result.families.surfaces.every(({ type }) => type === 'surface'));
    assert.equal(result.state, 'refresh_required');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
