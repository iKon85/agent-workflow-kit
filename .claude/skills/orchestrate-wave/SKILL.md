---
name: orchestrate-wave
description: >-
  Use when the user hands you a whole WAVE / cluster of pre-planned, file-disjoint
  slices and wants you to ORCHESTRATE building, verifying AND landing it end-to-end —
  often AFK / "ultracode". Triggers: "orchestriere Welle #N" (or any wording that
  delegates wave-landing responsibility to you), "ultracode diese Welle / diesen
  Cluster", or a wave-anchor issue (a cluster/umbrella issue with file-disjoint
  sub-issues whose specs are already locked) handed over to land. NOT for a single
  slice (just `tdd` it), NOT for finding/clustering a wave (that's `board-to-waves`),
  NOT for planning specs (that's `grill-with-docs`/`to-issues`).
---

# Orchestrate Wave

You are the orchestrator. The user gives you a wave anchor (a cluster/umbrella
issue with file-disjoint sub-issues whose specs/decisions are already locked) and
says "land it". You decide inline-vs-delegate; you are responsible for it landing
correctly, AFK. Subagents BUILD; **you** integrate + verify + land.

The anchor, its sub-issues and the locked plan doc contain the verbatim contracts
you must NOT paraphrase.

> **Phase 0 probes a project layer.** Concrete tooling — exact test/verify
> commands, a DB/tunnel setup, a headless login recipe, brand checks, deploy
> lockstep — is project-specific and lives in a **project layer** this skill reads
> at runtime, not in this skeleton. The skeleton names the layer's sections
> (`§Setup`, `§Builder Commands`, `§Builder Hard Rules`, `§Integration Suites`,
> `§Verify Recipe`, `§Headless Login`, `§Landing`) and falls back to generic
> instructions when the layer is absent. See **Phase 0**.

## Standing rules (all phases)

- **AFK heartbeat.** A wave run may take time but must never look stuck: during any
  long-running gate (dispatch wait, integration suite, full verify, browser/E2E,
  migration) send a short status update at least every ~30 s and on every phase
  change — current gate, last green milestone, next step, visible blocker/risk. A
  still-running tool session is stated as such; never wait silently for the final
  result.
- **Degrade by subtraction, never by improvisation.** The defined failure paths:
  - **Slice stays red after escalation** (2-strikes rule, see Routing): pull the
    slice — do not merge it (or revert its merge), pull every dependent that
    consumes its artifacts (Phase-1 graph), land the remaining green subset, create
    a tracking issue, leave its anchor row open, report the pull prominently.
  - **Schema wave degraded:** if a pulled slice owns a migration/schema that a
    remaining slice reads, the ONE-lockstep-window premise no longer holds → STOP,
    land nothing schema-dependent, report.
  - **Plan-level error** (integration/verify reveals a wrong LOCKED decision, not a
    slice bug): STOP the wave. No improvised redesign AFK — keep worktrees intact,
    report findings + options.
- **Routing = one axis: how expensive is a wrong result to catch?** Mechanically
  caught (test/screenshot/lint) → default tier at medium/low effort; plausible-but-
  wrong / subtle logic / architecture → top tier at high effort + main-thread
  re-verify; review/verify verdicts never below high. Concrete tier→model mapping
  lives in your dispatch/model doctrine, if present — no model names here.
  Escalate a repeatedly-failing slice one tier/effort up on the 2-strikes rule (2×
  same problem despite concrete feedback, or structurally wrong approach — NOT the
  first red test). The same axis sets how hard you re-verify. Borderline → default
  tier + re-verify beats blanket top tier.

## Phase 0 — Setup

1. **Read everything**: the anchor body, every sub-issue body (each has a Handoff
   block: scope, blast-radius, live-verify, PR line), and the locked plan /
   plan-review doc in the planning worktree (file-exact).
2. **Probe the project layer.** Read the project layer doc for this skill (the
   consumer's `docs/agents/skills/orchestrate-wave.md` or the path your project
   uses). If its `§`-sections carry **filled** content, follow the project recipe
   wherever a phase below points at a `§`-section. If the file is only a
   `setup-workflow` sentinel stub (empty headings, no real content) or absent,
   treat the layer as **ABSENT** → use the generic fallback in each phase and warn
   **once** that `/setup-workflow` plus project maintenance fill the layer (the
   commands/tunnel/login can't be guessed). Never treat an empty heading as a
   verify recipe.
3. **Wave worktree**: reuse the planning worktree (never re-create; the handoff
   points there). Bring its branch to current `main`:
   `git -C <wave> merge --ff-only origin/main` (if your repo guards destructive
   git, ff-merge is the safe path — not `reset --hard`). Install dependencies with
   your package manager after (the lockfile may have moved). A gitignored plan doc
   survives the merge.
4. **Run project setup steps (`§Setup`)** the later verify needs — e.g. a DB
   tunnel or service the live-verify depends on. Absent layer → start whatever your
   live-verify environment requires before Phase 4.

**Done when:** anchor + every sub-issue + plan read · project layer probed
(filled → project recipe; stub/absent → generic + one-time warning) · wave branch
ff'd to `origin/main` + deps installed · project setup steps running.

## Phase 1 — Disjointness recon (the load-bearing step)

Zero merge conflicts later depends entirely on getting this right.

- Delegate to a read-only investigator agent: for EACH slice the exact file path of
  every named component + resolve ambiguous targets, then a **FILE → SLICES** table
  listing every file that appears in ≥2 slices.
- Build the **overlap graph**. Identify the **conflict hub** (the slice whose new
  artifacts other slices reuse). **Build the hub first**, merge it, THEN the
  dependents stop conflicting.
- Cut into **waves of fully file-disjoint slices**. Edited-by-≥2 = serialize across
  waves; only-shared-via-import = safe. A new primitive edited by one slice but
  *consumed* by others is NOT a conflict.
- **Reconcile contradictory sub-issue ACs against the plan BEFORE dispatch — the
  plan is authority.** `to-issues` cuts slices independently, so a shared
  append-only file (a query-key registry, a barrel, a shared types module) is often
  claimed by *every* slice, with duplicate/clashing adds. **The hub slice OWNS the
  shared-mutable file: it pre-adds ALL the wave's keys/types/helpers; dependents
  CONSUME only and never touch it.** Embed verbatim in each dependent's contract:
  "X already exists in `<file>` — do NOT add it, consume only." (Real case: all 14
  sub-issues claimed the same registry adds + 4 contradictions — hub expanded to
  own all 20 keys, batch merged conflict-free.)

**Done when:** FILE→SLICES table exists · every ≥2-slice file has exactly ONE
owning slice · disjoint waves cut in dependency order · every dependent contract
carries its verbatim consume-only lines.

## Phase 2 — Dispatch one wave in parallel (isolated worktree per implementer)

Phase 2+3 repeat **per disjoint wave** from Phase 1 — the conflict-hub wave first.
Within ONE wave, all slices dispatch at once. Two per-slice calls first: **(a)
inline vs delegate** — a tiny mechanical bit (a rename, a 1-2-line tweak) you do
yourself — and **(b) tier + effort** (Standing rules → Routing). For each
delegated slice:

- **One worktree per agent** off the wave-branch HEAD, own index so parallel agents
  never share a git index. Use your project's worktree-setup command (`§Setup`),
  else plain `git worktree add <path> -b feat/<anchor>-<slug>`.
- **Build the prompt from [`references/builder-contract.md`](references/builder-contract.md)**
  — fill the slots with the slice's VERBATIM What+AC, plan decision, recon
  file:line map and consume-only lines; never paraphrase (paraphrase drift has
  produced real contract errors). The template is the SSOT for the builder's hard
  rules, test/typecheck commands, workflow order and report format.
- **Capture reusable names** from the hub agent's report (the new component/helper
  paths) and embed them into the dependent slices' contracts.

**Done when:** every dispatched slice reported back with commit SHA + green
package tests + green fast gate (`§Builder Commands`) — or a STOP item you resolved
(answered / re-dispatched) before integration.

## Phase 3 — Serial integration

In the wave worktree: `git merge --no-ff <slice-branch>` per slice (disjoint →
conflict-free). After EACH wave, on the integrated branch:

- Typecheck both packages + the **FULL suite** — catches sibling/consumer test
  breaks the agent ownership didn't cover (hardcoded count/tab asserts). Exact
  commands = `§Integration Suites` (absent layer → your project's full test +
  typecheck for every package the wave touched).
- **Run EVERY test framework the wave's files belong to**, not just the primary
  one: a kit/tooling/scripts wave may also have a separate unit-test runner and a
  separate script-test runner the main suite does NOT cover (real case: a
  second-framework red rode 3 integrations before surfacing). `§Integration Suites`
  names each framework for this project.

**Done when:** every framework green on the integrated branch — before dispatching
the next wave.

## Phase 4 — Central verify (YOURS, serial — the user explicitly wants this)

Live-verify asserts USER OUTCOME (a DB-/UI value compared), not a tech metric.
A single browser + single dev DB ⇒ verify is serial and yours. **A subagent's
"PASS" is a hypothesis, not a gate** — implementers repeatedly mis-report green
(real case: "gate PASS" while a size gate was red; files declared missing that
existed). Never merge on the subagent's word.

- **Re-run your project's full CI/verify gate CENTRALLY yourself** (`§Verify
  Recipe`). On an integrated verify/coordinator branch (no per-slice issue number)
  a branch-name-derived guard can BLOCK with no matching baseline — a branch-naming
  artifact, not a coverage gap (each slice branch carried its own); `§Verify
  Recipe` names the skip/override for that. Absent layer → run your project's
  verification command or a project-provided verification skill (e.g. the kit's
  **`/local-ci`** gate), if one exists; if the project has neither, run its full
  test + typecheck and assert each slice's AC as a user-visible outcome by hand.
- **Schema-/reader-changing waves** additionally run the COMBINED integration suite
  against the refreshed snapshot before merge (`§Verify Recipe`) — per-slice-
  isolated runs miss cross-slice seed/reader breaks.
- **ONE dev server / one shared dev DB only.** ⚠ A second backend against a shared
  dev DB can reaper-kill a live job (`§Verify Recipe` names the project's gotcha).
  Stop the first dev server before starting another worktree's, or verify in the
  same worktree.
- **Headless login into the session-MCP profile** (AFK, no password in the
  transcript). First navigate the MCP browser to the app root: no `/login`
  redirect = already authenticated → skip the login (an authed profile makes a
  login script time out on the e-mail field — looks like a selector bug, is not).
  Otherwise: full recipe, profile-resolution lore + script = `§Headless Login`.
- **Per surface**: browser snapshot + screenshot; assert each slice's AC visibly
  gone/fixed + no regression. Run the project's design/brand checks (tokens, no
  hardcoded values, formatters, chart-axis rules — `§Verify Recipe`) +
  cross-surface consistency.
- **Standardisation wave → CROSS-CONSUMER uniformity assert, NOT just per-slice
  ACs.** If the wave unifies a shared pattern across ≥2 consumers, per-slice-green
  is NOT enough — measure the standardised property on ALL N consumers and assert
  they are EQUAL (e.g. `table.left - card.left` identical across every table;
  export column-set identical), not just "present on each". Divergence only shows
  in the cross-consumer diff. The shared component must OWN the standardised
  property; this verify proves it actually does.
- **DB-compare** the outcome value against the SQL source of truth. Watch
  type-coercion traps your project layer flags (`§Verify Recipe`) — e.g. a `date`
  column that shifts a day through a naive ISO round-trip.
- **Console-clean** where required: read the browser console at warning level → 0
  errors / 0 warnings.
- **Gap the agents missed?** 1-file mechanical → fix inline; else **freshly
  re-dispatch** a new agent into the existing slice worktree/branch with the prior
  findings embedded — a continuation is NOT available in the parallel-wave flow;
  stopped/background agents are re-dispatched, not resumed.

**Done when — count it, don't remember it:** own central gate green (+ combined
integration where schema/reader) · **N/N slice ACs** visually asserted with
screenshot · cross-consumer equality measured (standardisation wave) · brand/design
checks pass · console 0/0 · DB outcome value compared.

## Phase 5 — Land

- **One PR** for the whole wave (one merge for the user) OR per-slice — your call;
  one PR with per-slice commits is usually kindest AFK.
- **Schema-/migration waves: land as ONE combined PR — NOT incremental
  auto-merge.** If merges to the main branch auto-deploy, per-slice merges race a
  manually-gated prod migration → prod errors ×N slices. One combined PR = ONE
  deploy = ONE prod-migration lockstep window. Incremental merge only for
  byte-neutral waves (no new schema the deployed code reads). Project specifics
  (deploy trigger, migration command, done-signal) = `§Landing`.
- **`Closes #N` needs the keyword before EACH issue, one per line** — `Closes #a,
  #b` only closes the first. Anchor → `Part of #<anchor>`, never `closes`
  (premature close).
- **Anchor tracker: `python3 scripts/board-sync.py anchor-sync <anchor#>`** — first
  `--dry-run`, review the diff, then write; gate symbol + stable cells of freshly
  appended rows by hand. Mandatory at EVERY slice event: PR-create AND merge.
- **Stacked follow-up PRs** that build on the unmerged wave: base on the **wave
  branch** (not main) — the platform auto-retargets them when the wave PR merges.
  Note the merge order in the body.
- New issues via `scripts/board-sync.py` (never bare `gh issue create`); write
  multi-paragraph PR/issue bodies via `--body-file` (an inline body with backticks
  can crash the shell).

**Done when:** PR(s) open with correct `Closes`/`Part of` lines · anchor-sync
written · merge order documented.

## Phase 6 — Cleanup + close

- Stop the dev server(s) you started, by port (`lsof -ti:<port> | xargs kill` —
  your own processes, targeted by the worktree's assigned ports, never blind).
  Remove temp verify scripts (a login helper, DB-check scripts).
- **Before removing any slice worktree, read its `ANNAHMEN.md`** (an assumptions
  log, gitignored at worktree-root) and propagate each build-time assumption marker
  to the sibling issue it carries. A hand-driven multi-PR / migration landing does
  NOT run `wrapup`'s assumption-propagation step — this is the only place it
  happens; `worktree remove` deletes the log.
- **Post-merge:** run `anchor-sync` again; verify every leaf issue actually closed
  (the same checks `wrapup` runs, by hand when landing outside `wrapup`). The
  anchor closes manually — a parent is not auto-closed on sub-issue completion.
- A skill edited during the wave → run `codex-adapter-sync` (lives in
  `.agents/skills/`) in the SAME PR — the mirror-presence-parity lint is a
  pre-PR gate and blocks a dual-surface skill PR without its mirror.
- Leave slice worktrees for the user to inspect, or note they're
  post-merge-removable.

**Done when:** no orphan process · ANNAHMEN propagated · anchor reconciled + leaf
closes verified · final report lists landed/pulled slices as **X of Y**.
