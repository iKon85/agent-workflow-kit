import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

// The planning skills are not usable without their helper ecosystem (Codex R2#1).
// These ship alongside the skills. Paths are relative to the bundle/consumer root.
export const HELPER_FILES = [
  // Shared profile loader imported by the three planning scripts — they read
  // every board-specific value from docs/agents/board-sync.md through it, so it
  // MUST ship or they are broken-on-arrival. Library (imported, not run) → 0o644.
  { path: 'scripts/board_config.py', kind: 'script', mode: 0o644 },
  // Pure Slices-table logic imported by board-sync.py for `anchor-sync` —
  // library (imported, not run) → 0o644. MUST ship or board-sync.py ImportErrors.
  { path: 'scripts/anchor_table.py', kind: 'script', mode: 0o644 },
  // Programm-Graph module for `board-sync.py validate-graph` — split by
  // concern (parse/validate) across three files, all libraries (imported, not
  // run) → 0o644. MUST ship together or board-sync.py ImportErrors.
  { path: 'scripts/program_graph.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/program_graph_parse.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/program_graph_validate.py', kind: 'script', mode: 0o644 },
  // Pure node-kind classifier imported by execute-ready-check.py —
  // library (imported, not run) → 0o644. MUST ship or execute-ready-check.py ImportErrors.
  { path: 'scripts/node_kind.py', kind: 'script', mode: 0o644 },
  // stamp-batch / field-value / promote-guard logic for board-sync.py —
  // library (imported, not run) → 0o644. MUST ship or board-sync.py ImportErrors.
  { path: 'scripts/board_fields.py', kind: 'script', mode: 0o644 },
  // Wellenplan Status-resync for board-sync.py's `program-sync` —
  // library (imported, not run) → 0o644. MUST ship or board-sync.py ImportErrors.
  { path: 'scripts/program_sync.py', kind: 'script', mode: 0o644 },
  // Blocked-by body-mirror logic for the native issue-dependency commands
  // — imported by BOTH board-sync.py (dep-add/dep-remove) and
  // execute-ready-check.py (drift check). Library (imported, not run) → 0o644.
  // MUST ship or both ImportError on arrival.
  { path: 'scripts/issue_deps.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/board-sync.py', kind: 'script', mode: 0o755 },
  { path: 'scripts/execute-ready-check.py', kind: 'script', mode: 0o755 },
  { path: 'scripts/pr-body-check.py', kind: 'script', mode: 0o755 },
  // Mechanical executor for /wrapup (preflight/commit/land) — replaced the
  // Sonnet phase-2 subagent. Imports board_config + anchor_table
  // (both shipped above). Invokable CLI → 0o755.
  { path: 'scripts/wrapup-land.py', kind: 'script', mode: 0o755 },
  // Deterministic release preparation and its manifest-derived local/CI guard.
  // Both are invoked through package scripts by /kit-release.
  { path: 'scripts/kit-release.mjs', kind: 'script', mode: 0o644 },
  { path: 'scripts/release-delta-guard.mjs', kind: 'script', mode: 0o644 },
  // Neutral publish/readback parity and externally reconstructable release state.
  // /kit-release uses these after merge; downstream update/consumer flows reuse
  // the parity primitive rather than growing a second registry/GitHub comparison.
  { path: 'scripts/release-parity.mjs', kind: 'script', mode: 0o644 },
  { path: 'scripts/release-state.mjs', kind: 'script', mode: 0o644 },
  // GitHub-consumer automation: invokes the existing update command, then owns
  // only the stable tested branch/pull-request upsert.
  { path: 'scripts/kit-update-pr.mjs', kind: 'script', mode: 0o755 },
  // Shared hook utility imported by the shipped hooks (drift-guard,
  // sync-board-status). Library (imported, not run) → 0o644. MUST ship or those
  // hooks ImportError on arrival.
  { path: '.claude/hooks/_hook_utils.py', kind: 'hook', mode: 0o644 },
  { path: '.claude/hooks/drift-guard.py', kind: 'hook', mode: 0o755 },
  // SessionStart skill-freshness drift-hint (audit-skills names it). For each
  // <skill>/SOURCES.txt it flags sources newer in git than the SKILL.md. Imports
  // _hook_utils (shipped above); stdlib-only otherwise. Executable hook → 0o755.
  { path: '.claude/hooks/skill-drift-hint.py', kind: 'hook', mode: 0o755 },
  // Board-status pickup hook — profile-driven (reads project/field/status ids
  // from the consumer-seeded board profile), so it ships portably. /tdd names it.
  { path: '.claude/hooks/sync-board-status.py', kind: 'hook', mode: 0o755 },
  { path: 'docs/agents/wave-anchor-template.md', kind: 'template', mode: 0o644 },
  // Part-0–5 security-audit runbook skeleton (the security-audit skill names it).
  // The stack-coupled checklist is deliberately NOT shipped — this template is the
  // generic structure a consumer copies + fills stack-specifically. Prose → 0o644.
  { path: 'docs/agents/security-audit-runbook-template.md', kind: 'template', mode: 0o644 },
  // Opt-in LoC-offender drive gate (setup-workflow §7b names it). Both are
  // stdlib-only and profile-driven (threshold + offenders read from the
  // consumer-seeded max-lines-allowlist.json), so they ship portably. The gate
  // imports the core, so the core MUST ship too. core = library → 0o644;
  // gate = invokable CLI (pre-push / manual) → 0o755.
  { path: 'scripts/loc_offender_core.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/loc_offender_gate.py', kind: 'script', mode: 0o755 },
];

// Project-layer docs `init` seeds as empty stubs (sentinel first line). NOT
// board-sync.md — that is discovery-dependent, /setup-workflow classifies+fills it
// (Codex R1#8).
export const STUB_TARGETS = [
  'docs/agents/issue-tracker.md',
  'docs/agents/triage-labels.md',
  'docs/agents/domain.md',
  'docs/agents/skills/spec-self-critique.md',
  'docs/agents/skills/orchestrate-wave.md',
  'docs/agents/skills/local-ci.md',
  'docs/agents/skills/git-worktree-recover.md',
  'docs/agents/skills/audit-skills.md',
  'docs/agents/skills/security-audit.md',
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
