import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishableSkills, HELPER_FILES, STUB_TARGETS } from '../src/lib/bundle.mjs';

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

test('HELPER_FILES ships the recon report reconciler exactly once', () => {
  const paths = HELPER_FILES.map(({ path }) => path);
  assert.equal(paths.filter((path) => path === 'src/lib/reconcileReconReports.mjs').length, 1);
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
