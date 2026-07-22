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

## Readiness preflight — first

<!-- readiness:optional-preflight:start -->
Before reading from the issue tracker, claiming a wave, creating worktrees, or
making any local or remote mutation, run this once from the project root:

```bash
node scripts/readiness.mjs check --skill orchestrate-wave --json
```

- `ready`: continue silently with the required tracker/board context and the
  active `projectRecipe` block.
- `degraded`: required tracker and managed-board evidence is ready, so keep the
  complete generic orchestration fallback active, omit only `projectRecipe`,
  and emit exactly one concise summary: `Readiness degraded — inactive block
  projectRecipe (orchestrateWaveRecipe: <state>); using the generic
  orchestration fallback. Run /setup-workflow, configure
  docs/agents/skills/orchestrate-wave.md, then rerun this skill.`
- `blocked`: `STOP` before tracker access, dispatch, claims, worktrees, or other
  mutation. Report `issueTracker=<state>` and `managedBoard=<state>`, then give
  exactly one recovery path: **Run `/setup-workflow`, then rerun
  `/orchestrate-wave`.** Never fall back to bare tracker or board commands.
- `managedBoard=not-applicable`: `STOP` and report that `/orchestrate-wave` is
  inapplicable without a managed board. This is a terminal project decision,
  not invalid evidence and not a partially active mode.
- Invalid evidence is always visible and never treated as an opt-out.
<!-- readiness:optional-preflight:end -->

<!-- readiness:block projectRecipe -->
> **Phase 0 consumes the active project recipe.** Concrete tooling — exact test/verify
> commands, a DB/tunnel setup, a headless login recipe, brand checks, deploy
> lockstep — is project-specific and lives in a **project layer** this skill reads
> at runtime, not in this skeleton. The skeleton names the layer's sections
> (`§Setup`, `§Builder Commands`, `§Builder Hard Rules`, `§Integration Suites`,
> `§Verify Recipe`, `§Headless Login`, `§Landing`) and falls back to generic
> instructions when the layer is absent. See **Phase 0**.
>
> When `projectRecipe` is active, read the filled project layer before applying
> any phase-specific command below.
<!-- readiness:end -->

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
  - **On ANY wave STOP/abort:** if this run planted the active-wave claim, release
    it via `releaseWaveClaim` with this run's owner as part of shutdown — it
    refuses a foreign payload. Never delete a claim marker observed during a
    preflight collision. A stale own marker would block a safe retry.
- **Routing = one axis: how expensive is a wrong result to catch?** Mechanically
  caught (test/screenshot/lint) → default tier at medium/low effort; plausible-but-
  wrong / subtle logic / architecture → top tier at high effort + main-thread
  re-verify; review/verify verdicts never below high. Concrete tier→model mapping
  lives in your dispatch/model doctrine, if present — no model names here.
  Escalate a repeatedly-failing slice one tier/effort up on the 2-strikes rule (2×
  same problem despite concrete feedback, or structurally wrong approach — NOT the
  first red test). The same axis sets how hard you re-verify. Borderline → default
  tier + re-verify beats blanket top tier.

## Orchestration mechanics

Pass only host-supplied inventory through `capabilityAdapter.claude` or `.codex`,
then call the selector. It returns exactly one target; missing or `unknown` evidence
degrades A → B → C. A model claim is not evidence; do not emulate a missing primitive.

- **Path A:** requires the literal `Workflow` tool, callable and permitted, plus
  individually proven named phases, run identity, runtime output validation,
  journal, and resume. Then read [its recipe](references/dispatch-workflow.md).
- **Path B:** requires proven native spawn, wait, and aggregate plus effective
  concurrency and thread capacity ≥2. Then read [its recipe](references/dispatch-subagents.md).
- **Path C:** keep recon and building direct and serial in the main thread. Produce
  the same FILE → SLICES evidence, create each worktree from the integrated base,
  apply the builder contract, validate the result, then continue. Load no reference.

Phases 0 and 3–6 always remain in the main thread. Visible fan-out progress may
replace the ~30-second heartbeat; otherwise the standing heartbeat remains required.

## Phase 0 — Setup

1. **Read everything**: the anchor body, every sub-issue body (each has a Handoff
   block: scope, blast-radius, live-verify, PR line), and the locked plan /
   plan-review doc in the planning worktree (file-exact).
2. **Select exact commands or the generic fallback.** If the readiness result
   activated `projectRecipe`, use the loaded filled recipe wherever a phase below
   points at a `§`-section. Otherwise use each phase's generic fallback; the
   preflight's single degraded summary is the only warning. Never guess a project
   command, tunnel, login, or verify recipe.
3. **Preflight — refuse a wave already in flight, otherwise claim it.** Before
   dispatch, inspect the two same-machine work signals: **(a)** any slice branch
   ahead of the wave's current base (`git rev-list --count <base>..<slice-branch>`
   > 0); **(b)** uncommitted changes in any slice worktree (`git -C <worktree>
   status --porcelain` non-empty). Acquire the claim itself through `claimWave`
   from `src/lib/waveClaim.mjs`: a compare-and-set on the `wave-active/<anchor>`
   LOCAL annotated tag, so two sessions racing one wave cannot both win. Either
   `acquired: false` or a work signal you did not create means another session
   owns the wave — **STOP**, report the returned `claim.owner` plus the exact
   branch/worktree, touch nothing. Local coordination state — never push the tag.
4. **Wave worktree**: reuse the planning worktree (never re-create; the handoff
   points there). Bring its branch to current `main`:
   `git -C <wave> merge --ff-only origin/main` (if your repo guards destructive
   git, ff-merge is the safe path — not `reset --hard`). Install dependencies with
   your package manager after (the lockfile may have moved). A gitignored plan doc
   survives the merge.
5. **Run project setup steps (`§Setup`)** the later verify needs — e.g. a DB
   tunnel or service the live-verify depends on. Absent layer → start whatever your
   live-verify environment requires before Phase 4.

**Done when:** anchor + every sub-issue + plan read · readiness result consumed
(active `projectRecipe` → exact recipe; inactive → generic fallback) · collision
preflight clean + this run's local claim planted · wave branch ff'd to
`origin/main` + deps installed · project setup steps running.

## Phase 1 — Disjointness recon (the load-bearing step)

Phase 1 uses the selected orchestration mechanics. Resolve every named component,
produce the **FILE → SLICES** table and overlap graph, then build the conflict hub
before its dependents. Cut fully file-disjoint waves; shared imports are safe, but
files edited by multiple slices serialize across waves.
- **Native blocking edges are the frontier authority.** Read the anchor's
  buildable frontier from the tracker's native issue dependencies:
  `python3 scripts/board-sync.py frontier <anchor#>` → `FREI` / `BLOCKED by #…` /
  `done` per sub-issue. A body `## Blocked by` section is only the machine-written
  MIRROR of those edges (on conflict the API wins) — never derive build order from
  body text or table order alone. The frontier must AGREE with your Phase-1
  dependency order; a contradiction is a plan finding to reconcile before dispatch,
  not a detail.
- **Reconcile contradictory sub-issue ACs against the plan BEFORE dispatch.** Safe
  declaration-only registries may be predeclared by one hub; eager/validated
  registries that read targets must serialize helper-owning slices through
  dependency edges, each appending only its own existing artifact after creation.
  Both preserve one owner per shared edit and the no-conflict invariant.
- **Retirement slices require a valid topological deletion order.** Before
  dispatching slices that delete a legacy cluster, map every to-delete module's
  production importers and build the cluster's internal import graph. Order the
  deletions so no pending slice imports a module already removed; zero remaining
  production importers is the behavior-neutral proof. If mutually dependent
  deletions form a cycle, separate each-slice-green steps are impossible: combine
  the whole cycle into ONE atomic slice instead of landing dangling imports.

**Done when:** FILE→SLICES table exists · each shared file has either one
declaration-only owner with verbatim consume-only dependents, or an explicit serialized
owner sequence for eager/validated additions where each owner appends only its own existing artifact · disjoint waves cut in dependency order.

## Phase 2 — Dispatch one wave in parallel (isolated worktree per implementer)

Phase 2 uses the selected orchestration mechanics, repeating with Phase 3 per
disjoint wave, conflict hub first. Dispatch only `FREI` slices: re-read
`frontier <anchor#>` before each wave and clear changed edges only via `dep-remove`.
Before each slice, bind **(a) inline vs delegate** and **(b) tier + effort** under
Standing rules. Tiny mechanical work may stay inline.
For Path A/B, create one worktree per agent from wave HEAD, using `§Setup` or
`git worktree add <path> -b feat/<anchor>-<slug>`.
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

In the wave worktree, `git merge --no-ff <slice-branch>` per slice. After EACH wave:

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
  `wave-active/<anchor>`, call `releaseWaveClaim` with this run's owner after
  success or abort; its owner check, not a broad `wave-active/*` pattern,
  authorizes cleanup, and a foreign marker is left untouched.
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
