---
name: orchestrate-wave
"description": "Use when the user hands you a whole WAVE / cluster of pre-planned, file-disjoint slices and wants you to ORCHESTRATE building, verifying AND landing it end-to-end — often AFK / \"ultracode\". Triggers: \"orchestriere Welle #N\" (or any wording that delegates wave-landing responsibility to you), \"ultracode diese Welle / diesen Cluster\", or a wave-anchor issue (a cluster/umbrella issue with file-disjoint sub-issues whose specs are already locked) handed over to land. NOT for a single slice (just `implement` it), NOT for finding/clustering a wave (that's `board-to-waves`), NOT for planning specs (that's `grill-with-docs`/`to-issues`)."
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
  - **On ANY wave STOP/abort:** if this run planted the active-wave claim, remove
    exactly that claim as part of shutdown. Never delete a claim marker observed
    during a preflight collision, nor any sibling/foreign wave marker — those are
    owned by another run. A stale marker owned by this run would block a safe retry.
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
3. **Preflight — refuse a wave already in flight, otherwise claim it.** Before
   dispatch, inspect all three same-machine collision signals: **(a)** an existing
   `wave-active/<anchor>` tag; **(b)** any slice branch ahead of the wave's current
   base (`git rev-list --count <base>..<slice-branch>` > 0); **(c)** uncommitted
   changes in any slice worktree (`git -C <worktree> status --porcelain` non-empty).
   A hit not created by this run means another session may be building the wave:
   **STOP**, report the exact tag/branch/worktree, and do not touch it. If clean,
   record that this run owns the claim and plant a LOCAL annotated tag:
   `git tag -a wave-active/<anchor> -m "orchestrating since <UTC timestamp>;
   slices: <slice-branches>"`. It is local coordination state — never push it.
4. **Wave worktree**: reuse the planning worktree (never re-create; the handoff
   points there). Bring its branch to current `main`:
   `git -C <wave> merge --ff-only origin/main` (if your repo guards destructive
   git, ff-merge is the safe path — not `reset --hard`). Install dependencies with
   your package manager after (the lockfile may have moved). A gitignored plan doc
   survives the merge.
5. **Run project setup steps (`§Setup`)** the later verify needs — e.g. a DB
   tunnel or service the live-verify depends on. Absent layer → start whatever your
   live-verify environment requires before Phase 4.

**Done when:** anchor + every sub-issue + plan read · project layer probed
(filled → project recipe; stub/absent → generic + one-time warning) · preflight
clean + this run's local claim planted · wave branch ff'd to `origin/main` + deps
installed · project setup steps running.

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
- **Native blocking edges are the frontier authority.** Read the anchor's
  buildable frontier from the tracker's native issue dependencies:
  `python3 scripts/board-sync.py frontier <anchor#>` → `FREI` / `BLOCKED by #…` /
  `done` per sub-issue. A body `## Blocked by` section is only the machine-written
  MIRROR of those edges (on conflict the API wins) — never derive build order from
  body text or table order alone. The frontier must AGREE with your Phase-1
  dependency order; a contradiction is a plan finding to reconcile before dispatch,
  not a detail.
- **Reconcile contradictory sub-issue ACs against the plan BEFORE dispatch — the
  plan is authority.** `to-issues` cuts slices independently, so a shared
  append-only file (a query-key registry, a barrel, a shared types module) is often
  claimed by *every* slice, with duplicate/clashing adds. **The hub slice OWNS the
  shared-mutable file: it pre-adds ALL the wave's keys/types/helpers; dependents
  CONSUME only and never touch it.** Embed verbatim in each dependent's contract:
  "X already exists in `<file>` — do NOT add it, consume only." (Real case: all 14
  sub-issues claimed the same registry adds + 4 contradictions — hub expanded to
  own all 20 keys, batch merged conflict-free.)
- **Retirement slices require a valid topological deletion order.** Before
  dispatching slices that delete a legacy cluster, map every to-delete module's
  production importers and build the cluster's internal import graph. Order the
  deletions so no pending slice imports a module already removed; zero remaining
  production importers is the behavior-neutral proof. If mutually dependent
  deletions form a cycle, separate each-slice-green steps are impossible: combine
  the whole cycle into ONE atomic slice instead of landing dangling imports.

**Done when:** FILE→SLICES table exists · every ≥2-slice file has exactly ONE
owning slice · disjoint waves cut in dependency order · every dependent contract
carries its verbatim consume-only lines.

## Phase 2 — Dispatch one wave in parallel (isolated worktree per implementer)

Phase 2+3 repeat **per disjoint wave** from Phase 1 — the conflict-hub wave first.
Within ONE wave, all slices dispatch at once. **Dispatch only `FREI` slices** —
re-read the native frontier (`frontier <anchor#>`) before each wave; a
gate-before-build edge clears only when its blocker actually lands (never
"unblock" by editing body text — remove the edge via `dep-remove` if the plan
genuinely changed). Two per-slice calls first: **(a)
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
- **Anchor tracker sync is mandatory at EVERY slice event (PR-create AND merge).**
  Use the project-layer command from `§Landing`: dry-run first, review the diff,
  then write; preserve gate symbols and stable cells of freshly appended rows.
  Absent a filled layer, use the tracker's native parent/table reconciliation.
- **Stacked follow-up PRs** that build on the unmerged wave: base on the **wave
  branch** (not main) and note the merge order in every PR body. **Do NOT rely on
  auto-retarget:** deleting the merged base branch can close its stacked child.
  Either merge the child before deleting the base, or expect the close and open a
  FRESH PR from the child's still-existing head branch against the final base.
  Keep any deploy/release/manual gate in the documented merge order.
- New issues go through the project-layer board command (`§Landing`; never a bare
  tracker-create call that skips the board). Write multi-paragraph bodies through
  a body file so shell metacharacters cannot alter them.

**Done when:** PR(s) open with correct `Closes`/`Part of` lines · anchor-sync
written · merge order documented.

## Phase 6 — Cleanup + close

- Stop the dev server(s) you started, by port (`lsof -ti:<port> | xargs kill` —
  your own processes, targeted by the worktree's assigned ports, never blind).
  Remove temp verify scripts (a login helper, DB-check scripts).
- **Remove only this run's claim marker.** If this run planted
  `wave-active/<anchor>`, delete that exact local tag after success or abort. Never
  delete a claim marker observed during a preflight collision or any other
  `wave-active/*` marker; ownership, not a broad pattern, authorizes cleanup.
- **Before removing any slice worktree, read its `ANNAHMEN.md`** (an assumptions
  log, gitignored at worktree-root) and propagate each build-time assumption marker
  to the sibling issue it carries. A hand-driven multi-PR / migration landing does
  NOT run `wrapup`'s assumption-propagation step — this is the only place it
  happens; `worktree remove` deletes the log.
- **Post-merge completion sync:** use `§Landing` to reconcile the anchor again and
  verify every leaf actually closed. Then read the anchor's `Closing Conditions`,
  `Done when`, and acceptance criteria and make an explicit closure decision:
  - **No open manual gate:** close the anchor, set its project completion status to
    the configured done role, and re-read the board item to verify both states.
    Closing the tracker issue alone is not proof that its workflow field changed.
  - **Open manual gate:** ask the user in the main thread, naming the exact gate and
    condition. Confirmation follows the close/status/verify path above; otherwise
    leave the anchor open and add exactly one completion marker explaining the
    remaining gate and close condition.
- **Program propagation:** resolve the anchor's native parent with the
  project-layer command from `§Landing`. If the parent is a Program-PRD, run the
  project-layer program sync after the anchor decision. On closure, set the
  anchor's completion status first so the program can observe the completed wave;
  run program sync again after close even if landing ran it earlier. If a manual
  gate remains open, propagation may refresh the program but must not claim wave
  completion. Absent a filled layer, use equivalent tracker-native parent lookup,
  completion-field update, re-read, and program propagation commands.
- A skill edited during the wave → sync its dual-surface mirror in the SAME PR
  using the tool named by `§Landing` when present; mirror parity remains a pre-PR
  gate.
- Leave slice worktrees for the user to inspect, or note they're
  post-merge-removable.

**Done when:** no orphan process · this run's claim removed · ANNAHMEN propagated ·
anchor reconciled + leaf closes verified · anchor closure decided and documented ·
Program-PRD propagation completed or explicitly skipped · final report lists
landed/pulled slices as **X of Y**.
