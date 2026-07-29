<!-- language-census: ok -->
# Standing evidence — Welle 31 (Analysis substrate, #404)

Frozen 2026-07-29 from source commit `c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2`.

Live issue and pull-request bodies mutate independently of any commit, so a
census that cites them cites a moving target (#380 "Standing evidence"). These
exports freeze what the two censuses may cite. Both censuses read this
directory; neither re-fetches, and neither mutates it.

Re-derive with:

```sh
node docs/analysis/welle-31/export-evidence.mjs
```

Every export carries the exact `gh` argv that produced it, the fetch timestamp,
the byte length and the sha256 of the untouched stdout — so a later reader
re-runs the command and compares digests rather than trusting a summary.

The exporter cannot re-derive its own output: it fetches live bodies and stamps
each with a fetch time, so a second run differs by construction. The freeze is
verified by digest instead:

```sh
node docs/analysis/welle-31/verify-evidence.mjs
```

It re-runs every recorded `gh` argv read-only and compares sha256 against the
recorded digest, then re-hashes both export files against the table below.
**17 of 17 recorded commands still returned the frozen bytes on 2026-07-29** —
including the three private-repository items, whose digests verify without their
bodies ever being published here.

## Files

| File | sha256 |
|---|---|
| `issue-bodies.json` | `6ca520df255cac1851372e234a9e289e6b783e9b714eff94d95540a534812b02` |
| `aggregate-queries.json` | `7a2e494c81a371b22816fac23368f83d4429a9a60ce8af8080c5f88318f1a6ab` |

## Referenced items — 14 of 14 exported

Eleven items from this public repository are exported with their full response
body: #205, #243, #257 (release-integrity lineage), #320, #322, #341 (cost
evidence), #343, #380, #403, #404, #405 (the wave itself).

Three items come from the private consumer repository the mandate cites
(`2305`, `2312`, `2283`). They are exported **digest-only**.

### Named deviation — private bodies are withheld, not exported

`#380` asks for each referenced issue body to be exported here. This repository
is public and that consumer repository is not, so a literal export would
publish private content — which no census finding needs and no consumer
consented to. The exporter therefore records, for each private item, the
immutable URL, the fetch timestamp, the response byte length and the sha256 of
the untouched response, and withholds the body.

What this preserves: the freeze itself. The digest pins the exact text as of
the fetch, and any reader with repository access re-runs the identical command
and compares. What it costs: a reader without that access cannot read the body
from this repository. That is a property of the source, not of the export — the
item was never publicly readable. The three items' technical content is already
summarized in the public body of #380 and may be cited from there.

## Aggregate queries — 3 of 3 exported

Each aggregate is declared as a **projection query**, so the committed stdout is
the raw response rather than a summary of one. Counts below are computed from
exactly those rows.

### `merged-pr-retro-marker` — 135 rows

The retro-yield observation #380 carries. Over 135 merged pull requests:

| Bin | Count |
|---|---|
| `**Retro:** ran` | 12 |
| `**Retro:** skipped` | 52 |
| `**Retro:**` present, other value | 10 |
| line absent | 61 |
| body carries a `Meta` heading | 2 |
| body carries a `Meta`/`Retro`/`Findings` heading | 14 |

Two predicates are frozen for the findings side, not one verdict. `metaSection`
is the carrier `CLAUDE.md` documents ("findings go into a Meta section of the PR
body"); `findingsHeading` is a deliberately wider net. Which one the yield ratio
should use is a census question, and the substrate does not settle it.

The population has grown since #380 recorded `128 / 69 / 8`: the merged-PR
denominator is now **135**, the enforced marker appears on **74** (12 + 52 + 10),
and the findings side reads **2** under the strict predicate or **14** under the
wide one. The substrate does not reconcile the drift — it replaces recall with a
re-runnable command, which is the point.

### `process-issue-population` — 266 rows

The empirical record of journeys actually taken (#343: "issue history is the
dataset"). 230 closed, 36 open at freeze time.

### `recovery-record-sources` — 64 rows

The searched population for recovery journeys (#380 §5: recovery journeys are
bounded to named record sources). The search terms are part of the committed
command. Exhaustiveness is not claimed: a recovery journey with no record in
this population is classified `unknown-recovery` in the journey set, and the
sources searched are exactly the ones this query names.
