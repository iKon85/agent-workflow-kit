<!-- language-census: ok -->
# AC 1 — the measurement record, fixed before the classification pass

Slice #343 (Welle 31 · Slice 2 — cost walk) · anchor #403 · Amendment 3.
Written and committed **before** any journey was classified, so that the
thresholds cannot be tuned to the answer they produce.

Substrate commit (the journey denominator, Amendment 1):
`c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2`.
Denominator: **70 journeys**, verbatim from
`docs/analysis/welle-31/substrate/journeys.json`. This walk re-derives no
journey and no entry point; it adds cost columns.

## 1. Traversal-frequency source query

```sh
git -C <repo> log --no-merges \
  --since=2026-07-03T00:00:00Z --until=2026-07-29T00:00:00Z \
  --name-only --format=%x00%H \
  c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2
```

**Population: 327 commits.** A commit is *attributed* to journey `J` when it
touches at least one path in `J`'s **specific path set** — the repository paths
cited by `J`'s station table (`promise.citation`) and by `J`'s `derivedFrom`,
kept only if they exist at the freeze commit.

The population is pinned to the substrate's own freeze commit, for the same
reason `derive-inventory.mjs` pins its own: landing this analysis must not be
able to move its own denominator.

### Hub-path rule

A path cited by **more than 10 of the 70 journeys** is a hub, not a journey
signature — attributing every commit that touches `CLAUDE.md` to every journey
that cites it would attribute the whole repository to half the census. Hub paths
are excluded from attribution and reported separately in
`cost-rows.measurement.hubPaths`.

**At this freeze the rule fires zero times: 0 hub paths.** The most-shared cited
path stays at or below 10 journeys. The rule is kept and counted at zero rather
than dropped, because a rule that disappears when it is empty cannot be
falsified later (same convention as the substrate's `pr-recorded-stop-and-rerun`
recovery class).

### What this proxy can and cannot see — declared, not discovered later

This is **change-traffic**, not telemetry. It counts how often the machinery a
journey runs on was *changed* inside this repository during the window. It is a
proxy for traversal and it is wrong in a specific, nameable way:

- **It is blind for `consumer` and `platform` actors.** A consumer walks
  `init`, `update` or `diff` in *their* repository; that leaves no commit here.
  A platform journey is a workflow run, and runs are not commits. For those
  **23 of 70** journeys (consumer 17, platform 6) the number the query returns
  measures maintainer churn on the machinery, not how often the journey was
  walked. They are therefore classified `unknown` **by rule** — a measurement
  verdict, never a value verdict.
- **It over-reports churn-heavy machinery.** `consumer-first-init` scores the
  population maximum (71 commits) because `src/` churned, not because 71
  consumers ran `init`.
- **A lower bound exists elsewhere and is deliberately not used as a bin
  input:** the frozen corpus records **135 merged pull requests**
  (`docs/evidence/welle-31/aggregate-queries.json`, `merged-pr-retro-marker`),
  which bounds `ci-required-check-on-a-pull-request` from below at 135
  traversals. Wiring that in would mean one hand-authored attribution rule per
  platform journey — enumerating the case instead of the principle. It is
  recorded here as evidence and left out of the classifier.

No number in this walk is presented as measured traversal. Every one of them is
attributed change-traffic, and the classifier only ever asks whether it is above
or below one threshold.

## 2. UTC window

`2026-07-03T00:00:00Z` → `2026-07-29T00:00:00Z` (exclusive upper bound).

Chosen to match the frozen issue corpus, not chosen freely: the earliest
`createdAt` in `process-issue-population` (266 rows) is
`2026-07-03T07:51:59Z` and the latest is `2026-07-28T21:29:55Z`. The cost window
and the evidence window are therefore the same 26 days, and no finding can rest
on a commit whose issue counterpart is outside the corpus.

## 3. Traversal threshold

**high traversal ⇔ attributed commits ≥ 9.**

Derived, not picked: 9 is the **median of the attributable population** (70
journeys, distribution min 1 · median 9 · max 71). Fixing the rule as "the
median" and recording the value it produced keeps both halves falsifiable — a
re-run on a different window recomputes the number, and this record says what
the number was here.

Two supporting quartiles, computed the same way over all 70 journeys and
recorded before use:

| Quantity | Rule | Value at this freeze |
|---|---|---|
| high traversal | median of the attributable population | **9 commits** |
| top-quartile gating | 75th percentile of the per-journey gate count | **3 gates** |
| gate density, upper quartile | 75th percentile of gates ÷ steps | **1.0** |
| gate density, lower quartile | 25th percentile of gates ÷ steps | **0.667** |

The gate-density quartiles are recorded for completeness and are **not** used by
the classifier: at this freeze the upper quartile is 1.0 — 22 of 70 journeys are
gates end to end — so density cannot separate anything. The classifier uses the
absolute gate count instead. That degeneracy is itself the first cost finding of
this walk, and it is recorded here rather than quietly worked around.

## 4. Gate-count basis

A station counts as a **gate** when it can refuse passage:

```
gate  ⇔  authorizationBoundary ∈ {human-gate, platform-gate}
      ∨  bindingHardness      ∈ {mechanical, platform-enforced}
```

Everything else — `documented`, `judgment` hardness with an
`agent-autonomous` or `consumer-owned` boundary — is a **step**: it shapes what
the agent does, but nothing fails it.

Two narrower counts are kept beside it and never folded in:

- **human interaction** ⇔ `authorizationBoundary == human-gate` — a stop the
  human must personally clear at the moment it is reached.
- **standing authorization** ⇔ `authorizationBoundary == standing-authorization`
  — authority granted once and reused. Keeping it apart from `human-gate` is the
  exact distinction #257 draws when it rules that one confirmed Semver
  authorizes metadata, merge, tag and publish; folding the two together would
  make a solved repetition look like an unsolved one.

Counted at this freeze: **237 stations · 173 gates · 52 human interactions ·
6 standing authorizations** over 70 journeys.

## 5. Classification bins and their values — fixed here, applied later

Four bins (Amendment 3), evaluated in this precedence order. The first rule that
matches wins, so every journey lands in exactly one bin.

| # | Bin | Rule |
|---|---|---|
| 1 | `unknown` | actor ∈ {`consumer`, `platform`} → traversal is not observable from this repository (§1) |
| 2 | `unwatched` | `gates == 0` (nothing can fail it), **or** traversal ≥ 9 **and** the journey carries no named recovery record (`recoveryPaths == ["unknown-recovery"]`) |
| 3 | `secured-out-of-proportion` | `gates ≥ 3` (top-quartile gating) **and** traversal < 9 |
| 4 | `covered-and-priced` | everything else |

`unknown` sits first on purpose. A bin that is reached only after the other
three have declined is a residue; a bin that is reached first is a claim, and
the claim here is that a third of this kit's journeys cannot be priced from
inside the repository that ships them.

## 6. Output artifacts

| Path | What it holds |
|---|---|
| `docs/analysis/welle-31/cost-walk/ac-1-measurement-record.md` | this record |
| `docs/analysis/welle-31/cost-walk/derive-cost.mjs` | stage 1 — the counted cost row (`--check` re-derives byte-equal) |
| `docs/analysis/welle-31/cost-walk/cost-rows.json` | **the cost table: one counted row per journey, 70 of 70** |
| `docs/analysis/welle-31/cost-walk/classify.mjs` | stage 2 — applies §5 verbatim (`--check` re-derives byte-equal) |
| `docs/analysis/welle-31/cost-walk/classification.json` | the four bins, per journey, with the rule that fired |
| `docs/analysis/welle-31/cost-walk/cost-table.md` | the human-readable cost table |
| `docs/analysis/welle-31/cost-walk/fable-pass.md` | primary pass — findings, judgment questions, per-pass note |
| `docs/analysis/welle-31/cost-walk/codex-pass/` | second primary source — prompt, raw transcript, per-pass note |
| `docs/analysis/welle-31/cost-walk/two-model-merge.md` | the merge, incl. every disagreement |

## Standing limitation

Every valuation downstream of this record is a **labelled hypothesis**. This
slice prices; it does not cut. Cutting authority is Slice 3's.
