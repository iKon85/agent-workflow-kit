<!-- language-census: ok -->
# The one number — refuted planning claims / eligible planning claims (#380 §6)

Machine-readable: **`metric.json`** (every claim, its program, its observation
time and its refutation time).

## Headline, fixed in advance

**Size-weighted pooled ratio over the long-tail (+90 d) window: 0.325 —
68 refuted of 209 eligible planning claims.**

Pooled means `sum(refuted) / sum(eligible)` across programs, so a 30-slice
program weighs fifteen times a two-slice wave. That was declared before the
computation, and it is reported whether or not the per-program median is
kinder — it is: 0.25.

| Statistic | Value |
|---|---|
| **Headline — pooled, +90 d** | **0.325** (68 / 209) |
| Immediate, +14 d | 0.325 (68 / 209) |
| Per-program median, +90 d | 0.25 |
| Programs with a denominator | 31 |
| Zero-denominator programs, excluded as `n/a` | 0 |
| Refutation events (multiplicity) | 68 |
| Mean events per refuted claim | 1.0 |

### The two windows returned the same number, and that is a finding

The longest lag between a planning claim and its recorded refutation across this
repository's whole observable history is **8 days**. At this repository's age
the long-tail window is not yet a different measurement from the immediate one.
The headline stays the long-tail as declared — choosing the other one *after*
seeing both is exactly the reduction that "fixed in advance" exists to prevent —
but the equality should be read as "the instrument has not yet had time to
separate them", not as "planning failures surface immediately".

## By meaning

| | Meaning | Eligible | Refuted | Ratio |
|---|---|---:|---:|---:|
| **M1** | a slice was declared executable without further decision | 128 | 43 | **0.336** |
| **M2** | the slices under this anchor were declared independent and completely decomposed | 25 | 13 | **0.520** |
| **M3** | this slice's blast radius is the declared set | 29 | 11 | **0.379** |
| **M4** | planning for this anchor is complete | 27 | 1 | **0.037** |

M2 is the number to look at: **more than half** of the anchors whose
decomposition was declared complete later acquired a follow-up issue or a plan
revision. M4 near zero is not the good news it looks like — it says almost
nothing gets tracked *after* an anchor closes, which is a statement about the
carrier, not about planning.

## Semantic event mapping v1

The metric is defined over **meanings**; today's carriers are mapped onto them
by a versioned layer, so a v1.0.0 rename moves the carrier without zeroing the
metric.

| Meaning | Eligible-claim carrier today | Refutation carrier today |
|---|---|---|
| M1 | issue labelled `ready-for-agent` | its own body carries `plan_revision` beyond r1, or a `type:followup` issue names it |
| M2 | `type:cluster` / `type:program` with at least one child naming it | a `type:followup` naming the anchor after it opened, or `plan_revision` beyond r1 |
| M3 | a `## Blast-Radius` block with a readable estimate **and** a merged PR closing exactly that one issue | the merged PR changed more than 2× the estimate — the kit's own STOP threshold |
| M4 | a closed anchor | a `type:followup` naming the anchor, created after it closed |

**Atomic claims.** An issue carrying both `ready-for-agent` and a
`## Blast-Radius` block carries two claims, counted separately. No fractional
weights: a compound claim is split, never scored partially.

**A measurement defect caught and fixed mid-pass, recorded.** The first M3
implementation attributed a wave-landing PR's whole changed-file count to every
issue it closed. Result: 67 changed files charged against ten separate one-to-
three-file estimates, and an M3 ratio of **0.88**. That is the census
manufacturing its own finding. M3 now counts only PRs that close exactly one
issue; the other **114 claims are dropped into the unobserved bound**, not into
the numerator. The corrected M3 is 0.379 over 29 eligible claims. This is
recorded because a metric that only shows its final pipeline is the same fiction
as a guard that only shows its greens.

## Observable denominator, and the unobserved-claim bound

The metric counts only claims that left a record. Transient planning
conversation, a decision made and revised inside one session, and a toppled
assumption carried in the gitignored `ANNAHMEN.md` leave none. Calling 0.325
"the refutation rate of every planning claim" would be the same fiction this
anchor hunts.

Sensitivity, where `f` is the unobserved share of the *true* claim population,
bounded by the two extremes (unobserved claims never refuted / always refuted):

| Unobserved share | Low bound | Observed point estimate | High bound |
|---:|---:|---:|---:|
| 10% | 0.293 | 0.325 | 0.393 |
| 25% | 0.244 | 0.325 | 0.494 |
| 50% | 0.163 | 0.325 | 0.663 |

At an unobserved share of 50% the true ratio lies between half the observed
value and the observed value plus one half. **The metric is a floor with a wide
ceiling.**

Additionally excluded from the denominator, and named rather than silently
dropped: **114 M3 claims** whose blast radius cannot be attributed at slice
resolution because the landing PR closed several issues at once.

## Observability loss — tracked next to the metric

Removing a carrier removes *opportunities to record a refutation*, and would
otherwise read as improvement:

- removing `ready-for-agent` removes the M1 denominator (128 claims), not the
  failures it counts;
- removing the `plan_revision` marker removes the M1/M2 refutation carrier;
- removing the `## Blast-Radius` block removes M3 entirely;
- removing `type:followup` removes the **only** cross-anchor refutation carrier
  (M2 and M4);
- no carrier exists today for "the assumption a sibling slice carried was
  toppled" — `ANNAHMEN.md` is gitignored by design, so that meaning is
  unobservable and lives in the unobserved bound, never as a zero.

## Counter-controls — independent of the metric and of the machinery under review

A mechanism may not serve as a control while it is a cut candidate in the same
cycle. The counter-control is therefore the **consumer contract**, replayed on a
frozen fixture: `init` → consumer edits → `update`, checked on four properties.

| Check | Shipped (consumer edit present) | Shipped (no conflict) | Positive control |
|---|---|---|---|
| C1 an untouched installed file fast-forwards | **fail 0/3** | pass 3/3 | **fail 0/3** |
| C2 a consumer-edited file keeps consumer bytes and is reported | pass 3/3 | pass 3/3 | **fail 0/3** |
| C3 the project layer is not overwritten | pass 3/3 | pass 3/3 | pass 3/3 |
| C4 the consumer manifest is byte-stable across a repeated update | pass 3/3 | pass 3/3 | pass 3/3 |

**The positive control went red** — C1 and C2 fail on all three repetitions
under the recorded one-line mutation, which is what makes the shipped run's
greens evidence rather than decoration. C1's shipped failure is promoted finding
#5 in `findings.md`.

Post-landing correctness is judged after merge by construction here: every claim
in the metric is read from merged pull requests and closed issues, never from a
plan's own promise about itself.

**Safety incidents on the predeclared definition** — tracked work lost, a
protected branch bypassed, a wrong artifact published, consumer files
overwritten without backup — scanned over the whole recorded corpus (266 issues,
135 merged pull requests):

| Class | Candidates | On inspection |
|---|---:|---|
| tracked work lost | 3 | issue#197, issue#40 (program bodies naming the risk), pr#389 (a fix that *prevented* it) |
| protected branch bypassed | 0 | — |
| wrong artifact published | 3 | issue#391, #252, #243 — release-integrity design issues, not incident reports |
| consumer files overwritten without backup | 1 | issue#380 — this mandate itself |

**Seven candidates, zero recorded incidents.** Every hit is a text match on
design language about the risk, and one of them is this census's own issue body.
The scanner carries its own positive control: each of the four patterns is run
against a synthetic sentence that must match, and all four do
(`metric.json` → `safetyFloor.scannerPositiveControl`), so the zeros are the
scanner working rather than the scanner asleep.

What this does **not** establish: that no incident occurred. None of the four
classes has a mechanical detector in this repository, so the count measures the
absence of a *record*. #205's lesson is exactly that shape — a red run does not
prove nothing was published.
