<!-- language-census: ok -->
# Blocking preconditions — truth census (#380 AC 1)

**Recorded before the pass started.** #380 §8 names five execution-time facts
the mandate deliberately does not invent and without which the pass may not
begin. This file records them with artifact paths. Adjudicator recorded in the
anchor: **Niko, 2026-07-28** (#403).

| Precondition | Value | Artifact |
|---|---|---|
| Fixture commit | `320dece903a09ee63588d9b050713f8f0a63b594` — the branch base, the merge of the Analysis-substrate freeze `16325e5` | `controls/counter-control.json` → `fixtureCommit` |
| Code identity under test | `src/` tree `7143160ed66ae6efd562ec1b3966ceb09d6a2c39`, `scripts/` tree recorded in `controls/reproductions.json` | `controls/counter-control.json` → `srcTree` |
| Positive-control commit | the same fixture commit **plus one recorded mutation** | `controls/counter-control.json` → `positiveControl.mutation` |
| Positive-control known defect | `src/lib/updateReconcile.mjs`: `const userEdited = current !== prior.installedSha256;` → `const userEdited = false;` — reconcile treats every destination as untouched, so a consumer-edited file is silently overwritten | same |
| Window lengths | immediate **+14 d**, long-tail **+90 d**; the headline is the long-tail | `metric.json` → `headlineDefinition`, `WINDOWS` |
| Adjudicator | **Niko** (recorded 2026-07-28, #403) | `data/calibration.json` → `adjudicator` |
| Evidence exports | committed by Slice 0 before this pass: `docs/evidence/welle-31/issue-bodies.json`, `docs/evidence/welle-31/aggregate-queries.json`, `docs/evidence/2026-07-28-codex-exec-version-pin.md`, each with sha256 in `docs/evidence/welle-31/README.md` | consumed read-only; **this census writes nothing under `docs/evidence/`** |

## The positive control is a named mutation, not a historical commit

#380 §6 asks for "a **positive control** on a known-defect repo, because a
control that never goes red is not evidence". Two ways to get one: check out a
historical commit that carried a real defect, or apply one recorded mutation to
the pinned tree.

This pass takes the second, and says so rather than implying the first. A
historical commit drags in every other difference of that tree, so a red result
would not be attributable to the defect under control. The mutation is one line,
recorded verbatim with its file and its defect statement, applied to a **copy**
of `src/` in a temp directory — the repository under review is never modified.
The harness refuses to run if the mutation no longer applies, so a silent
"control passed because the line moved" is impossible.

**It went red.** Checks C1 and C2 fail on all 3 repetitions under the mutation
and the harness reports `valid: true` only because they do:

```sh
node docs/analysis/welle-31/truth-census/lib/run-counter-control.mjs
# positive control went red: true [ 'C1', 'C2' ]
```

## Windows, and what they turned out to measure

+14 d and +90 d were fixed before the metric ran. They returned the **same
number** (0.3254): the longest lag between a planning claim and its recorded
refutation in this repository's whole observable history is **8 days**
(`metric.json` → `claims`). At this repository's age the long-tail window is not
yet a different measurement from the immediate one. The headline stays the
long-tail as declared — picking the other one now, after seeing both, is exactly
the reduction the "fixed in advance" rule exists to prevent.

## Ablation preconditions — declared, and not met

§7 requires fixtures only, destructive journeys never ablated live, a positive
control first, ≥3 repetitions, and a directional vector over
correctness/safety/recovery/friction with cross-surface evidence before a CUT
generalizes. **This round ran no ablation**, therefore it promotes **no CUT**.
`lib/validate-findings.mjs` rejects a `cut` whose promotion is anything but an
`ablation` carrying all of those fields, so the absence is mechanical rather
than a matter of restraint.
