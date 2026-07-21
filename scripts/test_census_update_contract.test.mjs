import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, lstat, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CENSUS_VERDICTS,
  activateCensus,
  diffCensus,
  fingerprintCensus,
  resolveCensusState,
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

const PROFILE_RELATIVE_PATH = '.census/profile.json';
const ACTIVE_RELATIVE_PATH = '.census/active.json';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function profileBehaviorFamilies(profile) {
  return profile.decisions.map(({ family, status }) => ({ name: family, status }));
}

async function containedRegularPath(root, localPath) {
  if (typeof localPath !== 'string' || !localPath || isAbsolute(localPath)) return null;
  const target = resolve(root, localPath);
  const lexical = relative(resolve(root), target);
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) return null;
  const stats = await lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink()) return null;
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(target);
  const canonicalRelative = relative(canonicalRoot, canonical);
  if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`)
    || isAbsolute(canonicalRelative)) return null;
  return target;
}

async function runLocalScannerProof(root, record) {
  const modulePath = await containedRegularPath(root, record.module);
  const testPath = await containedRegularPath(root, record.test);
  if (!modulePath || !testPath) return false;
  await exec('node', ['--test', record.test], { cwd: root });
  const scanner = await import(`${pathToFileURL(modulePath).href}?proof=${Date.now()}`);
  return scanner[record.export]().includes(record.surface);
}

async function runConsumerCensus(root) {
  const profilePath = join(root, PROFILE_RELATIVE_PATH);
  const activePath = join(root, ACTIVE_RELATIVE_PATH);
  const profile = await readJson(profilePath);
  let previous = null;
  try {
    previous = await readJson(activePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const scan = await scanCensus({
    repoRoot: root,
    enabled: profile.enabled,
    hasActive: previous !== null,
    behaviorFamilies: profileBehaviorFamilies(profile),
  });
  const previousSurfaces = new Set(previous?.families.surfaces.map(({ name }) => name) ?? []);
  const unexpected = previous === null
    ? []
    : scan.families.surfaces.filter(({ name }) => !previousSurfaces.has(name));
  const scannerBySurface = new Map(profile.localScanners.map((record) => [record.surface, record]));
  const missingScanner = unexpected.some(({ name }) => !scannerBySurface.has(name));
  const hasOpen = missingScanner || [...scan.families.surfaces, ...scan.families.behaviors]
    .some(({ status }) => status === CENSUS_VERDICTS.open);
  const candidate = {
    ...scan,
    profileReport: {
      decisions: profile.decisions,
      localScanners: profile.localScanners,
      overrides: profile.overrides,
    },
    state: resolveCensusState({ enabled: profile.enabled, hasActive: true, hasOpen }),
  };

  if (previous !== null && serializeCensus(candidate) === serializeCensus(previous)) {
    return { activated: false, activePath, candidate, profilePath };
  }

  await activateCensus({
    activePath,
    candidate,
    verify: async (staged) => {
      if (staged.state !== 'current') return false;
      for (const { name } of unexpected) {
        const record = scannerBySurface.get(name);
        if (!record || !await runLocalScannerProof(root, record)) return false;
      }
      return staged.profileReport.decisions.every((decision) => (
        decision.status !== CENSUS_VERDICTS.notRelevant || Boolean(decision.justification)
      ));
    },
  });
  return { activated: true, activePath, candidate, profilePath };
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
  assert.match(skill, /\.census\/profile\.json/);
  assert.match(skill, /\.census\/active\.json/);
  assert.match(skill, /schemaVersion/);
  assert.match(skill, /every `localScanners\[\]\.test`/);
  assert.match(skill, /shared project-local census check entry point/i);
  assert.match(
    skill,
    /It must execute every declared focused test,\s+and both local CI and pre-push must transitively reach that same entry point\./i,
  );
  assert.match(skill, /executable wiring test/i);
  assert.match(skill, /missing or partial[\s\S]*failed/i);
  assert.match(skill, /previous active\s+census bytes are unchanged/i);
  assert.match(skill, /idempotent/i);

  const setupCensus = await text('.claude/skills/setup-workflow/census.md');
  assert.match(setupCensus, /activation[\s\S]*durable[\s\S]*local CI[\s\S]*pre-push/i);
  assert.match(setupCensus, /remove only[\s\S]*kit-owned census wiring/i);
});

test('brownfield bootstrap activates real surface coverage with a separate behavior overview', async () => {
  const root = await makeBrownfield();
  const profilePath = join(root, PROFILE_RELATIVE_PATH);
  try {
    await assert.rejects(access(profilePath), (error) => error.code === 'ENOENT');
    const facts = await scanCensus({ repoRoot: root, enabled: true });
    assert.equal(facts.state, 'bootstrap');
    await mkdir(join(root, '.census'), { recursive: true });
    await writeFile(profilePath, `${JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      decisions: [
        { family: 'authentication', status: CENSUS_VERDICTS.covered, evidence: 'apps/api/src' },
        {
          family: 'email-delivery',
          status: CENSUS_VERDICTS.notRelevant,
          justification: 'The product sends no email.',
        },
      ],
      localScanners: [],
      overrides: [],
    })}\n`);

    const { activePath, candidate } = await runConsumerCensus(root);
    const persisted = await readJson(activePath);
    const covered = persisted.families.surfaces
      .filter(({ status }) => status === CENSUS_VERDICTS.covered).length;

    assert.equal(candidate.state, 'current');
    assert.equal(persisted.state, 'current');
    assert.equal(`${covered} of ${persisted.families.surfaces.length}`, '3 of 3');
    assert.deepEqual(persisted.families.behaviors, [
      { name: 'authentication', status: 'abgedeckt', type: 'behavior' },
      { name: 'email-delivery', status: 'nicht relevant', type: 'behavior' },
    ]);
    assert.equal(persisted.profileReport.decisions[1].justification, 'The product sends no email.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a second unchanged current run performs no activation write', async () => {
  const root = await makeBrownfield();
  try {
    await mkdir(join(root, '.census'), { recursive: true });
    await writeFile(join(root, PROFILE_RELATIVE_PATH), `${JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      decisions: [],
      localScanners: [],
      overrides: [],
    })}\n`);
    const first = await runConsumerCensus(root);
    assert.equal(first.activated, true);
    const { activePath } = first;
    const beforeBytes = await readFile(activePath, 'utf8');
    const beforeStat = await stat(activePath);

    const second = await runConsumerCensus(root);

    assert.equal(second.activated, false);
    assert.equal(await readFile(activePath, 'utf8'), beforeBytes);
    assert.equal((await stat(activePath)).mtimeMs, beforeStat.mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unexpected surface stays open despite not-relevant decisions and a change-local override', async () => {
  const root = await makeBrownfield();
  try {
    await mkdir(join(root, '.census'), { recursive: true });
    await writeFile(join(root, PROFILE_RELATIVE_PATH), `${JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      decisions: [{
        family: 'postal-delivery',
        justification: 'The product sends no physical mail.',
        status: CENSUS_VERDICTS.notRelevant,
      }],
      localScanners: [],
      overrides: [{ reason: 'Known formatting-only path delta.', scope: 'this change' }],
    })}\n`);
    await runConsumerCensus(root);
    await mkdir(join(root, 'services/payments/src'), { recursive: true });
    await writeFile(join(root, 'services/payments/src/index.mjs'), 'export const payments = true;\n');
    await exec('git', ['add', 'services'], { cwd: root });
    const before = await readJson(join(root, ACTIVE_RELATIVE_PATH));

    await assert.rejects(runConsumerCensus(root), (error) => error.state === 'failed');
    const after = await readJson(join(root, ACTIVE_RELATIVE_PATH));
    assert.equal(serializeCensus(after), serializeCensus(before));
    assert.equal(after.profileReport.decisions[0].status, 'nicht relevant');
    assert.equal(after.profileReport.decisions[0].justification, 'The product sends no physical mail.');
    assert.equal(after.profileReport.overrides[0].scope, 'this change');
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
  try {
    await mkdir(join(root, '.census'), { recursive: true });
    const profilePath = join(root, PROFILE_RELATIVE_PATH);
    await writeFile(profilePath, `${JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      decisions: [],
      localScanners: [],
      overrides: [],
    })}\n`);
    const { activePath } = await runConsumerCensus(root);
    const previous = await readFile(activePath, 'utf8');
    await mkdir(join(root, 'services/payments/src'), { recursive: true });
    await writeFile(join(root, 'services/payments/src/index.mjs'), 'export const payments = true;\n');
    await exec('git', ['add', 'services'], { cwd: root });

    await assert.rejects(runConsumerCensus(root), (error) => error.state === 'failed');
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
    await exec('git', ['add', 'services', 'scripts/census-local', 'test/census-services.test.mjs'], { cwd: root });
    const withScanner = await readJson(profilePath);
    withScanner.localScanners.push({
      surface: 'services/payments/src',
      module: 'scripts/census-local/scan-services.mjs',
      export: 'scanServices',
      test: 'test/census-services.test.mjs',
    });
    await writeFile(profilePath, `${JSON.stringify(withScanner)}\n`);

    const { candidate } = await runConsumerCensus(root);
    const activated = await readJson(activePath);
    assert.equal(candidate.state, 'current');
    assert.equal(activated.profileReport.localScanners[0].test, 'test/census-services.test.mjs');
    assert.notEqual(await readFile(activePath, 'utf8'), previous);

    const fingerprintBeforeOverride = fingerprintCensus(activated);
    withScanner.overrides.push({ reason: 'display only', scope: 'this change' });
    await writeFile(profilePath, `${JSON.stringify(withScanner)}\n`);
    const raw = await scanCensus({ repoRoot: root, enabled: true, hasActive: true });
    assert.deepEqual(fingerprintCensus(raw), fingerprintBeforeOverride);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('local scanner proof rejects absolute, escaping, and symlinked paths', async () => {
  const root = await makeBrownfield();
  const foreign = await mkdtemp(join(tmpdir(), 'awk-foreign-census-proof-'));
  try {
    await mkdir(join(root, '.census'), { recursive: true });
    const profilePath = join(root, PROFILE_RELATIVE_PATH);
    const profile = {
      schemaVersion: 1,
      enabled: true,
      decisions: [],
      localScanners: [],
      overrides: [],
    };
    await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
    const { activePath } = await runConsumerCensus(root);
    const previous = await readFile(activePath, 'utf8');
    await mkdir(join(root, 'services/payments/src'), { recursive: true });
    await writeFile(join(root, 'services/payments/src/index.mjs'), 'export const payments = true;\n');
    await exec('git', ['add', 'services'], { cwd: root });

    await writeFile(join(foreign, 'scanner.mjs'), "export const scanServices = () => ['services/payments/src'];\n");
    await writeFile(
      join(foreign, 'scanner.test.mjs'),
      "import { test } from 'node:test'; test('foreign proof', () => {});\n",
    );
    const records = [
      { module: join(foreign, 'scanner.mjs'), test: join(foreign, 'scanner.test.mjs') },
      {
        module: `../${basename(foreign)}/scanner.mjs`,
        test: `../${basename(foreign)}/scanner.test.mjs`,
      },
    ];
    await symlink(join(foreign, 'scanner.mjs'), join(root, 'scanner-link.mjs'));
    await symlink(join(foreign, 'scanner.test.mjs'), join(root, 'scanner-link.test.mjs'));
    records.push({ module: 'scanner-link.mjs', test: 'scanner-link.test.mjs' });

    for (const record of records) {
      profile.localScanners = [{
        surface: 'services/payments/src',
        export: 'scanServices',
        ...record,
      }];
      await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
      await assert.rejects(runConsumerCensus(root), (error) => error.state === 'failed');
      assert.equal(await readFile(activePath, 'utf8'), previous);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  }
});
