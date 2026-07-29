<!-- language-census: ok -->
# Two-model merge — cost walk #343

Written **after both passes existed**, never before (Amendment 4).

| | Pass 1 | Pass 2 |
|---|---|---|
| Source | [`fable-pass.md`](./fable-pass.md) | [`codex-pass/response.md`](./codex-pass/response.md), noted in [`codex-pass/pass-note.md`](./codex-pass/pass-note.md) |
| Model / effort | `claude-opus-5[1m]` / high | route control `gpt-5.6-sol` / high |
| Date (UTC) | 2026-07-29 | 2026-07-29, 07:51:49Z → 08:04:08Z |
| Substrate commit | `c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2` | same, independently verified by the pass |
| Cost rows | 70 of 70 | 70 of 70 |
| Judgment pass | 28 of 70 | 12 of 70 |
| Bins | 29 / 10 / 8 / 23 | 0 / 0 / 1 / 69 |

The two passes ran concurrently and neither read the other. Where they agree,
the agreement is independent. Where they disagree, **the disagreement is the
finding** — listed below, never resolved silently, and adjudicated against the
Design maxim in `CLAUDE.md` rather than against either pass's taste.

---

## A. Agreements — independently reached, therefore hardened

**A1 · The retro binding is disproportionate to its yield.** Both passes reached
`secured-out-of-proportion` for `retro-after-a-session`, from the same frozen
export and different predicates. Pass 1: the documented `Meta` carrier appears
in **2 of 135** merged PRs, and `ran` ∧ `Meta` in **1 of 12**. Pass 2: **9 of
12** `ran` rows carry the *wider* findings heading, and **4 of 14**
findings-heading PRs carry no marker at all. The two readings differ in
severity and agree in direction: **the marker and the findings diverge**, in
both predicates. This is the only journey pass 2 classified out of proportion at
all, and pass 1 reached it independently. Cut candidate, hypothesis: make the
carrier mechanical or move the offer off the per-landing path.

**A2 · The consumer's own first workflow is the structural gap.** Both passes
single out `consumer-first-own-workflow`: 4 of 4 stations `documented`, **0
mechanical**, **0 gates**, and no build or verify station at all. Pass 2 adds
the sharper observation: one of its four stations (`gap-visible`) is a
*substrate self-description* — "the journey exists in this derived set" — and
not a step any consumer walks. **The journey the kit exists for has three real
stations, none of which anything can fail.** Both passes classify it `unknown`
and both refuse to call it `unwatched`, because traversal is unobservable, not
low.

**A3 · The release journey is expensive and proportionate.** Both passes decline
to cut it. Pass 1: 6 gates on 6 stations, every one guarding an irreversible act
with a recorded prior incident (#205, #243, #257), and 3 of the census's 6
standing authorizations sit here — the mechanism that stops the human gate
repeating. Pass 2: "the cost finding is not 'too many human approvals'"; one
human gate, keep. Agreement against the reviewer's own incentive to find a cut
is worth more than a cut.

**A4 · The deep planning route is where the aggregate hurts.** Pass 2 sums the
Program route (`domain-grill-and-context-update` + `prd-maturation` +
`plan-to-executable-slices` + `program-graph-decomposition`) at **14 stations,
7 gates**, rising to **17 stations, 9 gates** with `cross-model-plan-hardening`
— and notes that this still omits the S/B/C/P observation machine, body
normalization, archive comments and the renumber, because none of them were
stationized. Pass 1 reached the same limit from the other end (§3.1,
`plan-to-executable-slices`: "the station table prices the contract; the
observed cost lives in the implementation beneath it"). **Both passes report
that the most expensive journey in #343's own evidence is the one the substrate
prices least completely.**

**A5 · Consumer-contract machinery is a keep.** Manifest, three-way reconcile,
backup-and-diff, ownership classification, transactional activation. Pass 1: five
mechanical stations, zero human gates, "the one part of this kit that does not
depend on an agent obeying prose". Pass 2: rank 6, **keep**. No disagreement.

**A6 · Nothing prices the always-on advisory surface.** Pass 2's finding 10 —
`session-start-context-injection`, `guarded-tool-call-block`,
`prompt-and-stop-time-advisory`: **10 stations, 9 mechanical, 0 gates, 0
interactions**, against an inventory of **24 hooks**. Pass 1 reached the same
blind spot from the classifier side (F5: the review method adds gates and
nothing prices them). Under the #343 guideline this is the largest unpriced
surface in the kit: 24 always-on hooks whose cost is *narrowed reasoning*, which
neither pass's metric can see.

---

## B. Each pass found something the other did not

**B1 · Pass 2 only — station rows do not compose.** The single most useful thing
either pass produced about method. A real "small direct path" traverses
`small-direct-path` (3) **plus** `run-the-local-gate` (5) **plus**
`slice-pr-landing` (5) **plus** `session-ends` (4). Naive sum: **17 stations, 4
gates, 5 interactions** — but the substrate has no composition or overlap edges,
so "land" is double-counted and the true price is "neither safely 5 nor safely
17". The same holds for `small-bug-fix-to-merged-and-released` (5) nested with
`release-the-kit` (6). **Every per-journey cost number in this walk — including
all 70 of pass 1's rows — is a fragment price, not an end-to-end price.** Pass 1
priced fragments and did not say so. It is said here.

**B2 · Pass 2 only — `goal-level-delegation-afk-sweep` starts after routing.**
Its first station is `wave-claim`, which already assumes a wave was selected:
**0 of 5 stations verify the transition from a stated outcome to a chosen
route.** Pass 1 answered seed 7 with an entry-point count (`goal-level-delegation`
declared on 24 of 70 journeys) and called outcome-entry "supported". Pass 2 is
right that this measures *declaration*, not the transition. **Seed 7's central
question — does the kit support outcome-entry, or does every path assume the
human picks the skill — is not answered by the substrate, and pass 1 over-read
its own number.** Recorded as a correction to pass 1.

**B3 · Pass 2 only — the mandate's "43 skills" is 44.** Frozen denominator:
**44 logical skills, 36 mirrored, 219 shipped skill files** (`inventory.json`).
Small, and exactly the kind of recalled number the repo's own "counted, not
remembered" rule exists for.

**B4 · Pass 1 only — the kit's own cross-model wrapper is blocked by its own
version pin** (F1). `scripts/codex-exec.sh` refuses `codex-cli 0.146.0` against
an allowlist of three, amended **one day earlier** for `0.145.0`, with the
repository's own evidence file recording that the same guard previously
misattributed a local defect to the environment. Pass 2 could not find this: it
ran *through* the blockage, not into it. Pass 1 found it because it had to
deliver the pass.

**B5 · Pass 1 only — the counted structure of the census.** 173 of 237 stations
are gates (73%); the gate-density upper quartile is exactly **1.0**, with **22
of 70 journeys gates end to end**; the nine recovery journeys carry **23 gates
over 28 stations (82%)** — the phase where an agent most needs room has the
least. Pass 2's narrower gate basis (62) cannot see this shape at all.

**B6 · Pass 1 only — the tiny-fix disproportion.** `small-direct-path` carries
**2 of the census's 52 human gates on 3 stations** — the highest human-gate
density of any seed journey — while `release-the-kit`, six stations ending in an
irreversible publish, carries **1**. Both passes independently proposed deleting
that gate (pass 1 §3.1 / candidate 3; pass 2 candidate 2), but only pass 1
produced the comparison that prices it.

---

## C. What the merge changes about pass 1

Three corrections, all recorded rather than quietly folded in:

1. **F6 is rewritten** — see §D1.
2. **Seed 7 is downgraded** from "outcome-entry is supported" to "the substrate
   does not measure the transition" (§B2).
3. **Every cost row is relabelled a fragment price** (§B1). The 70 rows stand;
   the claim they support is narrower than it looked.

---

## D. Disagreements

### D1 · `land-planning-output` — does landing an ADR require a release?

| | Claim |
|---|---|
| Pass 1, as first written | The coupling is **resolved**; the station table is right and the #343 premise is closed. |
| Pass 2 | The station table **inverts** its own citation: #343 and `docs/agents/skills/orchestrate-wave.md` both say `docs/adr/*` drags a release along, so the journey states a desired future as present fact. |

**Adjudicated empirically, and both passes were partly wrong.**

```
manifest entries 356 · docs/adr 0 · docs/research 0
npm pack payload 388 · docs/adr 0 · docs/ 7
git log -S'"docs/adr' -- agent-workflow-kit.package.json → (no output)
```

`release-delta-guard.mjs:62-72` computes the shipped delta from the manifest and
the npm payload. `docs/adr` is in neither and never has been. **The station table
is right about the mechanism.** But pass 2 is right that a cited source
contradicts it — and the contradicting source is **shipped**:
`docs/agents/skills/orchestrate-wave.md:151-153` tells every consumer that
`docs/adr/*` is in the kit manifest.

The merged finding is better than either input: **a shipped instruction
misprices a journey in the expensive direction**, and one of the seven cost
items in the #343 evidence list rests on the same false premise. Design maxim
applied: *cause before survival* — the sentence keeps a wrong input working.
Full write-up in `fable-pass.md` F6. Pass 1's original claim, and the fact that
it was rewritten after seeing pass 2, are disclosed in that pass's non-coverage
list.

### D2 · Is a traversal proxy admissible at all?

| | Position |
|---|---|
| Pass 1 | Yes, with its blindness declared. Change-traffic over 327 commits, threshold = the population median (9), and the two actor classes it cannot see (`consumer`, `platform`, 23 of 70) classified `unknown` **by rule**. |
| Pass 2 | No. **0 of 266** issue rows, **0 of 135** PR rows and **0 of 64** recovery rows carry a journey id, so nothing in the corpus attributes a traversal to a journey. 69 of 70 → `unknown`. |

Both are correct about the corpus; they disagree about what to do next. Pass 2's
count is exact and pass 1 does not dispute it — pass 1 never used those exports
for attribution, it used git history, which pass 2 did not consider.

**Design maxim adjudication.** *Price the journey, not the rule* requires a
price. *A negative measurement is no proof until the harness has produced a
positive* (`CLAUDE.md` §Diagnosis) cuts the other way for pass 2: declaring
traversal unmeasurable without showing an apparatus that *can* measure one is
exactly the shape that rule was written against. Pass 1's proxy produced a
positive control — it separates `consumer-first-init` (71) from
`resolve-a-merge-conflict` (1) — so it measures *something*, and pass 1 names
precisely what: maintenance churn, not walking.

**Verdict for Slice 3: neither bin set is authoritative.** Pass 1's is usable
and over-precise; pass 2's is honest and unusable. The genuine finding is the
one both passes state and neither can fix: **this kit has no journey-attributed
traversal record, and the classification the mandate asks for cannot be earned
without one.** That is a decision for Slice 3, not a defect of either pass.

### D3 · What counts as a gate?

| | Basis | Count |
|---|---|---|
| Pass 1 | `human-gate` ∪ `platform-gate` ∪ `mechanical` ∪ `platform-enforced` — anything that can refuse passage | **173 of 237** |
| Pass 2 | `human-gate` ∪ `platform-gate` — authorization boundaries only | **62 of 237** |

A factor of 2.8, on the number the whole review is about. Neither is wrong;
they answer different questions. Pass 2 measures *ceremony imposed on a human*.
Pass 1 measures *stations that can stop the work*. Under the #343 guideline —
where the cost of over-specification is **narrowed agent reasoning**, not human
minutes — pass 1's basis is the one that tracks the stated cost, and pass 2's is
the one that tracks the felt cost the mandate opens with ("what does it actually
feel like").

**Both counts are kept.** The AC-1 record fixed pass 1's basis before
classification and it is not retrofitted; pass 2's is recorded beside it. A
Slice-3 reader who wants "how often is a human stopped" reads 52 human gates and
108 non-`none` user decisions; one who wants "how much of this can fail" reads
173.

### D4 · Human-interaction count: 52 or 107?

Pass 1 counts `authorizationBoundary == human-gate` → **52**, keeping
`standing-authorization` (**6**) separate because that is exactly #257's
distinction between a gate that repeats and authority granted once. Pass 2
counts `userDecision` not beginning with `none`, explicitly labelled *an upper
bound, not observed prompt telemetry*, and reports **108**.

Re-counted here against the same predicate: **107**, not 108 — an off-by-one in
pass 2, recorded rather than smoothed over.

```sh
$ node -e '…stations.filter(x => !String(x.userDecision).startsWith("none")).length'
107
```

The gap between the two bases is the informative part: **52 of 237 stations
record a user decision while being neither a human gate nor a platform gate** —
places where the human is expected to think and nothing waits for them. All 52
`human-gate` stations do carry a user decision, so the two counts nest cleanly.
Slice 3 should look at those 52 unattended decisions before it looks at the 52
gates.

### D5 · Where the two cut lists diverge

| Candidate | Pass 1 | Pass 2 |
|---|---|---|
| retro binding | move / make mechanical | **delete** |
| `small-direct-path` depth gate | delete | delete |
| `tdd-red-green-refactor` surface | move into `implement` | — |
| `author-or-improve-a-skill` prose | move into `write-a-skill` | — |
| cross-model hardening as a default | — | **move** behind the deep route |
| S/B/C/P publish mechanics | — | **move** behind one transactional command |
| ADR/research out of the shipped set | — | move |
| `ask-matt` + `scale-check` collapse | — | move |
| `codex-exec.sh` version allowlist | **delete** | — |
| recovery line for 9 unwatched journeys | **add** | — |
| consumer-side signal | decide | — |
| release machinery | keep | keep |

Two shared (`small-direct-path`, and retro in direction if not severity), ten
unshared. Pass 2's list is stronger on **placement** (five `move`s aimed at
always-on doctrine); pass 1's is stronger on **the counted disproportions** and
is the only one proposing an *addition*. Pass 2's ADR/research proposal (rank 5)
is void as written — §D1 shows they are not in the shipped set — but its
underlying instinct survives as the F6 correction.

---

## E. What this merge does **not** do

It promotes nothing. Every valuation in both passes is a labelled hypothesis;
cutting authority is Slice 3's and truth-side promotion is #380's. No issue was
opened, no rule changed, no shipped file touched. The one shipped defect this
walk verified (F6, `docs/agents/skills/orchestrate-wave.md:151-153`) is
**reported, not fixed** — fixing it would drag the release lockstep the finding
is about.

Judgment-pass coverage across both passes: **28 of 70** (pass 1) and **12 of
70** (pass 2), union **28 of 70** — pass 2's twelve are a subset of pass 1's
twenty-eight. **42 of 70 journeys carry a counted cost row from both passes and
a judgment pass from neither**, and they are named individually in
`fable-pass.md` §6 and `classification.json`.
