<!-- language-census: ok -->
# Truth census — Welle 31 / Slice 1 (#380)

A counted census of every codified constraint the kit ships, reporting where a
mechanism produces **fiction**: a red that means no real unsafe state, or a
green that covers nothing.

**Substrate read (never mutated):**
`16325e59f9c1815231f8e37c431881219fac9762` — the Analysis substrate freeze
(#404), whose derivation reads source commit
`c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2`. This census writes only under
`docs/analysis/welle-31/truth-census/`.

## The numbers, in one place

| | |
|---|---:|
| Artifacts accounted for | **633 of 633** |
| Rules extracted (the denominator) | **4 116** |
| Rules mechanically reviewed | 4 116 of 4 116 |
| Rules read-reviewed (stratified sample) | 687 of 4 116 |
| Calibration disagreement, frozen rubric r3 | **16.2%** (threshold ≤20%) |
| Findings | **623** — 507 `hypothesis`, 110 `unknown`, **6 `keep`**, **0 `cut`** |
| `no-finding` | 3 493 |
| Journeys / stations examined | **70 of 70** / **237 of 237** |
| Cited-promise gaps | **109** (G1 30 · G2 8 · G3 0 · G4 71) |
| **The one number** — refuted / eligible planning claims, pooled, +90 d | **0.325** (68 / 209) |
| Positive control | **went red** (C1, C2 fail 3/3 under the recorded mutation) |

## Read in this order

| File | What it settles |
|---|---|
| `preconditions.md` | AC 1 — fixture commit, positive control and its known defect, both windows, adjudicator, evidence exports |
| `rubric.md` | the frozen rubric r3: columns, mechanical signal table, worked examples from verified items only |
| `calibration.md` | the double review, the three rounds (25.9% → 60.4% rejected → 16.2% frozen), and the independence limitation named |
| `findings.md` | what the pass found, and the six promoted findings in full |
| `journey-gaps.md` | the journey pass: gaps counted only for cited promises |
| `metric.md` | the one number, its mapping, its unobserved bound, and every counter-control |
| `unexamined.md` | what this pass did not examine, counted |
| `fixtures/hypothesis-set.md` | the unverified items — they calibrate nobody |
| `board-items.md` | the seven board items this pass would file — prepared, **not filed**: this session's `gh` access is read-only |

Machine-readable: `findings.json` · `journey-gaps.json` · `metric.json` ·
`data/*.json` · `controls/*.json`.

## Reproduction — every number re-derives

Run from the repository root, in this order. Nothing writes outside
`docs/analysis/welle-31/truth-census/`; every probe is fixture-only, offline,
and touches no live consumer, registry or worktree.

```sh
B=docs/analysis/welle-31/truth-census

node   $B/lib/extract-rules.mjs            # 4116 rules, 74 files with no rule surface
node   $B/lib/extract-rules.mjs --check    # reproduces every field but censusCommit
node   $B/lib/sample.mjs                   # 687 of 4116, stable-hash draw
node   $B/lib/reviewer-mechanical.mjs --revision r3 --all
node   $B/lib/calibrate.mjs                # r1 25.9% · r2 60.4% · r3 16.2% -> frozen
node   $B/lib/run-reproductions.mjs        # R1/R2/R3, 3 repetitions each
node   $B/lib/run-counter-control.mjs      # positive control first, then the kit
node   $B/lib/retro-yield.mjs              # recount from the frozen export
node   $B/lib/edges.mjs                    # mirror edges reviewed, import edges counted
node   $B/lib/build-findings.mjs           # writes findings.json only if it validates
node   $B/lib/validate-findings.mjs        # VALID: 623 findings
node   $B/lib/journey-gaps.mjs             # 237 of 237 stations
node   $B/lib/metric.mjs --issues <gh-issues.json> --prs <gh-prs.json>
```

`lib/metric.mjs` needs two read-only `gh` responses; the exact argv, row count
and sha256 of the ones used are recorded in `metric.json` → `inputs`. The
bodies are not copied into the repository — the digest pins them.

### The validator's own negative control

`cut`/`keep` without a well-formed promotion object is **rejected
mechanically**, not reviewed and waved through. Five malformed findings, five
rejections:

```
REJECTED — keep without promotion:          verdict keep without a promotion object is schema-invalid
REJECTED — cut without promotion:           verdict cut without a promotion object is schema-invalid
REJECTED — cut promoted by reproduction:    a cut is promoted by ablation alone, not by reproduction
REJECTED — keep promoted by 1 incident:     repeated-incident promotion needs >= 2 occurrences
REJECTED — hypothesis carrying a promotion: hypothesis must carry promotion: null
```

## What this census does not claim

- **No cuts.** A CUT is promoted by `ablation` alone; this round ran none. The
  absence is enforced by the validator, not by restraint.
- **No statement about delivered software quality.** Measured by no control
  here and claimed by none.
- **No proof that the safety floor held** — only that no incident was
  *recorded*, with the scanner's positive control alongside the zeros.
- **No claim of independent double review.** One model, two instruments; the
  limitation is stated in `calibration.md` rather than dressed up.

## What it does claim

Six findings with commands and output behind them, one of which was found by
the counter-control turning on the machinery it was pointed at; a journey pass
over every station with a resolver that can prove it says no; and one number
with its floor, its ceiling, and the measurement defect that was caught and
corrected on the way to it.
