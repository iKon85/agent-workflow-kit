import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CENSUS_VERDICTS,
  activateCensus,
  diffCensus,
  scanCensus,
  serializeCensus,
} from './census/index.mjs';

const ROOT = new URL('../', import.meta.url);
const exec = promisify(execFile);

async function text(path) {
  return readFile(new URL(path, ROOT), 'utf8');
}

async function makeBrownfield() {
  const root = await mkdtemp(join(tmpdir(), 'awk-census-update-'));
  await mkdir(join(root, 'apps/api/src'), { recursive: true });
  await mkdir(join(root, 'apps/web/src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"brownfield","type":"module"}\n');
  await writeFile(join(root, 'apps/api/src/index.mjs'), 'export const api = true;\n');
  await writeFile(join(root, 'apps/web/src/index.mjs'), 'export const web = true;\n');
  await exec('git', ['init', '--quiet'], { cwd: root });
  await exec('git', ['add', '.'], { cwd: root });
  return root;
}

test('census-update is a published dual-surface own-work entry point', async () => {
  const [source, mirror, manifestText, provenance, claudeOverview, codexOverview] = await Promise.all([
    text('.claude/skills/census-update/SKILL.md'),
    text('.agents/skills/census-update/SKILL.md'),
    text('.claude/skills/skill-manifest.json'),
    text('PROVENANCE.md'),
    text('.claude/skills/setup-workflow/workflow-overview.md'),
    text('.agents/skills/setup-workflow/workflow-overview.md'),
  ]);
  const entry = JSON.parse(manifestText).skills['census-update'];

  assert.deepEqual(entry, {
    class: 'generic',
    publish: true,
    entryPoint: true,
    surfaces: ['claude', 'codex'],
    provenance: 'own',
  });
  assert.equal(source, mirror);
  assert.match(provenance, /Own work[\s\S]*census-update/);
  assert.match(claudeOverview, /`census-update`/);
  assert.match(codexOverview, /`census-update`/);
});

test('census-update coordinates the stable foundation API without a second engine', async () => {
  const skill = await text('.claude/skills/census-update/SKILL.md');
  for (const name of [
    'scanCensus', 'serializeCensus', 'fingerprintCensus', 'CENSUS_BUILDER_VERSION',
    'diffCensus', 'CENSUS_STATES', 'CENSUS_VERDICTS', 'resolveCensusState',
    'activateCensus', 'CensusTransactionError',
  ]) {
    assert.match(skill, new RegExp(`\\b${name}\\b`), `${name} must remain the public mechanism`);
  }
  assert.match(skill, /do not copy, rename, or reimplement/i);
  assert.match(skill, /Never ask the user which files, paths, or\s+patterns exist/i);
  assert.match(skill, /recommendation and the evidence/i);
  assert.match(skill, /`nicht relevant` requires a durable justification/i);
  assert.match(skill, /override[\s\S]*must not[\s\S]*alter scanner facts/i);
  assert.match(skill, /Work only in the current repository/i);
  assert.match(skill, /Never[\s\S]*propose an upstream kit change/i);
});

test('brownfield bootstrap activates real surface coverage with a separate behavior overview', async () => {
  const root = await makeBrownfield();
  const activePath = join(root, '.census/active.json');
  try {
    const candidate = await scanCensus({
      repoRoot: root,
      enabled: true,
      behaviorFamilies: [
        { name: 'authentication', status: CENSUS_VERDICTS.covered },
        { name: 'email-delivery', status: CENSUS_VERDICTS.notRelevant },
      ],
    });
    assert.equal(candidate.state, 'bootstrap');

    const activatedCandidate = { ...candidate, state: 'current' };
    await activateCensus({
      activePath,
      candidate: activatedCandidate,
      verify: (staged) => [...staged.families.surfaces, ...staged.families.behaviors]
        .every(({ status }) => status !== CENSUS_VERDICTS.open),
    });
    const current = await scanCensus({
      repoRoot: root,
      enabled: true,
      hasActive: true,
      behaviorFamilies: candidate.families.behaviors,
    });
    const covered = current.families.surfaces
      .filter(({ status }) => status === CENSUS_VERDICTS.covered).length;

    assert.equal(current.state, 'current');
    assert.equal(`${covered} of ${current.families.surfaces.length}`, '3 of 3');
    assert.deepEqual(current.families.behaviors, [
      { name: 'authentication', status: 'abgedeckt', type: 'behavior' },
      { name: 'email-delivery', status: 'nicht relevant', type: 'behavior' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a second unchanged current run performs no activation write', async () => {
  const root = await makeBrownfield();
  const activePath = join(root, '.census/active.json');
  try {
    const active = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });
    await activateCensus({
      activePath,
      candidate: active,
      verify: (candidate) => candidate.state === 'current',
    });
    const beforeBytes = await readFile(activePath, 'utf8');
    const beforeStat = await stat(activePath);

    const fresh = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });
    const unchanged = serializeCensus(fresh) === beforeBytes;
    if (!unchanged) {
      await activateCensus({
        activePath,
        candidate: fresh,
        verify: (candidate) => candidate.state === 'current',
      });
    }

    assert.equal(unchanged, true);
    assert.equal(await readFile(activePath, 'utf8'), beforeBytes);
    assert.equal((await stat(activePath)).mtimeMs, beforeStat.mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unexpected surface stays open despite not-relevant decisions and a change-local override', async () => {
  const root = await makeBrownfield();
  try {
    await mkdir(join(root, 'services/payments/src'), { recursive: true });
    await writeFile(join(root, 'services/payments/src/index.mjs'), 'export const payments = true;\n');
    const scan = await scanCensus({
      repoRoot: root,
      enabled: true,
      hasActive: true,
      behaviorFamilies: [
        { name: 'postal-delivery', status: CENSUS_VERDICTS.notRelevant },
      ],
    });
    const visibleDecision = {
      family: 'postal-delivery',
      justification: 'The product sends no physical mail.',
      status: CENSUS_VERDICTS.notRelevant,
    };
    const displayOnlyOverride = {
      reason: 'Known formatting-only path delta.',
      scope: 'this change',
    };

    assert.equal(visibleDecision.status, 'nicht relevant');
    assert.equal(displayOnlyOverride.scope, 'this change');
    assert.deepEqual(scan.families.surfaces.filter(({ status }) => status === CENSUS_VERDICTS.open), [
      { name: 'services/payments/src', status: 'offen', type: 'surface' },
    ]);
    assert.equal(scan.state, 'refresh_required');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a changed repository yields only compact path deltas and never reads a foreign repository', async () => {
  const root = await makeBrownfield();
  const foreign = await makeBrownfield();
  try {
    const reads = [];
    const before = await scanCensus({ repoRoot: root });
    await writeFile(join(root, 'apps/api/src/index.mjs'), 'export const api = "changed";\n');
    const after = await scanCensus({
      repoRoot: root,
      readText: async (path) => {
        reads.push(path);
        return readFile(path, 'utf8');
      },
    });

    assert.deepEqual(diffCensus(before, after), {
      added: [],
      changed: ['apps/api/src/index.mjs'],
      open: [],
      removed: [],
    });
    assert.ok(reads.length > 0);
    assert.ok(reads.every((path) => path.startsWith(`${root}/`)));
    assert.ok(reads.every((path) => !path.startsWith(`${foreign}/`)));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  }
});

test('an injected activation failure byte-preserves the active census', async () => {
  const root = await makeBrownfield();
  const activePath = join(root, '.census/active.json');
  const previous = '{"generation":"known-good"}\n';
  try {
    await mkdir(join(root, '.census'), { recursive: true });
    await writeFile(activePath, previous);
    const candidate = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });

    await assert.rejects(
      activateCensus({
        activePath,
        candidate,
        verify: async () => true,
        renameCandidate: async () => { throw new Error('injected swap failure'); },
      }),
      (error) => error.state === 'failed',
    );
    assert.equal(await readFile(activePath, 'utf8'), previous);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unknown pattern activates only after a repository-local scanner test passes', async () => {
  const root = await makeBrownfield();
  const activePath = join(root, '.census/active.json');
  const previous = '{"generation":"previous"}\n';
  try {
    await mkdir(join(root, '.census'), { recursive: true });
    await writeFile(activePath, previous);
    await mkdir(join(root, 'services/payments/src'), { recursive: true });
    await writeFile(join(root, 'services/payments/src/index.mjs'), 'export const payments = true;\n');
    const openCandidate = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });

    await assert.rejects(
      activateCensus({
        activePath,
        candidate: openCandidate,
        verify: () => false,
      }),
      (error) => error.state === 'failed',
    );
    assert.equal(await readFile(activePath, 'utf8'), previous);

    await mkdir(join(root, 'scripts/census-local'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await writeFile(
      join(root, 'scripts/census-local/scan-services.mjs'),
      "export const scanServices = () => ['services/payments/src'];\n",
    );
    await writeFile(
      join(root, 'test/census-services.test.mjs'),
      "import { test } from 'node:test';\n"
        + "import assert from 'node:assert/strict';\n"
        + "import { scanServices } from '../scripts/census-local/scan-services.mjs';\n"
        + "test('service scanner recognizes payments', () => {\n"
        + "  assert.deepEqual(scanServices(), ['services/payments/src']);\n"
        + "});\n",
    );
    await exec('node', ['--test', 'test/census-services.test.mjs'], { cwd: root });
    await exec('git', ['add', 'services', 'scripts/census-local', 'test/census-services.test.mjs'], { cwd: root });

    const verifiedCandidate = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });
    assert.equal(verifiedCandidate.state, 'current');
    assert.ok(verifiedCandidate.families.surfaces.some(({ name, status }) => (
      name === 'services/payments/src' && status === CENSUS_VERDICTS.covered
    )));
    await activateCensus({
      activePath,
      candidate: verifiedCandidate,
      verify: (candidate) => candidate.state === 'current',
    });
    assert.notEqual(await readFile(activePath, 'utf8'), previous);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
