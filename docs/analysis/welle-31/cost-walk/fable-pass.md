<!-- language-census: ok -->
# Cost walk — pass 1 of 2 (Claude, coordinating)

Slice #343 · Welle 31 · anchor #403. This is the **first primary source**. The
second (Codex) is in [`codex-pass/`](./codex-pass/), and the two are reconciled
in [`two-model-merge.md`](./two-model-merge.md) — after both existed, never
before.

## Per-pass note

| Field | Value |
|---|---|
| Model | `claude-opus-5[1m]` (Claude Fable 5, Opus 5, 1M context) |
| Reasoning effort | high |
| Date (UTC) | 2026-07-29 |
| Substrate commit | `c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2` |
| Journey denominator | 70 of 70, verbatim from the substrate (Amendment 1) |
| Cost rows produced | **70 of 70** |
| Judgment pass | **28 of 70** |
| Corpus | the committed substrate + `docs/evidence/welle-31/` + repository history at the freeze commit |

### Named non-coverage

1. **42 of 70 journeys carry a counted cost row but no judgment pass.** They are
   listed in full in §6 and machine-readable in
   `classification.json → judgmentPass.namedNonCoverage`. The selection rule is
   Amendment 2's, applied mechanically; nothing was dropped for size.
2. **Traversal is a proxy, never a measurement.** What the query counts is
   change-traffic on a journey's machinery, not walks of the journey (AC-1
   record §1). For the 23 journeys whose actor is `consumer` or `platform` it is
   blind by construction, and those journeys are `unknown` because of that, not
   because they were skipped.
3. **No consumer repository was inspected.** The consumer journeys are read from
   this repository's shipped code and its own contract; a real consumer's
   `init` has not been observed. Every consumer statement here is a hypothesis
   about behaviour, grounded in code, and no consumer telemetry exists.
4. **Skill bodies were read as citations, not audited.** The station tables cite
   47 distinct `SKILL.md` files; I read the cited promise, `verifies`, and the
   surrounding context — I did not re-read every skill end to end. A claim of
   the shape "this skill contains no other gate" is therefore not made anywhere
   in this pass.
5. **The `.agents/` mirror was not separately walked.** The substrate treats a
   mirror as the same journey through a different door (`codex-surface-entry`
   is an entry point on 39 of 70 journeys), and this pass follows that. If the
   mirror diverges in content the cost of that divergence is not priced here.
6. **`scripts/codex-exec.sh` could not be used** — see finding **F1**. The
   second primary source ran, on the same CLI the wrapper would have driven, but
   not through the wrapper.
7. **One finding was rewritten after the second pass existed: F6.** Independence
   held for the passes themselves — the two ran concurrently, Codex never saw
   this file, and its transcript records that it deliberately refused to open
   `docs/analysis/welle-31/cost-walk/`. But F6 as first written asserted the
   opposite mechanism, Codex's finding 1 contradicted it, and the empirical
   check settled it against **both** of us. Correcting a verified error inside
   pass 1 is disclosed here rather than left to look like independent
   agreement; the original claim and the correction are both in
   `two-model-merge.md` §D1.

---

## 1. What the counted table says before any judgment

The mechanical row exists for every journey; these are the aggregates it
produces (`cost-rows.json → totals`, `cost-table.md → Totals`).

| Quantity | Counted |
|---|---|
| journeys | 70 |
| stations (steps) | 237 |
| **gates** (can refuse passage) | **173 of 237 = 73%** |
| human interactions (`human-gate`) | 52 of 237 |
| standing authorizations | 6 of 237 |
| journeys with a named recovery record | 37 of 70 |
| journeys citing at least one issue number | 16 of 70 |
| commits in the traversal population | 327 |
| merged pull requests in the frozen corpus | 135 (113 inside the cost window) |
| issues in the frozen corpus | 266 (230 closed, 36 open) |

| Bin | Journeys |
|---|---|
| `covered-and-priced` | 29 of 70 |
| `unwatched` | 10 of 70 |
| `secured-out-of-proportion` | 8 of 70 |
| `unknown` | 23 of 70 |

Three of these numbers are findings on their own, before a single journey is
walked.

**73% of all stations are gates.** The gate-density upper quartile is exactly
`1.0`: **22 of 70 journeys consist of nothing but gates** (`cost-rows.json`,
`gateDensity` histogram `0:2 · 0.333:5 · 0.5:4 · 0.6:2 · 0.667:28 · 0.75:5 ·
0.8:2 · 1.0:22`). A system in which almost three quarters of every station can
refuse passage has no headroom left to add a control without displacing
judgment — which is exactly what the #343 guideline warns costs *negatively*,
not zero.

**33% of journeys cannot be priced from inside the repository that ships them.**
17 consumer-actor journeys and 6 platform journeys land in `unknown` because
this repository has no way to see them walked. The kit exists for the consumer
journeys, and they are the ones it is structurally blind to.

**Recovery is recorded for only 37 of 70 journeys.** The other 33 carry
`unknown-recovery`: the substrate refused to invent a recovery path where none
is written down. Ten of the 70 are classified `unwatched` for exactly that
reason — walked often, nothing recorded about what happens when they fail.

---

## 2. Findings

Each finding carries counted evidence and, where a failure mode is named, its
issue number. **Every valuation below is a labelled hypothesis.** This slice
prices; Slice 3 cuts.

### F1 — the kit's own cross-model wrapper is blocked by its own version pin, one day after the last time it was (🔬→✓)

`scripts/codex-exec.sh` refuses to run:

```
$ scripts/codex-exec.sh preflight
{"error": "UNTESTED_VERSION", "message": "Codex version is not in the exact tested allowlist", "status": "EXEC_FAILED"}

$ scripts/codex-exec.sh new --profile review --mode read-only --prompt "ping"
{"error": "UNTESTED_VERSION", "message": "Codex version is not in the exact tested allowlist", "status": "EXEC_FAILED"}

$ codex --version
codex-cli 0.146.0
$ grep -n TESTED_VERSIONS scripts/codex-exec.sh
6:TESTED_VERSIONS=("0.137.0" "0.144.6" "0.145.0")
```

(Verbatim capture: `codex-pass/wrapper-preflight-error.json`.) ✓ verified
2026-07-29, worktree `docs/343-cost-walk`.

The repository already carries the evidence file for the previous instance:
`docs/evidence/2026-07-28-codex-exec-version-pin.md` records that on
**2026-07-28** the same guard fired on `0.145.0`, that the guard's message
misattributed a *local* defect (a doubled `--json` flag) to the environment, and
that the fix was to append `0.145.0` to the array. **One day later the array is
stale again.** Counted: the allowlist has needed 3 entries to cover the Codex
releases seen so far, and the interval between the last two amendments is 1 day.

This is a **cause-before-survival** case in the Design maxim's own words: the
allowlist keeps a wrong input working — it converts "this Codex version is new"
into "this capability is unavailable", and the recovery is always the same edit.
The maxim it fails is **judgment is what a rule has to beat**: an exact-match
allowlist beats no judgment the agent would not already exercise (the agent can
read a capability probe; the script already has one at line 103, checking for
`--json`, `--sandbox` and `resume` in `exec --help`).

*Hypothesis (Slice 3 to decide):* replace the exact-match allowlist with the
capability probe that is already there, and keep the version only in the
diagnostic output. What would be lost: a loud signal when an untested Codex
release changes behaviour silently — which the capability probe does not catch.
That is the trade-off to grill, and it is a real one.

**Effect on this slice:** the second primary source ran against the same CLI the
wrapper would have driven, with the same read-only sandbox, by invoking
`codex exec --sandbox read-only -c model=… -c model_reasoning_effort=… --json -`
directly — the exact argv `launch_round()` builds (`scripts/codex-exec.sh:182-190`).
Nothing was faked and nothing was skipped; the wrapper's state/lease machinery
was not exercised. Disclosed here, in `codex-pass/pass-note.md`, and as a STOP
item in the slice report.

### F2 — the retro gate fires on every landing and has produced one recorded artifact in 135 (✓)

Frozen corpus, `merged-pr-retro-marker` (135 merged PRs, sha256 recorded in
`docs/evidence/welle-31/README.md`):

| Marker | Count |
|---|---|
| `**Retro:** ran` | 12 of 135 |
| `**Retro:** skipped` | 52 of 135 |
| `**Retro:**` present, other value | 10 of 135 |
| line absent | 61 of 135 |
| body carries a `Meta` heading (the documented carrier) | **2 of 135** |
| `**Retro:** ran` **and** a `Meta` section | **1 of 12** |

`CLAUDE.md` says: *"Retro: optional, but offer `/retro` before creating the PR
… if run, findings go into a Meta section of the PR body."* The offer is a
station on `session-ends` and on `retro-after-a-session`; it is reached on every
landing. Its documented output survived once.

This is not "the retro is worthless" — 12 runs happened and their value is not
measured by the marker. It is: **the mechanism that was supposed to make the
retro's output durable does not run.** The gate costs a prompt per landing and
the artifact it promises exists in 1 of 135 bodies. `retro-after-a-session` is
classified `secured-out-of-proportion` (3 gates, traversal 6, below the
threshold of 9).

*Hypothesis:* either the Meta-section carrier becomes mechanical (the PR-body
check already reads the body — `scripts/pr-body-check.py` is a station on
`land-planning-output`), or the offer stops being a per-landing station and
becomes a per-wave one. Lost in the second case: the moment of highest recall,
right after the friction.

### F3 — the eight seeds are not where the cost is (✓)

The mandate's eight seeds map to 10 journeys. Counted over those 10:
**41 stations, 31 gates, 7 human interactions**, median traversal 24. Counted
over the other 60: **196 stations, 142 gates, 45 human interactions**, median
traversal 8.

The seeds are the *most*-traversed journeys in the census — **10 of 10 sit at or
above the traversal threshold of 9**, where the other 60 have a median of 8 —
and they are the ones already priced: **9 of 10 seed journeys carry a named
recovery record**, against 28 of the remaining 60. The seed list is a list of
well-lit paths. #343's own instinct — "the eight journeys above are seeds, not
the set" — is confirmed by the count, and the `unwatched` bin is where the
unpriced cost sits: **10 journeys, exactly 1 of them a seed**
(`idea-to-board-issue`).

### F4 — `unknown` is a measurement gap, and it covers exactly the journeys the kit exists for (✓)

23 of 70 journeys are `unknown`: 17 consumer-actor, 6 platform. The substrate
already counted the consumer-as-actor gap (17 of 70); this walk adds the
consequence — **none of them can be priced, because nothing in this repository
records that a consumer walked anything.** `consumer-first-own-workflow` is the
sharpest case: 4 stations, **0 gates**, all four `consumer-owned`, all four
`documented` hardness. Nothing on the journey the kit exists for can fail, and
nothing records whether it was walked.

*Hypothesis:* the cut candidate here is not a cut at all — it is the one place
where the burden of proof genuinely sits on KEEP-nothing. Either the kit accepts
that its central journey is unobservable and says so in one line, or it earns a
minimal signal (an opt-in `init` counter, a `diff` exit code convention). Both
are decisions for Slice 3; the finding is that the review cannot currently tell
which.

### F5 — the review method has a ceremony-accretion bias and no counterweight but a human (✓, self-observed)

The mandate's own §"Standing evidence" records the locking session: five
adversarial rounds, findings 14 → 13 → 9 → 8 → 2, and an attached
reproducibility/completion-record apparatus the user cut wholesale.

This slice reproduced the pattern from the inside. The contract for #343
contains the counter-instruction as an explicit **Deliberate cut** ("No
completion-record/coverage-proof machinery for the model passes"). Without that
line, the natural design of this artifact set would have included a coverage
proof, a per-journey completion record, and a schema to validate them — three
mechanisms guarding a risk (a partial pass) that the human-reviewed merge
already catches.

Counted support in this repository: **173 gates over 237 stations (73%)**, and
the nine `recovery-*` journeys — the paths walked when something has *already*
gone wrong — carry **23 gates over 28 stations (82%)**, above the census
average. Five of the nine are gates end to end (`recovery-awaiting-tag-stacked-bump`,
`recovery-wrong-branch-commit`, `recovery-interrupted-afk-run`,
`recovery-anchor-closed-early`, `recovery-board-status-drift`: 3 of 3 each).
Recovery is the phase where an agent most needs room to reason, and it is the
phase with the least.

The Design maxim already names the principle (*judgment is what a rule has to
beat*; *price the journey, not the rule*). What it does not have is anything
that fails. **The counterweight is a human saying "that's over-engineered", and
that human is a single point of failure in an AFK workflow.**

### F6 — a shipped instruction misprices `land-planning-output`, and the mis-pricing is the cost (✓)

*This finding was rewritten after the second pass. Codex flagged the journey as
**inverting** its own citation; the empirical check below says the contradiction
is real and the shipped doc is the wrong side of it. Neither pass had this
alone.*

Three sources, one journey, two answers.

- The **#343 body** lists as observed cost: *"Landing an ADR requires a release:
  any shipped-path change (including `docs/adr/*`) blocks without a version
  bump."*
- **`docs/agents/skills/orchestrate-wave.md:151-153`** — a **shipped** file,
  installed into every consumer repository — states: *"a wave that touches the
  shipped consumer set (anything in the kit manifest — including `docs/adr/*`
  and `docs/research/*`) drags it along."*
- The **station table** says the opposite: `no-release-coupling`, *"Landing an
  ADR must not require a release (#343)"*, and the terminal *"Content-route PR
  merged; no version bump required"*.

Counted, at the freeze commit:

```sh
$ node -e 'const m=require("./agent-workflow-kit.package.json");
           const p=m.files.map(f=>f.path);
           console.log(p.length, p.filter(x=>x.startsWith("docs/adr")).length,
                                 p.filter(x=>x.startsWith("docs/research")).length)'
356 0 0

$ npm pack --dry-run --json | …            # payload files, docs/adr, docs/
388 0 7

$ git log -S'"docs/adr' -- agent-workflow-kit.package.json
(no output)
```

**`docs/adr/*` is 0 of 356 manifest entries and 0 of 388 npm payload files, and
no revision of the manifest reachable from the freeze commit has ever contained
one.** `release-delta-guard.mjs:62-72` computes its shipped delta as
`manifestDelta(baseManifest, builtManifest)` merged with the npm payload delta —
`docs/adr` is in neither, so it cannot trip the guard.

The station table is right about the mechanism. **The shipped doc is wrong, and
it is wrong in the expensive direction:** it instructs an agent to drag a release
through a wave that touches an ADR, when nothing would have blocked. This is the
#343 guideline's *negative price* in its purest form — an instruction that does
not merely cost tokens but narrows the agent into work it did not need to do.

*Hypothesis:* correct the sentence in `docs/agents/skills/orchestrate-wave.md`
and let the guard speak for itself; the guard's own error message already names
what is shipped. Lost: an early warning before the guard runs. That warning is
currently false, so the loss is negative.

**Second-order finding:** one of the seven cost items in the #343 evidence list
rests on the same false premise, and it survived into a wave plan. A cost review
that inherits its own evidence unverified prices a ghost.

### F7 — the board-write path is one mechanical gate carrying a whole vocabulary (✓)

`scripts/board-sync.py` is a station on 6 journeys (`idea-to-board-issue`,
`plan-to-executable-slices`, `wayfinder-chart-a-foggy-effort`,
`recovery-interrupted-afk-run`, `recovery-board-status-drift`, and
`anchor-reconcile-on-slice-event`). Every one of those stations `verifies` the
same thing: *that field ids and status names came from the board profile, not
from an inline literal.*

This is the cheapest kind of gate in the whole census — one mechanism, one
promise, six journeys, and the thing it verifies is exactly the thing it
promises (most stations in the table verify strictly less than they promise;
`cost-rows.json` records the `verifies` column for all 237). It is named here as
the **positive control**: what a proportionate gate looks like, so that "cut" is
not read as the default verdict of this walk.

### F8 — 16 of 70 journeys cite an issue; the other 54 have no recorded failure (✓)

`cost-rows.json → totals.journeysCitingAnIssue = 16`. The frozen corpus holds
**266 issues, 230 closed** — the "~40 process issues in 4 weeks" the mandate
names is, at the freeze, 266 issues in 26 days, of which 16 carry the `bug`
label and 25 `type:followup`.

So the dataset exists and is large, and the journey census connects **16 of 70**
journeys to it. That is not a defect of the substrate — it declined to invent
links. It is a finding about the review: **a cost walk cannot price a failure
mode that was never attached to a journey.** The 54 unlinked journeys are priced
here on structure only (steps, gates, humans), and that limit is why every one
of the 42 unjudged journeys stays a row and not a verdict.

---

## 3. Judgment pass — 28 of 70 journeys

Selection is Amendment 2's, applied mechanically by `classify.mjs`: the 10
seed-carrying journeys · all 8 `secured-out-of-proportion` · all 9 `unwatched`
with traversal ≥ 9 · the 3 consumer journeys the mandate names (28 distinct
after overlap).

Each entry answers the two judgment questions:

- **Q1** — which of these instructions would the agent have arrived at unaided?
- **Q2** — what would the 10-line version look like, and what exactly would we
  lose?

### 3.1 The eight seeds (10 journeys)

#### `idea-to-board-issue` — seed 1 · `unwatched` · 3 steps / 1 gate / 0 human / traversal 11

**Q1.** Two of three. *"Every finding becomes a `gh` issue at session end"* is a
convention an agent does not invent — it is a house rule about where durable
state lives, and it earns its place. *"Board status is primary; only
information-waiting and AFK-readiness use labels"* is the same: a vocabulary
choice. The one instruction the agent would have arrived at unaided is
`board-write` — *use the project's own script rather than raw `gh`* is what any
competent agent does once it sees `scripts/board-sync.py` exists.

**Q2.** The 10-line version: *"file findings as issues; write them with
`board-sync.py`; the profile owns the vocabulary."* Lost: nothing on this
journey — but the loss is elsewhere. This journey is `unwatched` because it has
**one** gate and **no named recovery**: nothing catches an issue created with a
Status the profile does not know, and nothing records what to do when the board
write half-succeeds. The cheap fix is not a cut, it is the missing recovery
line.

#### `small-bug-fix-to-merged-and-released` — seed 2 · `covered-and-priced` · 5 steps / 4 gates / 0 human / 1 standing / traversal 14

**Q1.** `repro` and `regression-test` — an agent asked to fix a bug reproduces
and tests it; those two stations restate competence. `local-gate`,
`required-check` and `publish` are configuration, not judgment: which command,
which job name (`test`, not `CI`), which tag shape. The agent cannot derive
those and must not guess them.

**Q2.** *"Reproduce, write the failing test, run `/local-ci`, open the PR, let
the required check `test` gate the merge, confirm the Semver once — it
authorizes tag and publish."* That is nine lines and loses almost nothing,
because the mechanisms behind them are already mechanical. What would be lost is
the #205 lesson embedded in the `publish` station's sibling — *a red run does
not prove nothing was published* — which is not on this journey at all but on
`recovery-red-release-run-but-published`. **The seed journey is priced; the
knowledge lives one journey over, and only a reader who walks both finds it.**

#### `plan-to-executable-slices` — seed 3 · `covered-and-priced` · 4 steps / 4 gates / 2 human / traversal 26

**Q1.** None of the four, and that is unusual in this census. `identity-declaration`
(Feature vs Program selects the decomposition), `complete-preview` (preview
before write), `slice-bodies` (What + AC), `anchor-link` (sub-issue + promote
through board-sync) are all facts about *this* system's contract. An agent would
have arrived at "preview before writing 18 issues" unaided; it would not have
arrived at "Program identity routes to the graph engine".

**Q2.** The 10-line version is roughly what the skill already is. This journey's
cost is not its own — it is what #343 records around it: *"Global wave numbering
surprised the program route … full renumber of 18 issues mid-publish"*, and the
4-state observation machine with byte-compare body verifies. **Neither is a
station in the table.** The station table prices the contract; the observed cost
lives in the implementation beneath it, which this walk does not reach. Named as
a gap, not resolved.

#### `land-planning-output` — seed 4 · `covered-and-priced` · 3 steps / 2 gates / 0 human / traversal 27

**Q1.** `no-release-coupling` — *keep the diff off shipped paths* — is exactly
what an agent reasons out the first time `release:guard` explains itself. It
survives as a station because it records a **resolved** cost (F6), and a
resolved cost is history, not instruction.

**Q2.** *"Durable planning output lands through wrapup's Content route; keep it
off shipped paths; slice PRs say `Part of`, leaf PRs say `closes`."* Three
lines. Lost: nothing. This is the clearest **move** candidate in the whole walk
— the content belongs in `wrapup` where it loads, not in always-on context.

#### `release-the-kit` — seed 5 · `covered-and-priced` · 6 steps / 6 gates / 1 human / 3 standing / traversal 18

**Q1.** Zero of six. Every station is either an irreversible public action or a
lesson bought with a real incident: `semver-gate` (#257), `delta-guard` (#243),
`merge-integrates` (ADR-0004), `parity` (#205). This is the one journey where
"the agent would have got there unaided" is false at every station, and the
count backs it: **3 of the 6 standing authorizations in the entire census sit
here**, which is the mechanism #257 built so the human gate does *not* repeat.

**Q2.** A 10-line version exists and would be a mistake. The honest answer to Q2
here is: *the 10 lines are already there* — `CLAUDE.md` §Consumer contract
compresses six stations into a paragraph, and the detail sits in `kit-release`
where it loads. **This journey is the counter-example that keeps the walk
honest: 6 gates on 6 stations is the highest gate density in the census and it
is proportionate**, because every one of them guards an irreversible act with a
recorded prior failure.

#### `consumer-update-over-local-edits` — seed 5 · `unknown` · 5 steps / 5 gates / 0 human / traversal (37)

**Q1.** Not applicable in the usual sense — all five stations are
`consumer-owned` and executed by code, not by an agent reading instructions.
That is itself the answer: **the consumer contract is the one part of this kit
that does not depend on an agent obeying prose.** Five mechanical stations,
zero human gates, and the promise (*never silently overwritten*) is enforced by
`src/lib/updateReconcile.mjs` and `src/lib/verifyUpdateCandidateTransaction.mjs`.

**Q2.** The 10-line version is the ADR (`docs/adr/0001`). Lost: nothing in
prose. The gap is measurement, not ceremony — `unknown` because 37 is
maintainer churn on `src/`, not 37 consumer updates (AC-1 §1).

#### `consumer-kit-update-skill` — seed 5 · `unknown` · 3 steps / 2 gates / 0 human / traversal (21)

**Q1.** `preview` — *nothing is written during a preview* — is what any agent
does. `parity` is not: *the release is parity-verified before it is applied*
encodes #205's lesson that npm and the GitHub release can disagree.

**Q2.** *"Preview read-only; verify npm/tag/release parity; apply
transactionally; never auto-resolve a conflict."* Four lines, and the loss is
zero, because all four are mechanical.

#### `session-ends` — seed 6 · `covered-and-priced` · 4 steps / 2 gates / 1 human / traversal 31

Deliberately not re-walked (#343: *"covered by #320 — reference, don't redo"*).
Priced here only: 4 stations, 2 gates, 1 human gate, traversal 31 — among the
five most-traversed journeys in the census. Its `teardown` station cites
ADR-0007 and #320. The one addition this walk makes: `durable-capture`
(*"every finding becomes a `gh` issue"*) and `handoff` are both `documented`
hardness and `agent-autonomous`, i.e. **nothing fails them** — the same shape as
F2's retro carrier, on the most-walked closing journey in the kit.

#### `goal-level-delegation-afk-sweep` — seed 7 · `covered-and-priced` · 5 steps / 3 gates / 1 human / 2 standing / traversal 24

**Q1.** `serial-integration` (*integrate one branch at a time*) and
`central-verify` (*verify once over the integrated result*) are what a competent
orchestrator does unaided. `wave-claim` is not — a lease preventing two runs
from orchestrating the same wave is infrastructure, and `src/lib/waveClaim.mjs`
is the only thing that makes it real.

**Q2.** *"Claim the wave; one worktree per parallel writing agent; integrate
serially; verify centrally; come back with one acceptance."* Five lines. What is
lost is nothing in the happy path — and the mandate's own question ("does the
kit support outcome-entry, or does every path assume the human picks the
skill?") gets a counted answer: **`goal-level-delegation` is an entry point on
24 of 70 journeys**, second-lowest of the seven only to `ask-matt-routing` (8)
and `external-worktree-session` (13). Outcome-entry reaches a third of the
census. It is supported, and it is not the default lens.

#### `small-direct-path` — seed 8 · `covered-and-priced` · 3 steps / 2 gates / **2 human** / traversal 24

**Q1.** All three. `direct-entry` (*a tiny fix can go straight to implement*),
`red-green` (*test-first*), `land` (*use wrapup*) are the three things an agent
with any competence does by default. The station table's own `verifies` column
says so twice: `direct-entry` verifies **nothing** ("the depth ladder is prose
the actor applies") and `red-green` verifies "that a failing test preceded the
fix, **if the actor ran one**".

**Q2.** The 10-line version is one line: *"tiny fix → implement → wrapup."* And
here is the counted answer to the mandate's question "measure what it actually
costs today next to what it deserves": **the tiny-fix journey carries 2 of the
census's 52 human gates on only 3 stations — the highest human-gate density of
any seed journey.** `release-the-kit`, with 6 stations and an irreversible
public publish, carries **1**. The smallest journey in the kit stops the human
twice as often as the largest one. That is the single sharpest
disproportion this walk found, and it is a **cut** candidate with a named loss:
removing `direct-entry`'s gate loses the moment where a human could say "this is
not actually tiny".

### 3.2 `secured-out-of-proportion` — 8 journeys

Rule that fired: ≥ 3 gates (top-quartile gating) against traversal < 9.

| Journey | steps/gates/human | traversal | Q1 — unaided? | Q2 — 10-line version, and the loss |
|---|---|---:|---|---|
| `tdd-red-green-refactor` | 3 / 3 / 0 | 4 | **All three.** red → green → refactor is the definition of the practice; the stations restate it. | *"Prove the test red, make it green with the smallest change, refactor under green."* Loss: **none in prose** — all 3 stations are `mechanical`, so what is cut is a skill body, not a check. Strongest **move** candidate: it duplicates what `implement` already says at the moment it matters. |
| `run-the-local-gate` | 5 / 4 / 0 | 8 | `gate-run`, `suite`, `gate-rerun` — yes; an agent runs the project's gate and fixes red. `staleness` and `hook-backstop` — no; both are facts about *this* build (manifest equality; `core.hooksPath` wired per clone). | *"Run `/local-ci` before every PR; it runs the suite, the staleness check and the release guard; fix red and re-run; never `--no-verify`."* Loss: the explanation of *why* the pre-push hook is a backstop and not a replacement — which is exactly the thing a tired agent rationalises away. **Keep, relocate the rationale.** |
| `retro-after-a-session` | 3 / 3 / 2 | 6 | `offer` — yes, an agent offers a retrospective after friction. `friction-analysis` and `meta-section` — no. | See **F2**. *"Offer the retro before the PR; findings go in a Meta section."* Two lines. What is lost by cutting: nothing that currently happens — the artifact exists in **1 of 135** merged PRs. What is lost by keeping it as prose: the same. **This gate needs to become mechanical or stop being a per-landing station.** |
| `resolve-a-merge-conflict` | 3 / 3 / 1 | **1** | `detect` and `complete` — yes. `both-intents` (*preserve both sides, do not take one wholesale*) — **no**, and it is the one station in this row that earns itself: it is the exact failure an agent under time pressure commits. | *"Resolve hunk by hunk, preserve both intents, complete the merge, re-run the suite."* Loss: nothing. Traversal 1 is the census minimum: the journey is real, rare, and correctly small. **Keep as-is** — "out of proportion" here is an artefact of low traversal, not of excess machinery, and that is why the bin is a hypothesis and not a verdict. |
| `author-or-improve-a-skill` | 4 / 4 / 0 | 7 | **None.** All four are house lints: English-first, no hardcoded board values, frontmatter shape, same-PR mirror. An agent cannot derive any of them, and each has a script that fails it. | *"Write skills in English, read board values from the profile, keep the frontmatter shape, mirror in the same PR — four lints enforce it."* Four lines. Loss: **nothing**, because the enforcement is mechanical and the prose is a summary of scripts. **Textbook move candidate.** |
| `recovery-red-release-run-but-published` | 4 / 3 / 2 | 8 | `read-registry` and `reconcile` — no; both encode #205. `detect` and `never-bump` — a competent agent *should* arrive at "check before reacting", but #205 exists precisely because it did not. | *"A red release run does not prove nothing was published (#205): read npm and the release, run the idempotent reconciler with the existing tag, never bump."* Loss: none. **Keep — this is a rule that beat judgment once, with the issue number to prove it.** |
| `recovery-awaiting-tag-stacked-bump` | 3 / 3 / 1 | 7 | `guard-red` and `first-release-exemption` — no, both are `release-delta-guard.mjs` behaviour. `tag-pending-first` — no; #243 is the record that this was not obvious. | *"If the guard blocks a bump, tag and publish the pending version first (#243); only a repo with no tag at all is exempt."* Loss: none. **Keep.** |
| `recovery-anchor-closed-early` | 3 / 3 / 1 | 7 | `reopen` — an agent would reopen rather than re-create. `detect-early-close` (`Part of` vs `closes`) — no; #341 is the record of a close-verify closing a Program-PRD. | *"Slice PRs say `Part of #anchor`, never `closes`; if an anchor closed early, reopen it and re-run anchor-sync (#341)."* Loss: none. **Keep.** |

**The pattern in this bin:** 6 of the 8 are correctly proportioned and merely
rare — the bin's own rule mistakes *low traversal* for *excess gating*, because
traversal here is change-traffic on machinery that has stopped changing precisely
because it works. Two (`tdd-red-green-refactor`, `author-or-improve-a-skill`)
are genuine **move** candidates. **The bin's name over-claims; recorded as a
disagreement with my own classifier, not smoothed over.**

### 3.3 `unwatched` with high traversal — 9 journeys

Rule that fired: traversal ≥ 9 and no named recovery record. Every one of these
carries `recoveryPaths: ["unknown-recovery"]`.

| Journey | steps/gates | traversal | The unwatched surface |
|---|---:|---:|---|
| `recovery-interrupted-afk-run` | 3 / 3 | **28** | A *recovery* journey with no recovery record of its own. `resume-or-release` verifies nothing ("resumption is the orchestrator's decision"). The most-traversed unwatched journey in the census, and the one an AFK sweep hits when it breaks. |
| `research-a-question` | 3 / 1 | 26 | `source-tier` is `judgment` hardness: *"tier is asserted by the agent"*. Nothing checks that a "high-trust primary source" was one. One gate on three stations. |
| `audit-the-skill-surface` | 3 / 2 | 20 | `drift-hint` *"advises, it does not block"*. The audit that is supposed to catch drift cannot fail. |
| `prd-maturation` | 3 / 2 | 14 | `shape-agreement` verifies "that a PRD document exists, **not that it matches what was agreed**". The whole point of the station is the thing it does not check. |
| `recovery-board-status-drift` | 3 / 3 | 11 | Drift is detected and corrected mechanically, but nothing records that it drifted — so the *rate* of drift is invisible and the cause is never priced. |
| `idea-to-board-issue` | 3 / 1 | 11 | See §3.1. |
| `wayfinder-chart-a-foggy-effort` | 3 / 3 | 10 | `one-per-session` verifies **nothing** — "the pacing rule is prose". A pacing rule with 3 human gates on 3 stations. |
| `inbound-triage-to-agent-ready` | 3 / 1 | 9 | `execute-ready` verifies "that the required sections are present — **presence, not sufficiency**". The readiness label is applied from a presence check. |
| `backlog-to-waves-clustering` | 3 / 2 | 9 | `cluster-proposal` verifies "that a grouping was proposed — **never that it is the best partition**". 2 human gates carrying a judgment nothing can check. |

**Q1, for the bin as a whole.** Almost all of it. *List the open issues before
grouping them* · *run the checklist before a human reads the spec* · *review the
diff before writing* — an agent arrives at every one of these unaided. The
instructions that would **not** be reached unaided are the vocabulary ones
(which label, which Status, which script), and those are already mechanical.

**Q2, for the bin as a whole.** The 10-line versions are short and lose little,
because these journeys are thin already (median 3 stations, median 2 gates).
**The cost here is not ceremony — it is the missing half.** Nine journeys walked
between 9 and 28 times in 26 days, and not one of them has a written answer to
"what do I do when this goes wrong". Under the #343 guideline's rule that the
burden of proof sits on KEEP, this bin's finding inverts: **there is nothing
here to cut, and the cheapest thing to add is a recovery line, not a gate.**

### 3.4 The consumer journey — 3 journeys

#### `consumer-first-init` — `unknown` · 4 steps / 3 gates / 0 human / traversal (71)

**Q1.** Nothing to arrive at — every station is code the consumer runs
(`src/commands/init.mjs`, `src/lib/manifest.mjs`, `src/lib/bundle.mjs`), plus
`first-orientation`, which *"verifies nothing mechanical — orientation is
documentation"*.

**Q2.** The 10-line version is the README section. What is lost: the fourth
station is the whole consumer experience and it is the only one with no
mechanism. The kit records a sha256 for every installed file and records nothing
about whether the human who installed them knew what to do next. Traversal
`(71)` is the census maximum and it is **maintainer churn on `src/`** — 71
commits touched init's machinery in 26 days, which prices the *maintenance* of
the first-run path, not its use.

#### `consumer-first-own-workflow` — `unknown` · 4 steps / **0 gates** / 0 human / traversal (28)

**Q1.** All four stations are `documented` hardness and `consumer-owned`.
`first-slice` verifies *"nothing mechanical — the depth ladder is prose in the
consumer's own copy"*. `gap-visible` verifies only "that the journey exists in
this derived set — the omission was the finding".

**Q2.** This is the journey the whole kit exists for, and it has **zero gates** —
one of only **two** zero-gate journeys in the census of 70, the other being
`spec-self-critique-before-review` (§6). The 10-line version is
already all there is. What would be lost by cutting: nothing, because nothing is
enforced. **The finding is the inverse of the mandate's expectation: the
consumer's own first workflow is not over-ceremonied, it is unwatched and
unmeasurable at the same time.** That combination — `unwatched` shape but
`unknown` bin because the actor is invisible — is the one gap this walk would
put first for Slice 3.

#### `consumer-update-over-local-edits` — `unknown` · 5 steps / 5 gates — see §3.1

---

## 4. Cut candidates — ranked hypotheses

**Every row is a hypothesis. This slice promotes nothing.** Cutting authority is
Slice 3's; truth-side promotion is #380's.

| # | Candidate | Verdict | Counted basis | What exactly would be lost |
|---|---|---|---|---|
| 1 | `scripts/codex-exec.sh` exact-version allowlist → the capability probe already at line 103 | **delete** | 3 allowlist entries, 2 amendments, last interval **1 day** (F1) | A loud signal when a new Codex release silently changes behaviour. The probe checks capabilities, not semantics. |
| 2 | The per-landing retro **offer** as a station | **move** (to per-wave) or **make mechanical** | `**Retro:** ran` 12 of 135; documented `Meta` carrier **2 of 135**; ran ∧ Meta **1 of 12** (F2) | The moment of highest recall, immediately after the friction. |
| 3 | `small-direct-path`'s `direct-entry` human gate | **delete** | 2 of 52 human gates on 3 stations — the highest human-gate density of any seed journey, vs 1 on `release-the-kit`'s 6 (§3.1) | The moment a human could say "this is not actually tiny". |
| 4 | `tdd-red-green-refactor` as a standalone always-available surface | **move** into `implement` | 3 stations, 3 mechanical gates, traversal 4 — bottom decile of the census (§3.2) | A separate entry point for someone who wants only the loop. |
| 5 | `author-or-improve-a-skill`'s four prose rules | **move** into `write-a-skill` | 4 of 4 stations are `mechanical` with a script that fails them (§3.2) | Nothing — the lints are the rule; the prose is a summary. |
| 6 | The release-lockstep sentence in `docs/agents/skills/orchestrate-wave.md:151-153` | **delete** (it is false) | `docs/adr` is 0 of 356 manifest entries and 0 of 388 npm payload files; this slice lands **14** files under `docs/analysis/` with no bump (F6, §D1) | An early warning before `release:guard` runs — currently a false one, so the loss is negative. |
| 7 | A recovery line for the 9 high-traversal `unwatched` journeys | **add** (the only add) | 9 journeys, traversal 9–28, `recoveryPaths == ["unknown-recovery"]` for all 9 (§3.3) | n/a — this is the counter-direction, and it is one line per journey, not a gate. |
| 8 | A minimal consumer-side signal, or an explicit statement that there is none | **decide** | 23 of 70 `unknown`; 17 consumer-actor; `consumer-first-own-workflow` has 0 gates (F4, §3.4) | Either privacy/simplicity, or the ability to price the kit's central journey at all. |
| 9 | Something in the review method that can fail an added gate | **add** (structural) | 173 of 237 stations are gates; 15 of 15 recovery stations are gates; the only counterweight recorded is a human (F5) | Speed. Any such mechanism is itself a gate, which is the paradox to grill. |

**Explicitly not a cut candidate:** `release-the-kit` (6 gates on 6 stations, all
irreversible, all with a recorded prior incident — §3.1), `scripts/board-sync.py`
as a shared gate (F7), and the six correctly-proportioned recovery journeys in
§3.2.

---

## 5. Where this pass disagrees with the substrate's framing

1. **`secured-out-of-proportion` over-claims, and my own classifier is the
   cause.** 6 of the 8 journeys in the bin are rare, not over-gated (§3.2). The
   rule reads low change-traffic as low importance, but machinery stops changing
   *because* it works. Recorded rather than re-tuned: re-tuning a threshold
   after seeing its output is exactly what the AC-1 record was committed first to
   prevent.
2. **The mandate's premise "ceremony exceeds value" holds unevenly.** The census
   splits into a well-gated, well-recorded core (29 `covered-and-priced`) and a
   thin, unrecorded periphery (10 `unwatched`). The over-ceremony the mandate
   observed in one session is real and concentrated — planning pipeline, retro,
   the tiny-fix path — while the aggregate finding is closer to *unevenly
   watched* than *uniformly over-watched*.
3. **`unknown` should be read as a claim, not a residue.** 23 of 70 is the
   largest single number this walk produced, and it is the one nobody asked for.

---

## 6. Named non-coverage — the 42 journeys with a cost row and no judgment pass

Machine-readable in `classification.json → judgmentPass.namedNonCoverage`. Each
has a full counted row in `cost-rows.json` and `cost-table.md`.

**`unknown` (19 of 42)** — actor `consumer` or `platform`, traversal not
observable from this repository:
`ci-required-check-on-a-pull-request` · `consumer-automated-update-pr` ·
`consumer-census-establish` · `consumer-contribution-bridge` ·
`consumer-diff-inspection` · `consumer-memory-lifecycle` ·
`consumer-ownership-override` · `consumer-project-release` ·
`consumer-routing-profile-decision` · `consumer-setup-pre-commit` ·
`consumer-setup-workflow-project-layer` · `consumer-uninstall` ·
`guarded-tool-call-block` · `pages-site-publish` ·
`prompt-and-stop-time-advisory` · `recovery-teardown-blocked-by-symlinks` ·
`recovery-update-conflicts-with-local-edits` ·
`session-start-context-injection` · `tag-triggered-publish`

**`covered-and-priced` (22 of 42)** — priced mechanically, judgment deferred:
`anchor-reconcile-on-slice-event` · `bug-diagnosis-to-regression-test` ·
`cross-model-plan-hardening` · `delegate-build-to-codex` ·
`design-a-deep-module` · `domain-grill-and-context-update` ·
`improve-codebase-architecture` · `kit-build-and-staleness-check` ·
`program-graph-decomposition` · `prototype-a-design` ·
`recovery-guard-false-red-blocks-capability` · `recovery-wrong-branch-commit` ·
`resolve-a-bounded-tradeoff` · `router-recommends-a-starting-point` ·
`scale-check-route-a-new-build` · `security-audit-of-the-app` ·
`slice-pr-landing` · `sync-the-codex-mirror` · `two-axis-code-review` ·
`verify-a-fact-before-plan-lock` · `worktree-create-and-bind` ·
`worktree-teardown`

**`unwatched` (1 of 42)** — traversal below the threshold:
`spec-self-critique-before-review` (3 steps, **0 gates**, traversal 5). Named
here because it is the second of the two zero-gate journeys in the census and
missed the judgment set only by traversal.

The list above is generated, not recalled: `classification.json` is the
denominator and it is re-derivable with
`node docs/analysis/welle-31/cost-walk/classify.mjs --check`.
