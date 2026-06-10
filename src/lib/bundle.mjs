import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

// The planning skills are not usable without their helper ecosystem (Codex R2#1).
// These ship alongside the skills. Paths are relative to the bundle/consumer root.
export const HELPER_FILES = [
  // Shared profile loader imported by the three planning scripts — they read
  // every board-specific value from docs/agents/board-sync.md through it, so it
  // MUST ship or they are broken-on-arrival. Library (imported, not run) → 0o644.
  { path: 'scripts/board_config.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/board-sync.py', kind: 'script', mode: 0o755 },
  { path: 'scripts/execute-ready-check.py', kind: 'script', mode: 0o755 },
  { path: 'scripts/pr-body-check.py', kind: 'script', mode: 0o755 },
  { path: '.claude/hooks/drift-guard.py', kind: 'hook', mode: 0o755 },
  { path: 'docs/agents/wave-anchor-template.md', kind: 'template', mode: 0o644 },
];

// Project-layer docs `init` seeds as empty stubs (sentinel first line). NOT
// board-sync.md — that is discovery-dependent, /setup-workflow classifies+fills it
// (Codex R1#8).
export const STUB_TARGETS = [
  'docs/agents/issue-tracker.md',
  'docs/agents/triage-labels.md',
  'docs/agents/domain.md',
  'docs/agents/skills/spec-self-critique.md',
  'docs/conventions/spec-completeness.md',
];

const SURFACE_DIR = { claude: '.claude/skills', codex: '.agents/skills' };

/** Skills with publish:true, each with the surfaces it installs into. */
export function publishableSkills(manifest) {
  return Object.entries(manifest.skills)
    .filter(([, e]) => e.publish)
    .map(([name, e]) => ({ name, surfaces: e.surfaces }));
}

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * Every file to copy from the kit into a consumer, plus the doc stubs to seed.
 * Returns { files: [{ src, dest, kind, ownerSkill?, surface?, mode }], stubs: [paths] }.
 * `src`/`dest` are repo-root-relative (same layout in kit and consumer).
 */
export async function collectBundle(repoRoot, manifest) {
  const files = [];
  for (const { name, surfaces } of publishableSkills(manifest)) {
    for (const surface of surfaces) {
      const base = join(SURFACE_DIR[surface], name);
      for (const abs of await walk(join(repoRoot, base))) {
        const rel = relative(repoRoot, abs);
        files.push({ src: rel, dest: rel, kind: 'skill', ownerSkill: name, surface, mode: 0o644 });
      }
    }
  }
  for (const h of HELPER_FILES) {
    files.push({ src: h.path, dest: h.path, kind: h.kind, mode: h.mode });
  }
  return { files, stubs: STUB_TARGETS };
}
