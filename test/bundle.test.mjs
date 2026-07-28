import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  publishableSkills, HELPER_FILES, STUB_TARGETS, verifyBundle, ROUTING_UNIT_PATTERN,
} from '../src/lib/bundle.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ROUTING_UNIT = [
  'src/lib/routingInventory.mjs',
  'src/lib/routingInventory/snapshots/claude.json',
  'src/lib/routingInventory/snapshots/codex.json',
];

const digest = (content) => createHash('sha256').update(content).digest('hex');

/**
 * A miniature bundle root: the real pinned routing unit plus whatever extra
 * files a scenario needs, with a manifest that describes exactly what shipped.
 */
async function bundleFixture({ extra = [], skip = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'awkit-verify-'));
  const files = [];
  for (const path of ROUTING_UNIT.filter((p) => !skip.includes(p))) {
    const content = await readFile(join(REPO, path));
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
    files.push({
      path, kind: 'script', installRole: 'consumer', mode: 0o644, sha256: digest(content),
    });
  }
  for (const { path, source, installRole = 'consumer' } of extra) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
    files.push({
      path, kind: 'script', installRole, mode: 0o644, sha256: digest(source),
    });
  }
  const helperFiles = files.map(({ path, kind, installRole }) => ({
    path, kind, mode: 0o644, installRole,
  }));
  return {
    root, helperFiles, manifest: { kitVersion: '0.0.0', files },
    verify: (overrides = {}) => verifyBundle({
      bundleRoot: root, manifest: { kitVersion: '0.0.0', files }, helperFiles, ...overrides,
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const MANIFEST = {
  skills: {
    'to-prd': { class: 'generic', publish: true, surfaces: ['claude', 'codex'] },
    'board-to-waves': { class: 'generic', publish: true, surfaces: ['claude', 'codex'] },
    'grill-me-codex': { class: 'vendored', publish: true, surfaces: ['claude'] },
    'drizzle': { class: 'project-private', publish: false, surfaces: ['claude', 'codex'] },
    'codex-adapter-sync': { class: 'adapter', publish: false, surfaces: ['codex'] },
  },
};

test('publishableSkills returns only publish:true skills with their surfaces', () => {
  const got = publishableSkills(MANIFEST);
  const names = got.map((s) => s.name).sort();
  assert.deepEqual(names, ['board-to-waves', 'grill-me-codex', 'to-prd']);
  assert.deepEqual(got.find((s) => s.name === 'grill-me-codex').surfaces, ['claude']);
});

test('publishableSkills excludes project-private and adapter', () => {
  const names = publishableSkills(MANIFEST).map((s) => s.name);
  assert.ok(!names.includes('drizzle'));
  assert.ok(!names.includes('codex-adapter-sync'));
});

test('HELPER_FILES ships the planning ecosystem (scripts, hook, template)', () => {
  const paths = HELPER_FILES.map((h) => h.path);
  assert.ok(paths.includes('scripts/board-sync.py'));
  assert.ok(paths.includes('.claude/hooks/drift-guard.py'));
  assert.ok(paths.includes('docs/agents/wave-anchor-template.md'));
  // the shared board_config loader MUST ship — the 3 scripts import it
  assert.ok(paths.includes('scripts/board_config.py'));
  assert.ok(paths.includes('scripts/pr_body_e2e.py'));
  // scripts are executable
  assert.equal(HELPER_FILES.find((h) => h.path === 'scripts/board-sync.py').mode, 0o755);
  // board_config is an imported library, not a runnable entrypoint
  assert.equal(HELPER_FILES.find((h) => h.path === 'scripts/board_config.py').mode, 0o644);
  assert.equal(HELPER_FILES.find((h) => h.path === 'scripts/pr_body_e2e.py').mode, 0o644);
  assert.equal(HELPER_FILES.find((h) => h.path === 'scripts/readiness.mjs').mode, 0o755);
  assert.ok(paths.includes('.claude/skills/skill-manifest.json'));
  assert.ok(paths.includes('src/lib/sentinel.mjs'));
  assert.ok(paths.includes('src/lib/manifest.mjs'));
  assert.ok(paths.includes('src/lib/atomicWrite.mjs'));
});

test('HELPER_FILES ships the complete census foundation', () => {
  const paths = new Set(HELPER_FILES.map(({ path }) => path));
  const censusModules = [
    'scripts/census/index.mjs',
    'scripts/census/scan.mjs',
    'scripts/census/fingerprint.mjs',
    'scripts/census/delta.mjs',
    'scripts/census/state.mjs',
    'scripts/census/transaction.mjs',
  ];
  assert.deepEqual(censusModules.filter((path) => !paths.has(path)), []);
});

test('HELPER_FILES ships the complete memory lifecycle unit', () => {
  const paths = new Set(HELPER_FILES.map(({ path }) => path));
  const memoryUnit = [
    'scripts/memory-lifecycle/index.mjs',
    'scripts/memory-lifecycle/setup.mjs',
    'assets/memory-templates/meta_decision_layer_choice.md',
    'assets/memory-templates/meta_memory_lifecycle.md',
  ];
  assert.deepEqual(memoryUnit.filter((path) => !paths.has(path)), []);
});

test('HELPER_FILES ships the report validator exactly once', () => {
  const paths = HELPER_FILES.map(({ path }) => path);
  assert.equal(paths.filter((path) => path === 'src/lib/reportValidator.mjs').length, 1);
});

test('HELPER_FILES ships the capability matrix exactly once', () => {
  const paths = HELPER_FILES.map(({ path }) => path);
  assert.equal(paths.filter((path) => path === 'src/lib/capabilityMatrix.mjs').length, 1);
});

test('HELPER_FILES ships every Wave 13 routing runtime module exactly once', () => {
  const paths = HELPER_FILES.map(({ path }) => path);
  const routingRuntime = [
    'src/commands/routing-policy-update.mjs',
    'src/lib/agentSurfaceRegistry.mjs',
    'src/lib/capabilityMatrix.mjs',
    'src/lib/dispatchReceipt.mjs',
    'src/lib/frontendWorkloads.mjs',
    'src/lib/routeDispatcher.mjs',
    'src/lib/routingAccessGraph.mjs',
    'src/lib/routingAdapters/claude.mjs',
    'src/lib/routingAdapters/codex.mjs',
    'src/lib/routingCatalog.mjs',
    'src/lib/routingEvidenceCache.mjs',
    'src/lib/routingIntent.mjs',
    'src/lib/routingPolicy.mjs',
    'src/lib/routingProfile.mjs',
    'src/lib/routingResolver.mjs',
    'src/lib/routingSources/artificialAnalysis.mjs',
    'src/lib/routingSources/benchlm.mjs',
    'src/lib/routingSources/codeArena.mjs',
    'src/lib/routingSources/deepswe.mjs',
    'src/lib/routingSources/openhands.mjs',
    'src/lib/routingSources/openhandsFrontend.mjs',
  ];
  assert.deepEqual(
    routingRuntime.filter((path) => paths.filter((candidate) => candidate === path).length !== 1),
    [],
  );
});

test('HELPER_FILES ships the recon report reconciler exactly once', () => {
  const paths = HELPER_FILES.map(({ path }) => path);
  assert.equal(paths.filter((path) => path === 'src/lib/reconcileReconReports.mjs').length, 1);
});

test('HELPER_FILES ships the wave claim helper exactly once', () => {
  const paths = HELPER_FILES.map(({ path }) => path);
  assert.equal(paths.filter((path) => path === 'src/lib/waveClaim.mjs').length, 1);
  assert.equal(HELPER_FILES.find((h) => h.path === 'src/lib/waveClaim.mjs').mode, 0o644);
});

test('HELPER_FILES ships the pinned routing inventory unit exactly once', () => {
  const paths = HELPER_FILES.map(({ path }) => path);
  for (const path of ROUTING_UNIT) {
    assert.equal(paths.filter((candidate) => candidate === path).length, 1, path);
    assert.equal(HELPER_FILES.find((h) => h.path === path).mode, 0o644);
    assert.equal(HELPER_FILES.find((h) => h.path === path).installRole ?? 'consumer', 'consumer');
    assert.ok(ROUTING_UNIT_PATTERN.test(path), path);
  }
});

test('bundle verification proves hashes, roles, closure and an installed-consumer smoke run', async () => {
  const fixture = await bundleFixture();
  try {
    const report = await fixture.verify();
    assert.deepEqual(report.checks, {
      manifestHashes: true, installRoles: true, importClosure: true, consumerSmoke: true,
    });
    assert.deepEqual(report.findings, []);
    assert.equal(report.ok, true);
    assert.equal(report.routingUnitCount, ROUTING_UNIT.length);
    assert.match(report.inventoryRevision, /^sha256-[A-Za-z0-9_-]{43}$/);
  } finally { await fixture.cleanup(); }
});

test('bundle verification fails when a shipped byte no longer matches the package manifest', async () => {
  const fixture = await bundleFixture();
  try {
    await writeFile(join(fixture.root, 'src/lib/routingInventory.mjs'),
      `${await readFile(join(fixture.root, 'src/lib/routingInventory.mjs'), 'utf8')}\n// drift\n`);
    const report = await fixture.verify();
    assert.equal(report.ok, false);
    assert.equal(report.checks.manifestHashes, false);
    assert.ok(report.findings.some((f) => f.check === 'manifestHashes'
      && f.detail.includes('src/lib/routingInventory.mjs')));
  } finally { await fixture.cleanup(); }
});

test('bundle verification fails when a shipped file is missing from the bundle root', async () => {
  const fixture = await bundleFixture();
  try {
    await rm(join(fixture.root, 'src/lib/routingInventory/snapshots/codex.json'));
    const report = await fixture.verify();
    assert.equal(report.ok, false);
    assert.equal(report.checks.manifestHashes, false);
    // the snapshot the module resolves beside itself is gone, so the installed
    // consumer cannot build an inventory either
    assert.equal(report.checks.consumerSmoke, false);
    assert.equal(report.inventoryRevision, null);
  } finally { await fixture.cleanup(); }
});

test('bundle verification fails when a consumer import escapes the installed file set', async () => {
  const fixture = await bundleFixture({
    extra: [
      { path: 'src/lib/consumerEntry.mjs', source: "import './maintainerOnly.mjs';\nexport const x = 1;\n" },
      { path: 'src/lib/maintainerOnly.mjs', source: 'export const y = 2;\n', installRole: 'maintainer' },
    ],
  });
  try {
    const report = await fixture.verify();
    assert.equal(report.ok, false);
    assert.equal(report.checks.importClosure, false);
    assert.ok(report.findings.some((f) => f.check === 'importClosure'
      && f.detail.includes('src/lib/consumerEntry.mjs')));
  } finally { await fixture.cleanup(); }
});

test('bundle verification fails on an unknown install role or a role that drifted from its declaration', async () => {
  const fixture = await bundleFixture({
    extra: [{ path: 'src/lib/oddRole.mjs', source: 'export const z = 3;\n' }],
  });
  try {
    const stray = fixture.manifest.files.find(({ path }) => path === 'src/lib/oddRole.mjs');
    stray.installRole = 'operator';
    const unknownRole = await fixture.verify();
    assert.equal(unknownRole.checks.installRoles, false);
    assert.ok(unknownRole.findings.some((f) => f.detail.includes('operator')));

    stray.installRole = 'consumer';
    fixture.helperFiles.find(({ path }) => path === 'src/lib/oddRole.mjs').installRole = 'maintainer';
    const drifted = await fixture.verify();
    assert.equal(drifted.checks.installRoles, false);
    assert.ok(drifted.findings.some((f) => f.detail.includes('src/lib/oddRole.mjs')));
  } finally { await fixture.cleanup(); }
});

test('bundle verification fails when the routing unit does not ship at all', async () => {
  const fixture = await bundleFixture({
    skip: ROUTING_UNIT,
    extra: [{ path: 'src/lib/unrelated.mjs', source: 'export const q = 4;\n' }],
  });
  try {
    const report = await fixture.verify();
    assert.equal(report.ok, false);
    assert.equal(report.checks.consumerSmoke, false);
    assert.equal(report.routingUnitCount, 0);
  } finally { await fixture.cleanup(); }
});

test('STUB_TARGETS lists docs to seed but never board-sync.md', () => {
  assert.ok(STUB_TARGETS.includes('docs/agents/issue-tracker.md'));
  assert.ok(!STUB_TARGETS.some((p) => p.endsWith('board-sync.md')));
});

test('STUB_TARGETS seeds the orchestrate-wave project layer', () => {
  // orchestrate-wave probes docs/agents/skills/orchestrate-wave.md at runtime;
  // a consumer must get a sentinel stub so the Phase-0 probe reads "absent"
  // (generic fallback) instead of a missing file (#1958). Guard against removal.
  assert.ok(STUB_TARGETS.includes('docs/agents/skills/orchestrate-wave.md'));
});
