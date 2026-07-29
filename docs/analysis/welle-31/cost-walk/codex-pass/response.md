I’m using the repository’s `implement` playbook because the locked handoff names it explicitly. I’ll apply only its read-only analysis portions: no edits, no GitHub access, no journey re-derivation, and no subagent delegation. I’ll first lock the substrate identity and the classification basis, then count all 70 rows and deepen only the mandated priority journeys.

The working tree contains an untracked `docs/analysis/welle-31/cost-walk/` directory, so I’m treating it as the other pass and will not open or enumerate it. The committed census/evidence inputs are clean; HEAD is the merge that froze them, while the named substrate SHA is their source identity. I’m checking that relationship before using any counts.

The mechanical census is now complete: 70/70 journeys map to 237/237 station rows. The corpus has 62 gate stations (52 human, 10 platform) and 108 non-`none` user-decision stations. The important limitation is already visible: the frozen aggregate queries contain no `journey_id`, so they cannot measure per-journey traversal frequency except for the explicitly retro-shaped PR query; I will classify that gap as `unknown`, not infer usage from issue existence.

# Independent second-primary cost walk

## Per-pass note

- **Model:** GPT-5 Codex
- **Reasoning effort:** deep
- **Pass time:** 2026-07-29T07:57:37Z
- **Substrate commit:** `c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2`
- **Corpus verification:** all six named JSON exports carry that `sourceCommit`; `node docs/analysis/welle-31/derive-census.mjs` returned 70 journeys, 237 stations, `PROBLEMS: none`; `derive-stations.mjs --check` reproduced byte-equal.
- **Filesystem:** no writes. I deliberately did not open or enumerate the untracked `docs/analysis/welle-31/cost-walk/` directory because it may contain the other primary pass.

### Named non-coverage

- I did not re-derive the 70 journeys or seven entry points.
- I did not use live GitHub, web data, `.env*`, credentials, or local overrides.
- I did not review another model’s findings.
- I did not re-plan #320; `session-ends` and teardown use it only as standing evidence.
- I did not run ablations, time real sessions, count tokens, or observe users.
- I did not perform #380’s truth/mechanism audit.
- I did not persist an output artifact. This response is the artifact because the mandate explicitly requires read-only, no file writes.
- Mechanical rows cover **70 of 70 journeys**. The two judgment questions cover **12 of 70**: all ten seed-bearing journeys plus `consumer-first-init` and `consumer-first-own-workflow`. The remaining **58 of 70** receive mechanical pricing and classification only.
- Traversal frequency is unavailable for 69 journeys. I do not substitute issue existence, entry-point applicability, or station count for actual traversal.

## AC 1 — classification basis declared before classification

- **Primary traversal query:** export `process-issue-population`, the recorded command beginning `gh issue list … --state all …`; **266 rows**, fetched `2026-07-29T07:09:30.009Z`, event window `2026-07-03T07:51:59Z`–`2026-07-28T21:29:55Z`.
- **Direct retro proxy:** export `merged-pr-retro-marker`; **135 merged PR rows**, window `2026-06-11T07:54:34Z`–`2026-07-28T21:43:08Z`.
- **Recovery query:** export `recovery-record-sources`; **64 rows**, fetched `2026-07-29T07:09:30.818Z`.
- **High-traversal threshold:** at least **10 directly journey-attributable traversals** inside the frozen window.
- **Gate basis:** station `authorizationBoundary` equal to `human-gate` or `platform-gate`.
- **Human-interaction proxy:** station `userDecision` not beginning with `none`. This is an upper bound, not observed prompt telemetry.
- **Classifications:** `covered-and-priced` 0; `unwatched` 0; `secured-out-of-proportion` 1; `unknown` 69.
- **Output path:** none; inline response only under the read-only mandate.

The decisive limitation is mechanical: **0 of 266 issue rows, 0 of 135 PR rows, and 0 of 64 recovery rows carry a journey id**. Only the retro query is semantically narrow enough to attribute directly.

## Findings

### 1. The planning-output journey reverses its cited evidence

**Journey:** `land-planning-output`

The substrate prices it as **3 stations, 0 gates, 1 interaction**, and states both:

- “Landing an ADR must not require a release”; and
- terminal: “Content-route PR merged; no version bump required.”

That is contradicted by its own citation and repository convention:

- #343 says the observed failure is that any shipped-path change, explicitly including `docs/adr/*`, requires a release.
- `docs/agents/skills/orchestrate-wave.md` says anything in the manifest, explicitly including `docs/adr/*` and `docs/research/*`, drags release preparation and publication along.

Thus **1 of 3 stations and the journey terminal invert present behavior into a desired future behavior**. The schema check only proves that citation `#343` resolves; it does not prove that the cited body entails the promise.

This is failure mode **#343** and makes the 3-step price incorrect.

### 2. Traversal frequency is not measurable from the purported traversal dataset

**Applies to:** 69 of 70 journeys.

Count from `aggregate-queries.json`:

- `process-issue-population`: **0 of 266** rows have `journey_id`/`journeyId`.
- `merged-pr-retro-marker`: **0 of 135** rows have one.
- `recovery-record-sources`: **0 of 64** rows have one.

The substrate can prove derivation provenance and entry-point applicability. It cannot prove how often a particular journey was walked. Therefore frequency-based claims such as “secured out of proportion to how often walked” are `unknown` for 69 journeys.

This disagrees with the substrate README’s framing of issue history as an empirical record of journeys “actually taken.” It is an empirical population, but not a journey-attributed traversal record.

### 3. Station rows do not compose, so end-to-end prices are ambiguous

**Journeys:** `small-direct-path`, `run-the-local-gate`, `slice-pr-landing`, `session-ends`, `small-bug-fix-to-merged-and-released`, `release-the-kit`.

`small-direct-path` is priced at **3 stations, 2 gates, 2 interactions**. Yet the conventions make local CI, PR landing, and session closure applicable:

- `run-the-local-gate`: 5 stations
- `slice-pr-landing`: 5
- `session-ends`: 4

A naïve sum gives **17 stations, 4 gates, 5 interactions**. But that double-counts “land” and possibly teardown because the substrate has no composition or overlap edges.

The same problem appears in the small-bug seed:

- `small-bug-fix-to-merged-and-released`: 5 stations
- `release-the-kit`: 6 stations

The real price is neither safely “5” nor safely “11.” The corpus can price local journey fragments, but not an implemented end-to-end chain. Failure modes relevant to these nested paths are **#205, #243, #257, #320, #343**.

### 4. The deep Program-planning route has at least seven human gates before optional hardening

**Journeys:** `domain-grill-and-context-update`, `prd-maturation`, `plan-to-executable-slices`, `program-graph-decomposition`.

Mechanical sum:

- **14 station rows**
- **7 gate stations**
- **8 human-interaction proxies**

Adding `cross-model-plan-hardening` raises it to:

- **17 stations**
- **9 gates**
- **10 interactions**

This still omits the S/B/C/P observation machine, body normalization, archive comments, repeated body rewrites, global-number renumbering, and the five-round review specimen because those costs were not stationized.

The individual gates are defensible; the aggregate is expensive. Observed failures include the uninvocable internal engine **#322**, early anchor closure **#341**, and the planning ceremony reported in **#343**.

### 5. Outcome-entry is asserted but not priced

**Journeys:** `goal-level-delegation-afk-sweep`, `small-direct-path`.

`goal-level-delegation-afk-sweep` has **5 stations**, but **0 of 5 verifies the transition from a user-stated outcome to the selected skill/route**. Its first station already assumes that the agent has selected a wave and is acquiring its claim.

Conversely, `small-direct-path` makes “chooses the direct path” a human gate: **1 of its 3 stations** requires the human to choose workflow depth.

The substrate therefore does not answer seed 7’s central question—whether the kit supports outcome-entry without the human choosing the skill. It prices post-routing execution. Failure/cost issue: **#343**.

### 6. The consumer’s first own workflow is not covered end-to-end

**Journeys:** `consumer-first-init`, `consumer-setup-workflow-project-layer`, `consumer-first-own-workflow`.

The composite first-run surface contains **11 stations, 0 formal gates, 6 interaction proxies**.

But `consumer-first-own-workflow` itself has:

- **4 of 4 documented** stations
- **0 of 4 mechanical**
- **0 build or verify stations**
- **1 of 4 stations** merely saying the substrate now includes the previously omitted journey

That meta-observation is not a step the consumer walks. The remaining stations cover choosing an entry, choosing depth, and landing, but not building or verification. Classification remains `unknown`, rather than `unwatched`, because traversal frequency is absent. The substantive gap is still real. Failure/cost issue: **#343**.

### 7. Retro is the one defensible `secured-out-of-proportion` classification

**Journey:** `retro-after-a-session`.

Cost: **3 stations, 2 human gates, 2 interactions**.

Frozen PR evidence:

- **135 of 135** PRs examined
- valid closed-set marker: **64 of 135** (`ran` 12, `skipped` 52)
- malformed/other marker: **10 of 135**
- no marker: **61 of 135**
- findings heading: **14 of 135**
- of the 12 `ran` rows, **9 of 12** carry a findings heading
- **4 of 14** findings-heading PRs have no retro marker

Twelve direct `ran` observations exceed the declared high-traversal threshold. Requiring an offer plus per-patch approvals, together with a machine-oriented closed-set marker on far more PRs than expose findings, is disproportionate as presently bound.

This is a hypothesis about binding, not about the value of reflection. Issues **#343** and **#380** frame the failure.

### 8. Release is long but already has one human gate, not repeated human ceremony

**Journeys:** `release-the-kit`, `tag-triggered-publish`, `recovery-red-release-run-but-published`, `recovery-awaiting-tag-stacked-bump`.

`release-the-kit` has **6 stations**:

- 3 mechanical
- 2 platform-enforced
- 1 documented
- **1 human gate**

Its non-human layers correspond to concrete failures:

- red run after successful publish: **#205**
- stacked bump over an untagged version: **#243**
- redundant second publication gate removed: **#257**

The cost finding is therefore not “too many human approvals.” It is that a release remains six stations and that other journeys silently include or omit those stations. The current one-Semver gate is a plausible keep hypothesis.

### 9. Dual-surface cost is maintenance breadth, not interaction ceremony

**Journey:** `sync-the-codex-mirror`.

The inventory reports:

- **44 logical skills**
- **36 of 44** mirrored across both surfaces
- **219 shipped skill files**
- `sync-the-codex-mirror`: **3 stations, 0 gates, 0 interactions**

This is real authoring and review breadth, but the station model prices it cheaply because generation and tests are mechanical. The useful cut question is placement and generation, not deletion of Codex parity.

This also disagrees with the original mandate’s remembered “43 skills”; the frozen denominator is **44**.

### 10. Hook cost is invisible to the gate metric

**Journeys:** `session-start-context-injection`, `guarded-tool-call-block`, `prompt-and-stop-time-advisory`.

Together:

- **10 stations**
- **9 mechanical**
- **0 formal gates**
- **0 interaction proxies**
- inventory: **24 hooks**

Automatic advisory/context cost—prompt distraction, false attribution, narrowed reasoning—does not appear as a human gate. Without invocation counts or observed false-positive counts, proportionality is `unknown`. Station counts alone cannot decide whether the hooks earn their always-on placement.

### 11. Recovery is expensive and selectively observed

**Journeys:** all nine `recovery-*` journeys.

Together:

- **28 stations**
- **9 gates**
- **14 interaction proxies**
- **17 mechanical / 11 documented**
- **34 of 70** ordinary journeys still carry `unknown-recovery`

Named failures include **#205, #243, #341, #2305** and the false-red specimen in **#343/#380**. The 64-row recovery search produced nine derived recovery journeys, but contains no journey-attributed traversal counts. The recovery surface is therefore priced structurally, not by occurrence.

## Mechanical cost and classification — 70 of 70

Legend:

- `St` = station/step rows.
- `G` = human- or platform-gate rows.
- `I` = non-`none` user-decision stations, an interaction upper bound.
- `M/D/P/J` = mechanical/documented/platform-enforced/judgment.
- `S/S` = distinct skill or `scripts/` promise citations.
- `U` = `unknown`: no attributable traversal frequency.
- `SOP` = `secured-out-of-proportion`.

Counts come from grouping `stations.json` by `journeyId`; denominator and hardness totals were checked with `derive-census.mjs` and `derive-stations.mjs --check`.

| Journey id | St | G | I | M/D/P/J | S/S touched | Failure issue | Class |
|---|---:|---:|---:|---|---|---|---|
| `idea-to-board-issue` | 3 | 0 | 2 | 1/2/0/0 | `board-sync.py` | — | U |
| `inbound-triage-to-agent-ready` | 3 | 0 | 2 | 1/2/0/0 | `triage`, `execute-ready-check.py` | — | U |
| `backlog-to-waves-clustering` | 3 | 2 | 2 | 0/2/0/1 | `board-to-waves` | — | U |
| `prd-maturation` | 3 | 1 | 1 | 1/2/0/0 | `to-prd`, `spec-self-critique` | — | U |
| `plan-to-executable-slices` | 4 | 2 | 2 | 2/2/0/0 | `to-issues`, `board-sync.py` | #341 | U |
| `program-graph-decomposition` | 4 | 2 | 2 | 3/1/0/0 | three program-graph scripts | #322 | U |
| `cross-model-plan-hardening` | 3 | 2 | 2 | 1/2/0/0 | `codex-review`, `grill-with-docs-codex`, `codex-exec.sh` | — | U |
| `domain-grill-and-context-update` | 3 | 2 | 3 | 0/2/0/1 | `grill-with-docs` | — | U |
| `spec-self-critique-before-review` | 3 | 0 | 1 | 0/3/0/0 | `spec-self-critique` | — | U |
| `scale-check-route-a-new-build` | 3 | 2 | 3 | 0/2/0/1 | `scale-check` | — | U |
| `router-recommends-a-starting-point` | 3 | 2 | 3 | 0/3/0/0 | `ask-matt` | — | U |
| `wayfinder-chart-a-foggy-effort` | 3 | 3 | 3 | 1/2/0/0 | `wayfinder`, `board-sync.py` | — | U |
| `verify-a-fact-before-plan-lock` | 4 | 2 | 2 | 0/4/0/0 | `verify-spike` | — | U |
| `resolve-a-bounded-tradeoff` | 3 | 2 | 2 | 0/3/0/0 | `decision-gate` | — | U |
| `research-a-question` | 3 | 1 | 2 | 0/2/0/1 | `research`, `wrapup` | — | U |
| `land-planning-output` | 3 | 0 | 1 | 2/1/0/0 | `wrapup`, `pr-body-check.py` | #343 | U |
| `small-direct-path` | 3 | 2 | 2 | 1/2/0/0 | `wrapup` | #343 | U |
| `small-bug-fix-to-merged-and-released` | 5 | 1 | 3 | 2/1/2/0 | `diagnose`, `tdd`, `local-ci` | #205, #243, #257 | U |
| `tdd-red-green-refactor` | 3 | 0 | 0 | 3/0/0/0 | `tdd` | — | U |
| `bug-diagnosis-to-regression-test` | 4 | 1 | 2 | 1/2/0/1 | `diagnose`, `tdd` | — | U |
| `prototype-a-design` | 3 | 2 | 3 | 0/2/0/1 | `prototype` | — | U |
| `delegate-build-to-codex` | 4 | 2 | 2 | 1/3/0/0 | `codex-build`, `codex-exec.sh` | — | U |
| `two-axis-code-review` | 4 | 1 | 1 | 1/2/0/1 | `code-review` | — | U |
| `design-a-deep-module` | 3 | 1 | 2 | 0/2/0/1 | `codebase-design` | — | U |
| `improve-codebase-architecture` | 3 | 1 | 2 | 1/2/0/0 | `improve-codebase-architecture` | — | U |
| `security-audit-of-the-app` | 3 | 1 | 1 | 1/1/0/1 | `security-audit`, `audit-gate.mjs` | — | U |
| `run-the-local-gate` | 5 | 0 | 1 | 4/1/0/0 | `local-ci`, `check-kit-staleness.mjs` | — | U |
| `slice-pr-landing` | 5 | 1 | 1 | 3/2/0/0 | `pr-body-check.py`, `wrapup-land.py`, cleanup | — | U |
| `anchor-reconcile-on-slice-event` | 3 | 0 | 1 | 2/1/0/0 | anchor/render scripts | #341 | U |
| `goal-level-delegation-afk-sweep` | 5 | 1 | 2 | 2/3/0/0 | `orchestrate-wave` | #343 | U |
| `session-ends` | 4 | 1 | 1 | 2/2/0/0 | `wrapup` | #320 | U |
| `retro-after-a-session` | 3 | 2 | 2 | 1/1/0/1 | `retro` | #343, #380 | SOP |
| `resolve-a-merge-conflict` | 3 | 1 | 1 | 2/0/0/1 | `resolving-merge-conflicts` | — | U |
| `author-or-improve-a-skill` | 4 | 0 | 0 | 4/0/0/0 | three skill-lint scripts | — | U |
| `audit-the-skill-surface` | 3 | 0 | 1 | 2/1/0/0 | `audit-skills`, skill manifest | — | U |
| `sync-the-codex-mirror` | 3 | 0 | 0 | 2/1/0/0 | `codex-adapter-sync`, two tests | — | U |
| `kit-build-and-staleness-check` | 3 | 0 | 0 | 2/1/0/0 | build/staleness scripts | — | U |
| `release-the-kit` | 6 | 1 | 2 | 3/1/2/0 | release prepare/guard scripts | #205, #243, #257 | U |
| `ci-required-check-on-a-pull-request` | 3 | 3 | 2 | 0/0/3/0 | — | — | U |
| `tag-triggered-publish` | 4 | 4 | 1 | 1/0/3/0 | `release-state.mjs` | #257 | U |
| `pages-site-publish` | 3 | 3 | 0 | 0/0/3/0 | — | — | U |
| `consumer-first-init` | 4 | 0 | 2 | 3/1/0/0 | — | — | U |
| `consumer-setup-workflow-project-layer` | 3 | 0 | 1 | 2/1/0/0 | `setup-workflow`, `readiness.mjs`, manifest | — | U |
| `consumer-first-own-workflow` | 4 | 0 | 3 | 0/4/0/0 | `ask-matt`, `wrapup` | #343 | U |
| `consumer-update-over-local-edits` | 5 | 0 | 2 | 5/0/0/0 | — | — | U |
| `consumer-diff-inspection` | 3 | 0 | 2 | 2/1/0/0 | `kit-update` | — | U |
| `consumer-uninstall` | 3 | 0 | 1 | 3/0/0/0 | — | — | U |
| `consumer-routing-profile-decision` | 3 | 0 | 1 | 2/1/0/0 | — | — | U |
| `consumer-ownership-override` | 3 | 0 | 1 | 2/1/0/0 | — | — | U |
| `consumer-contribution-bridge` | 3 | 0 | 2 | 2/1/0/0 | — | — | U |
| `consumer-automated-update-pr` | 3 | 0 | 1 | 2/1/0/0 | `kit-update-pr.mjs` | — | U |
| `consumer-kit-update-skill` | 3 | 0 | 2 | 2/1/0/0 | `kit-update`, `release-parity.mjs` | — | U |
| `consumer-project-release` | 3 | 0 | 2 | 2/1/0/0 | `project-release` skill/script | — | U |
| `consumer-setup-pre-commit` | 3 | 0 | 3 | 2/1/0/0 | `setup-pre-commit`, template test | — | U |
| `consumer-census-establish` | 3 | 0 | 1 | 2/1/0/0 | `census-update`, two census scripts | — | U |
| `consumer-memory-lifecycle` | 3 | 0 | 2 | 2/1/0/0 | `memory-lifecycle` skill/script | — | U |
| `session-start-context-injection` | 3 | 0 | 0 | 3/0/0/0 | — | — | U |
| `guarded-tool-call-block` | 4 | 0 | 0 | 3/1/0/0 | `safety-guardrails/core.py` | #343 | U |
| `prompt-and-stop-time-advisory` | 3 | 0 | 0 | 3/0/0/0 | advisory capabilities | — | U |
| `worktree-create-and-bind` | 4 | 0 | 0 | 3/1/0/0 | setup/ignore scripts | — | U |
| `worktree-teardown` | 3 | 1 | 1 | 3/0/0/0 | cleanup | #320 | U |
| `recovery-red-release-run-but-published` | 4 | 2 | 3 | 2/2/0/0 | `release-state.mjs` | #205 | U |
| `recovery-awaiting-tag-stacked-bump` | 3 | 1 | 1 | 2/1/0/0 | release delta guard | #243 | U |
| `recovery-wrong-branch-commit` | 3 | 1 | 2 | 3/0/0/0 | `git-worktree-recover`, setup | — | U |
| `recovery-interrupted-afk-run` | 3 | 1 | 1 | 2/1/0/0 | `board-sync.py`, `orchestrate-wave` | — | U |
| `recovery-update-conflicts-with-local-edits` | 3 | 0 | 2 | 2/1/0/0 | `kit-update` | — | U |
| `recovery-guard-false-red-blocks-capability` | 3 | 1 | 2 | 1/2/0/0 | `codex-exec.sh` | #343, #380 | U |
| `recovery-teardown-blocked-by-symlinks` | 3 | 1 | 1 | 1/2/0/0 | cleanup | #2305 | U |
| `recovery-anchor-closed-early` | 3 | 1 | 1 | 2/1/0/0 | PR/anchor scripts | #341 | U |
| `recovery-board-status-drift` | 3 | 1 | 1 | 2/1/0/0 | `board-sync.py` | — | U |

## Cut candidates

Every valuation below is a **hypothesis**. Nothing is promoted; cutting authority remains downstream.

| Rank | Label | Hypothesis | Exactly what would be lost |
|---:|---|---|---|
| 1 | **delete** | Delete the blocking retro offer/closed-set `ran/skipped` binding; retain retrospective analysis as an optional sensor. | Guaranteed invitation after every landing, machine-readable evidence that retro was considered, and per-patch human approval before config mutation. |
| 2 | **delete** | Delete `small-direct-path`’s explicit human choice of workflow depth; let the agent select the direct route under the stated outcome and blast radius. | The user’s explicit chance to demand a deeper planning route before implementation starts. |
| 3 | **move** | Move cross-model hardening and its iterative review apparatus behind the deep/high-risk planning route; do not make it an implicit planning default. | Uniform second-model scrutiny, repeated adversarial rounds, and their audit trail on low-risk plans. |
| 4 | **move** | Hide S/B/C/P publish-state, normalization, archive, and body-rewrite mechanics behind one transactional board publication command. | Fine-grained resumability diagnostics and manual visibility into which partial publication state survived a crash. |
| 5 | **move** | Move ADR/glossary/research artifacts out of the shipped release set unless consumers genuinely execute or need them. | Automatic distribution of those documents to consumers and manifest-backed parity for them. |
| 6 | **keep** | Keep the consumer manifest, three-way reconciliation, backup/diff, ownership, and transactional activation floor. | Protection against silent overwrite, recoverability of consumer edits, and all-or-nothing activation. |
| 7 | **keep** | Keep one Semver gate plus tag identity, pending-tag guard, and post-publish parity reconciliation. | Explicit irreversible version authority and prevention/recovery for #205, #243, and #257. |
| 8 | **move** | Keep Codex parity mechanical, but move mirror-authoring detail from always-on doctrine into `codex-adapter-sync` plus CI. | Early prose warning that Claude is the authoring surface and both mirrors must land in the same PR. |
| 9 | **move** | Keep safety-blocking hooks always on; move prompt/stop advisories that merely forewarn into the skill or phase where they matter. | Early drift, LOC, handoff, refactor, and typecheck reminders before a relevant skill loads. |
| 10 | **move** | Collapse `ask-matt` and `scale-check` into one minimal intake exchange when the initial question is only “where do I start?” | Separate routing vocabulary, dedicated altitude interview, and a stable router independent of build sizing. |

## Judgment questions

Each compact version is ten lines or fewer.

### `idea-to-board-issue`

**Unaided:** A capable agent would capture a durable idea, draft a useful title/body, and avoid interrupting for reversible wording. It would not know the board field IDs, canonical status roles, or exact type-label policy unaided.

**Compact version:**

1. Decide whether the idea deserves durable tracking.
2. Draft outcome, context, and next decision.
3. Ask only if classification changes downstream handling.
4. Create through the board adapter using profile-derived fields.
5. Re-read the issue and report its number.

**Loss:** explicit triage-label doctrine, session-end ritual wording, and detailed board-drift recovery.

### `plan-to-executable-slices`

**Unaided:** Decomposition, dependency discovery, ACs, and a single preview are normal agent judgment. Exact Feature/Program grammar, global wave numbering, native links, promotion states, and crash-idempotency are not.

**Compact version:**

1. Confirm Feature versus Program only if ambiguous.
2. Produce outcome-sized slices with ACs and dependencies.
3. Preview the complete graph once.
4. On approval, batch-create/link/promote through one board transaction.
5. Re-read counts and surface any partial failure.

**Loss:** S/B/C/P diagnostics, archival history of intermediate bodies, repeated body verification, and fine-grained crash recovery.

### `land-planning-output`

**Unaided:** Treating durable documents as ordinary version-controlled work is obvious. Exact secret scanning, close grammar, and shipped-manifest classification are repository-specific.

**Compact version:**

1. Confirm the durable paths.
2. Secret-scan and create an ordinary docs branch.
3. Commit only the confirmed paths.
4. Run the relevant local gate.
5. Open and merge an ordinary PR.
6. Release only if the artifact is intentionally consumer-shipped.

**Loss:** automatic consumer distribution of every shipped ADR/research document and its release-parity guarantee.

### `small-direct-path`

**Unaided:** A capable agent should infer “tiny fix → test → change → verify → PR” without being told to choose a skill.

**Compact version:**

1. Reproduce or write the smallest failing test.
2. Implement the smallest fix.
3. Run focused test and local gate.
4. Open the PR under standing repository rules.
5. Return for one acceptance only if authority requires it.

**Loss:** explicit user choice of workflow depth and some separation between implementation, local CI, landing, and teardown recovery.

### `small-bug-fix-to-merged-and-released`

**Unaided:** Reproduction, regression test, focused fix, and CI are unaided judgment. Version identity, tag semantics, and partial-publication recovery are not.

**Compact version:**

1. Reproduce.
2. Add the regression test.
3. Fix and run local CI.
4. Merge through required CI.
5. Ask once for Semver.
6. Prepare, tag, monitor, and reconcile.
7. Report npm/GitHub parity.

**Loss:** explicit separation of release preparation, pending-tag prevention, and red-but-published recovery diagnostics.

### `release-the-kit`

**Unaided:** An agent would test and verify before publishing, but should not invent release authority, Semver, tag identity, or npm recovery policy.

**Compact version:**

1. Confirm Semver once.
2. Prepare version, manifest, and notes.
3. Run guard, staleness, suite, and pack.
4. Merge.
5. Verify canonical main and create the annotated tag.
6. Monitor npm and GitHub directly.
7. Reconcile the existing tag on partial failure.

**Loss:** mainly explanatory duplication; removing any substantive line loses protection proven relevant by #205, #243, or #257.

### `consumer-update-over-local-edits`

**Unaided:** “Do not silently overwrite local edits” is obvious safety judgment. Determining provenance, ownership, destination races, and transactional activation is not.

**Compact version:**

1. Compare current files with the recorded install manifest.
2. Fast-forward untouched kit files.
3. Leave consumer-owned paths untouched.
4. Backup and diff diverged kit files.
5. Ask the consumer only for genuine conflicts.
6. Verify the complete candidate.
7. Activate all or roll back all.

**Loss:** little explanatory detail; deleting substantive steps risks silent overwrite or a partially activated kit.

### `consumer-kit-update-skill`

**Unaided:** Preview-before-write is likely unaided. Release parity and transactional application are product contracts, not safe assumptions.

**Compact version:**

1. Resolve and parity-check the target release.
2. Preview every file decision.
3. Ask only on unresolved ownership/conflict.
4. Stage and verify the full candidate.
5. Activate transactionally or restore the original state.
6. Report the exact installed version.

**Loss:** detailed conflict taxonomy, provider-specific checks, and stepwise recovery evidence.

### `session-ends`

**Unaided:** A capable agent will summarize, preserve work, and leave a handoff. Safe worktree teardown and issue/PR closure authority require repository knowledge.

**Compact version:**

1. Persist unfinished findings.
2. Ensure tracked work is committed or explicitly handed back.
3. Land through the declared PR route.
4. Re-read issue/board state.
5. Tear down only after current-state safety checks.
6. Give one issue-anchored continuation prompt.

**Loss:** #320’s detailed recovery/provenance history, process-kill safeguards, and unusual teardown diagnostics. This pass does not propose re-planning them.

### `goal-level-delegation-afk-sweep`

**Unaided:** Self-routing, disjoint dispatch, serial integration, central verification, and one final report are reasonable agent judgment. Cross-session claims and authority boundaries need explicit contracts.

**Compact version:**

1. Resolve the outcome to the smallest executable route.
2. Stop only on a user-owned unresolved decision.
3. Claim the wave.
4. Dispatch file-disjoint slices in isolated worktrees.
5. Integrate serially.
6. Verify centrally.
7. Land/release within standing authority.
8. Return once for acceptance.

**Loss:** detailed lease recovery, route/effort receipts, per-slice reporting structure, and specialized interruption handling.

### `consumer-first-init`

**Unaided:** Installing files is obvious; manifest identity, project-layer ownership, and future three-way reconciliation are not.

**Compact version:**

1. Install the declared kit bundle.
2. Record hashes and origin for every installed path.
3. Create project-owned stubs once.
4. Never overwrite filled project-owned content.
5. Show the one next command that makes the workflow usable.

**Loss:** bundle taxonomy, readiness-capability detail, and fine-grained first-run diagnostics.

### `consumer-first-own-workflow`

**Unaided:** The agent can ask what outcome the consumer wants and select a small route. It cannot infer project-specific board, deployment, or approval policy absent a filled project layer.

**Compact version:**

1. Ask for the outcome, not a skill name.
2. Read the consumer project layer.
3. Select the smallest viable route.
4. Plan only decisions that genuinely bind the project.
5. Build and verify.
6. Land under the consumer’s own rules.
7. Explain what was learned from the first run.

**Loss:** dedicated router vocabulary, altitude taxonomy, and explicit tutorial structure. The current substrate does not yet provide the build/verify portion it would lose.

## Explicit disagreements with the substrate

1. `land-planning-output` inverts #343 and current release-lockstep doctrine.
2. The aggregate evidence does not support journey-specific traversal frequency, despite being framed as the record of journeys taken.
3. Flat station tables cannot price composed journeys without double-counting or omission.
4. `consumer-first-own-workflow` counts a substrate self-description as one of the consumer’s four stations and contains no build/verify station.
5. `goal-level-delegation-afk-sweep` starts after routing, so it does not measure outcome-entry.
6. `PROBLEMS: none` means structural validity, not semantic validity: resolvable citations can still contradict the promises attributed to them.