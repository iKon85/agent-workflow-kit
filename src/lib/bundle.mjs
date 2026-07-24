import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

// The planning skills are not usable without their helper ecosystem (Codex R2#1).
// These ship alongside the skills. Paths are relative to the bundle/consumer root.
export const HELPER_FILES = [
  // Readiness declarations and their deterministic consumer-side command ship
  // together; the manifest remains the only capability/dependency registry.
  { path: '.claude/skills/skill-manifest.json', kind: 'doc', mode: 0o644 },
  { path: 'scripts/readiness.mjs', kind: 'script', mode: 0o755 },
  { path: 'src/lib/sentinel.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/manifest.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/atomicWrite.mjs', kind: 'script', mode: 0o644 },
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
  // Exact issue-identity marker grammar shared by board-sync.py and the
  // all-state lookup CLI. Library → 0o644; invokable CLI → 0o755.
  { path: 'scripts/marker_lib.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/find-by-marker.py', kind: 'script', mode: 0o755 },
  // Structured Codex executor: shell entrypoint delegates process-group
  // lifecycle to its stdlib-only Python library. The pure anchor renderer is
  // invoked directly by to-issues. Entrypoints → 0o755; library → 0o644.
  { path: 'scripts/codex-exec.sh', kind: 'script', mode: 0o755 },
  { path: 'scripts/codex_proc.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/render-anchor.py', kind: 'script', mode: 0o755 },
  { path: 'scripts/board-sync.py', kind: 'script', mode: 0o755 },
  { path: 'scripts/execute-ready-check.py', kind: 'script', mode: 0o755 },
  { path: 'scripts/pr-body-check.py', kind: 'script', mode: 0o755 },
  { path: 'scripts/pr_body_e2e.py', kind: 'script', mode: 0o644 },
  // Mechanical executor for /wrapup (preflight/commit/land) — replaced the
  // Sonnet phase-2 subagent. Imports board_config + anchor_table
  // (both shipped above). Invokable CLI → 0o755.
  { path: 'scripts/wrapup-land.py', kind: 'script', mode: 0o755 },
  // Deterministic release preparation and its manifest-derived local/CI guard.
  // Both are invoked through package scripts by /kit-release.
  { path: 'scripts/kit-release.mjs', kind: 'script', mode: 0o644, installRole: 'maintainer' },
  { path: 'scripts/release-delta-guard.mjs', kind: 'script', mode: 0o644, installRole: 'maintainer' },
  // Neutral publish/readback parity and externally reconstructable release state.
  // /kit-release uses these after merge; downstream update/consumer flows reuse
  // the parity primitive rather than growing a second registry/GitHub comparison.
  { path: 'scripts/release-parity.mjs', kind: 'script', mode: 0o644 },
  { path: 'scripts/release-state.mjs', kind: 'script', mode: 0o644 },
  // Consumer-owned project release profiles use these read-only shared
  // primitives before any apply/commit/tag action is allowed. The thin CLI
  // owns only repository-fact collection and delegates to the same engine.
  { path: 'src/lib/semver.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/release-preview.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/release-apply.mjs', kind: 'script', mode: 0o644 },
  { path: 'scripts/project-release.mjs', kind: 'script', mode: 0o755 },
  // Canonical schema and semantic validator shared across orchestration paths.
  // Library → 0o644; later helper-owning slices append their paths once present.
  { path: 'src/lib/reportValidator.mjs', kind: 'script', mode: 0o644 },
  // Fail-closed orchestration selector and its host-inventory adapters.
  { path: 'src/lib/capabilityMatrix.mjs', kind: 'script', mode: 0o644 },
  // Provider-neutral routing runtime: one Evidence catalog, Access graph,
  // Routing policy, resolver, spawn guard, receipt v2, and surface attestations.
  // These modules form one consumer unit; omitting one leaves shipped dispatch
  // prose pointing at a resolver or adapter that cannot execute.
  { path: 'src/commands/routing-policy-update.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/agentSurfaceRegistry.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/dispatchReceipt.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/frontendWorkloads.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routeDispatcher.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingAccessGraph.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingAdapters/claude.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingAdapters/codex.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingCatalog.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingEvidenceCache.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingIntent.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingPolicy.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingProfile.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingResolver.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingSources/artificialAnalysis.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingSources/benchlm.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingSources/codeArena.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingSources/deepswe.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingSources/openhands.mjs', kind: 'script', mode: 0o644 },
  { path: 'src/lib/routingSources/openhandsFrontend.mjs', kind: 'script', mode: 0o644 },
  // Main-thread recon boundary shared by every orchestration path.
  { path: 'src/lib/reconcileReconReports.mjs', kind: 'script', mode: 0o644 },
  // Atomic compare-and-set wave claim: two sessions cannot orchestrate the same
  // wave. Library (imported by the Phase-0 claim protocol) → 0o644.
  { path: 'src/lib/waveClaim.mjs', kind: 'script', mode: 0o644 },
  // GitHub-consumer automation: invokes the existing update command, then owns
  // only the stable Kit-verified branch/pull-request upsert.
  { path: 'scripts/kit-update-pr.mjs', kind: 'script', mode: 0o755 },
  // Stdlib-only project census foundation. index.mjs is the stable consumer
  // entrypoint; its five local modules must ship with it as one helper unit.
  { path: 'scripts/census/index.mjs', kind: 'script', mode: 0o644 },
  { path: 'scripts/census/scan.mjs', kind: 'script', mode: 0o644 },
  { path: 'scripts/census/fingerprint.mjs', kind: 'script', mode: 0o644 },
  { path: 'scripts/census/delta.mjs', kind: 'script', mode: 0o644 },
  { path: 'scripts/census/state.mjs', kind: 'script', mode: 0o644 },
  { path: 'scripts/census/transaction.mjs', kind: 'script', mode: 0o644 },
  // Consumer-owned memory planning, one-time policy seeding, and recovery.
  { path: 'scripts/memory-lifecycle/index.mjs', kind: 'script', mode: 0o644 },
  { path: 'scripts/memory-lifecycle/setup.mjs', kind: 'script', mode: 0o644 },
  { path: 'assets/memory-templates/meta_decision_layer_choice.md', kind: 'template', mode: 0o644 },
  { path: 'assets/memory-templates/meta_memory_lifecycle.md', kind: 'template', mode: 0o644 },
  // Profile-driven Worktree Lifecycle foundation. The setup adapter imports
  // core.py, while capabilities.json keeps the historical 8/8 denominator
  // explicit until the remaining hook and cleanup adapters are activated.
  { path: 'scripts/worktree-lifecycle/core.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/worktree-lifecycle/profile.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/worktree-lifecycle/setup.py', kind: 'script', mode: 0o755 },
  { path: 'scripts/worktree-lifecycle/cleanup.py', kind: 'script', mode: 0o755 },
  { path: 'scripts/worktree-lifecycle/capabilities.json', kind: 'doc', mode: 0o644 },
  { path: 'scripts/worktree-lifecycle/README.md', kind: 'doc', mode: 0o644 },
  // Shared hook utility imported by the shipped hooks (drift-guard,
  // sync-board-status). Library (imported, not run) → 0o644. MUST ship or those
  // hooks ImportError on arrival.
  { path: '.claude/hooks/_hook_utils.py', kind: 'hook', mode: 0o644 },
  // Thin Worktree Lifecycle adapters; all branch parsing, traversal and
  // fail-open/fail-closed policy stays in scripts/worktree-lifecycle/core.py.
  { path: '.claude/hooks/branch-context.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/branch-watch.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/enforce-worktree.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/enforce-worktree-cwd.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/enforce-worktree-discipline.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/slice-handoff-hint.py', kind: 'hook', mode: 0o755 },
  // Advisory provenance hint for agent Edit/Write events. It reads the local
  // consumer manifest once and fails open; setup-workflow owns activation.
  { path: '.claude/hooks/kit-origin-edit-hint.py', kind: 'hook', mode: 0o755 },
  // Profile-driven non-blocking change-lifecycle advisories. The shell Stop
  // entry delegates to its sibling Python adapter; decisions stay in core.py.
  { path: 'scripts/workflow-advisories/core.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/workflow-advisories/capabilities.json', kind: 'doc', mode: 0o644 },
  { path: '.claude/hooks/recon-size-hint.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/baseline-capture-hint.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/pre-refactor-sweep.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/typecheck-on-stop.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/typecheck-on-stop.sh', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/convention-drift-hint.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/migration-snapshot-reminder.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/loc-offender-forewarn.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/drift-guard.py', kind: 'hook', mode: 0o755 },
  // Counted Safety Guardrails unit: shared policy/search core, one loader,
  // four thin Agent adapters, and three portable repository-security
  // primitives. Activation stays consumer-owned through setup-workflow.
  { path: 'scripts/safety-guardrails/core.py', kind: 'script', mode: 0o644 },
  { path: 'scripts/safety-guardrails/search.py', kind: 'script', mode: 0o644 },
  { path: '.claude/hooks/_safety_guard.py', kind: 'hook', mode: 0o644 },
  { path: '.claude/hooks/block-secrets.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/block-npm-install-in-pnpm.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/block-bg-double-background.py', kind: 'hook', mode: 0o755 },
  { path: '.claude/hooks/grep-shim-guard.py', kind: 'hook', mode: 0o755 },
  { path: 'scripts/security/install-git-hooks.mjs', kind: 'script', mode: 0o755 },
  { path: 'scripts/security/ensure-gitleaks.mjs', kind: 'script', mode: 0o755 },
  { path: 'scripts/security/gitleaks-profile.json', kind: 'doc', mode: 0o644 },
  { path: 'scripts/security/audit-gate.mjs', kind: 'script', mode: 0o755 },
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
    .map(([name, e]) => ({ name, surfaces: e.surfaces, installRole: e.installRole ?? 'consumer' }));
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
  for (const { name, surfaces, installRole } of publishableSkills(manifest)) {
    for (const surface of surfaces) {
      const base = join(SURFACE_DIR[surface], name);
      for (const abs of await walk(join(repoRoot, base))) {
        const rel = relative(repoRoot, abs);
        files.push({
          src: rel, dest: rel, kind: 'skill', ownerSkill: name, surface,
          installRole, mode: 0o644,
        });
      }
    }
  }
  for (const h of HELPER_FILES) {
    files.push({
      src: h.path, dest: h.path, kind: h.kind,
      installRole: h.installRole ?? 'consumer', mode: h.mode,
    });
  }
  return { files, stubs: STUB_TARGETS };
}
