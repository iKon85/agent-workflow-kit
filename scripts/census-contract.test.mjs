import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CENSUS_BUILDER_VERSION,
  activateCensus,
  diffCensus,
  scanCensus,
} from './census/index.mjs';

const exec = promisify(execFile);
const FIXTURES = new URL('../test/fixtures/census-consumers/', import.meta.url);
const REPO = fileURLToPath(new URL('../', import.meta.url));

async function consumer(name, tracked = ['.']) {
  const root = await mkdtemp(join(tmpdir(), `awk-census-${name}-`));
  await cp(new URL(`${name}/`, FIXTURES), root, { recursive: true });
  await exec('git', ['init', '--quiet'], { cwd: root });
  await exec('git', ['add', ...tracked], { cwd: root });
  return root;
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function backstopStatus(root) {
  const { stdout } = await exec('python3', [
    join(REPO, '.claude/hooks/drift-guard.py'), '--census-status',
  ], { cwd: root });
  return JSON.parse(stdout);
}

test('brownfield reports real X of Y surfaces separately from behaviors', async () => {
  const root = await consumer('brownfield');
  try {
    const profile = await json(join(root, '.census/profile.json'));
    const census = await scanCensus({
      repoRoot: root,
      enabled: profile.enabled,
      hasActive: true,
      behaviorFamilies: profile.decisions.map(({ family, status }) => ({ name: family, status })),
    });
    const covered = census.families.surfaces.filter(({ status }) => status === 'abgedeckt').length;

    assert.equal(census.state, 'current');
    assert.equal(`${covered} of ${census.families.surfaces.length}`, '3 of 3');
    assert.deepEqual(census.families.behaviors, [
      { name: 'authentication', status: 'abgedeckt', type: 'behavior' },
      { name: 'email-delivery', status: 'nicht relevant', type: 'behavior' },
    ]);
    assert.ok(census.families.surfaces.every(({ type }) => type === 'surface'));
  } finally { await cleanup(root); }
});

test('greenfield without an active snapshot remains honest bootstrap', async () => {
  const root = await consumer('greenfield');
  try {
    const census = await scanCensus({ repoRoot: root, enabled: true, hasActive: false });
    assert.equal(census.state, 'bootstrap');
    assert.ok(census.denominator.length > 0, 'bootstrap still reports discovered facts');
  } finally { await cleanup(root); }
});

test('unknown pattern stays open until its repository-local scanner test passes', async () => {
  const root = await consumer('unknown-pattern', ['package.json', 'src', '.census']);
  try {
    const activePath = join(root, '.census/active.json');
    const profilePath = join(root, '.census/profile.json');
    const surface = 'services/payments/src';
    const scannerRecord = {
      surface,
      module: 'scripts/census-local/scan-services.mjs',
      export: 'scanServices',
      test: 'test/census-services.test.mjs',
    };

    const untracked = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });
    assert.equal(untracked.state, 'refresh_required');
    assert.deepEqual(diffCensus(untracked, untracked).open, [surface]);

    // Establish real active history before the repository grows the unknown surface.
    await rm(join(root, 'services'), { recursive: true });
    await rm(join(root, 'scripts'), { recursive: true });
    await rm(join(root, 'test'), { recursive: true });
    const known = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });
    await writeFile(activePath, `${JSON.stringify({
      ...known,
      profileReport: { decisions: [], localScanners: [], overrides: [] },
    })}\n`);

    await cp(new URL('unknown-pattern/services/', FIXTURES), join(root, 'services'), { recursive: true });
    await exec('git', ['add', 'services'], { cwd: root });
    const trackedOnly = await backstopStatus(root);
    assert.equal(trackedOnly.state, 'refresh_required');
    assert.ok(trackedOnly.reasons.includes('topology'));

    const profile = await json(profilePath);
    profile.localScanners.push(scannerRecord);
    await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
    const missingProof = await backstopStatus(root);
    assert.equal(missingProof.state, 'refresh_required');
    assert.ok(missingProof.reasons.includes(`proof:${surface}`));

    await cp(new URL('unknown-pattern/scripts/', FIXTURES), join(root, 'scripts'), { recursive: true });
    await cp(new URL('unknown-pattern/test/', FIXTURES), join(root, 'test'), { recursive: true });
    await writeFile(
      join(root, scannerRecord.test),
      "import { test } from 'node:test'; test('failing local proof', () => { throw new Error('no'); });\n",
    );
    await exec('git', ['add', 'scripts', 'test', '.census/profile.json'], { cwd: root });
    const failedProof = await backstopStatus(root);
    assert.equal(failedProof.state, 'refresh_required');
    assert.ok(failedProof.reasons.includes(`proof:${surface}`));

    await cp(
      new URL('unknown-pattern/test/census-services.test.mjs', FIXTURES),
      join(root, scannerRecord.test),
    );
    const candidate = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });
    assert.equal(candidate.state, 'current');
    await activateCensus({
      activePath,
      candidate: {
        ...candidate,
        profileReport: { decisions: [], localScanners: [scannerRecord], overrides: [] },
      },
      verify: async () => {
        await exec('node', ['--test', scannerRecord.test], { cwd: root });
        const scanner = await import(`${pathToFileURL(join(root, scannerRecord.module)).href}?proof=${Date.now()}`);
        return scanner[scannerRecord.export]().includes(surface);
      },
    });

    const proven = await backstopStatus(root);
    assert.equal(proven.state, 'current');
    assert.deepEqual(proven.reasons, []);
    const active = await json(activePath);
    assert.equal(active.profileReport.localScanners[0].test, scannerRecord.test);
  } finally { await cleanup(root); }
});

test('scan and compact delta do not overwrite a consumer-local modification', async () => {
  const root = await consumer('local-modified');
  try {
    const sourcePath = join(root, 'src/index.mjs');
    const activePath = join(root, '.census/active.json');
    const sourceBefore = await readFile(sourcePath);
    const activeBefore = await readFile(activePath);
    const previous = { denominator: [], families: { surfaces: [], behaviors: [] } };
    const current = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });
    const delta = diffCensus(previous, current);

    assert.deepEqual(Object.keys(delta), ['added', 'changed', 'open', 'removed']);
    assert.ok(JSON.stringify(delta).length < JSON.stringify(current).length);
    assert.deepEqual(await readFile(sourcePath), sourceBefore);
    assert.deepEqual(await readFile(activePath), activeBefore);
  } finally { await cleanup(root); }
});

test('secret canary is absent from scan, delta, and file reads', async () => {
  const root = await consumer('secret-canary');
  try {
    const reads = [];
    const scan = await scanCensus({
      repoRoot: root,
      readText: async (path) => {
        reads.push(path);
        return readFile(path, 'utf8');
      },
    });
    const output = JSON.stringify({ scan, delta: diffCensus({ denominator: [] }, scan) });
    assert.doesNotMatch(output, /CENSUS_SECRET_CANARY/);
    assert.ok(reads.every((path) => !path.includes('credentials')));
  } finally { await cleanup(root); }
});

test('interrupted activation preserves the active census byte-for-byte', async () => {
  const root = await consumer('interrupted');
  try {
    const activePath = join(root, '.census/active.json');
    const before = await readFile(activePath);
    const candidate = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });
    await assert.rejects(activateCensus({
      activePath,
      candidate,
      verify: async () => true,
      renameCandidate: async () => { throw new Error('fixture interruption'); },
    }), (error) => error.state === 'failed');
    assert.deepEqual(await readFile(activePath), before);
  } finally { await cleanup(root); }
});

test('consumer update reports a newer builder without silently mutating its census', async () => {
  const root = await consumer('consumer-update');
  try {
    const activePath = join(root, '.census/active.json');
    const profilePath = join(root, '.census/profile.json');
    const fresh = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });
    await writeFile(activePath, `${JSON.stringify({
      ...fresh,
      fingerprints: { ...fresh.fingerprints, builder: 'older-builder-fingerprint' },
      profileReport: { decisions: [], localScanners: [], overrides: [] },
    })}\n`);
    const activeBefore = await readFile(activePath);
    const profileBefore = await readFile(profilePath);
    const { stdout } = await exec('python3', [
      join(REPO, '.claude/hooks/drift-guard.py'), '--census-status',
    ], { cwd: root });
    const status = JSON.parse(stdout);

    assert.equal(status.state, 'refresh_required');
    assert.equal(status.detail, `builder ${CENSUS_BUILDER_VERSION}`);
    assert.ok(status.reasons.includes('builder'));
    assert.deepEqual(await readFile(activePath), activeBefore);
    assert.deepEqual(await readFile(profilePath), profileBefore);
  } finally { await cleanup(root); }
});
