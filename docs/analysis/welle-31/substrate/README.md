<!-- language-census: ok -->
# Analysis substrate — Welle 31 (#404)

Frozen at source commit `c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2`, 2026-07-29.

This is the shared substrate the two censuses of Welle 31 read: the truth census
(#380, Slice 1) and the cost walk (#343, Slice 2). It is a **prep slice** — it
derives, counts and freezes. **It produces no verdicts.** Nothing here says a
promise is kept or broken; the columns are laid out so that the later slices can
say it with evidence.

Everything below is a number somebody else can re-derive. Each one names the
exact command that produces it, and every command is re-runnable from the
repository root.

## Artifacts

| File | What it is | Derivation |
|---|---|---|
| `inventory.json` | scripted inventory, four partitions (#380 §1) | `node docs/analysis/welle-31/derive-inventory.mjs` |
| `dimensions.json` | the four keyed dimensions | authored; validated by the census |
| `journeys.json` | 70 derived journeys + the eight #343 seeds | authored; validated by the census |
| `stations.json` | 237 station rows, columns verbatim from #380 §5 | `node docs/analysis/welle-31/derive-stations.mjs` |
| `census.json` | the counted census below, as data | `node docs/analysis/welle-31/derive-census.mjs --json` |

Standing evidence lives one directory over, in `docs/evidence/welle-31/`, with
its own digest table.

## Counted census — journeys

```sh
node docs/analysis/welle-31/derive-census.mjs
```

- **70 journeys derived, of which 10 carry one of the eight #343 seeds** — 8 of
  8 seeds covered, none uncovered. Ten rather than eight because seed 5
  ("I release / I update a consumer") is three distinct journeys with three
  distinct terminals: `release-the-kit`, `consumer-update-over-local-edits`,
  `consumer-kit-update-skill`. The remaining 60 journeys are derived from the
  evidence sources named on each journey, not recalled from the seed list —
  which is the point of #343's "journey discovery precedes journey walking".
- **Consumer-as-actor: 17 of 70**, including the three the mandate names
  explicitly — first `init` (`consumer-first-init`), first own workflow
  (`consumer-first-own-workflow`), first `update` over local edits
  (`consumer-update-over-local-edits`).
- **Recovery journeys: 9 of 70.** Each has its own entry points, which is why it
  is a journey and not a station variant (#380 §5).
- **Journeys with no named recovery record: 34 of 70**, carrying
  `unknown-recovery` rather than an invented recovery path.
- **Actors:** maintainer 29, agent 18, consumer 17, platform 6 (of 70).

## Counted census — the four dimensions

Four dimensions, keyed and disjoint. The census fails if one id appears in two
of them — an entry point is *how* a journey starts, an evidence source is *where
the journey was derived from*, a recovery path is *which named record backs a
recovery branch*. Conflating them lets a derivation launder its own provenance.

```sh
node docs/analysis/welle-31/derive-census.mjs      # axis counts + disjointness
python3 -m json.tool docs/analysis/welle-31/substrate/dimensions.json
```

**Entry-point axis — 7 entry points over 70 journeys** (a journey may carry
several):

| Entry point | Journeys |
|---|---|
| `direct-skill-invocation` | 54 of 70 |
| `canonical-pipeline` | 40 of 70 |
| `codex-surface-entry` | 39 of 70 |
| `question-turned-work` | 26 of 70 |
| `goal-level-delegation` | 24 of 70 |
| `external-worktree-session` | 13 of 70 |
| `ask-matt-routing` | 8 of 70 |

**Evidence-source axis — 10 source classes:** `shipped-skill-description` 48,
`issue-pr-event` 18, `board-status-label-event` 14, `cli-command` 13,
`package-lifecycle-script` 12, `github-workflow` 9, `recovery-record` 9,
`hook-event` 8, `consumer-reconcile-command` 6, `agents-surface` 1 (of 70).

**Recovery-path axis — 5 record classes:** `unknown-recovery` 34,
`documented-recovery-path` 28, `recovery-labelled-issue` 11, `retro-finding` 8,
`pr-recorded-stop-and-rerun` **0** (of 70). The last is declared and carries no
journey at this freeze: the searched population
(`recovery-record-sources` in the evidence export) produced no journey whose
recovery is recorded that way. It is kept declared and counted at zero rather
than dropped, because a class that disappears when it is empty cannot be
falsified later.

## Counted census — station tables

```sh
node docs/analysis/welle-31/derive-stations.mjs --check   # reproduces byte-equal
node docs/analysis/welle-31/derive-census.mjs             # station counts
```

- **237 stations over 70 journeys**, 3–6 per journey.
- **237 of 237 carry a cited promise**; 0 uncited.
- Columns are #380 §5's, verbatim and in order: `journey_id · station_id ·
  promise (cited) · what it actually verifies · binding hardness · phase · user
  decision · agent action · authorization boundary · recovery relation`.
- **Binding hardness:** mechanical 118, documented 95, platform-enforced 13,
  judgment 11 (of 237).
- **Phase:** verify 48, plan 42, build 38, recover 32, intake 28, land 22,
  close 19, publish 8 (of 237).
- **Authorization boundary:** agent-autonomous 117, consumer-owned 52,
  human-gate 52, platform-gate 10, standing-authorization 6 (of 237).
- **Recovery relation** encodes #380 §5's rule mechanically: a branch is
  `variant-of:<journey>#<station>` unless it has its own entry point, in which
  case it is `escalates-to:<journey>` and that journey must be a recovery
  journey with entry points of its own. `derive-stations.mjs` refuses to emit a
  table where a relation target does not resolve.

## Counted census — citations

**413 of 417 citations resolve** (`derive-census.mjs`). A citation resolves when
its head is a repository path that exists on disk, or an issue number frozen in
`docs/evidence/welle-31/issue-bodies.json`. The remaining 4 are prose citations
(for example "board profile labels.waveStub") and are counted as unresolvable by
design rather than silently passed.

## Counted census — scripted inventory (#380 §1)

```sh
node docs/analysis/welle-31/derive-inventory.mjs --check
```

The denominator is a query, never a directory listing: the population is
`git ls-tree -r --name-only <sourceCommit>`, and every partition boundary comes
from a shipped declaration — `collectBundle()`, `HELPER_FILES`, `STUB_TARGETS`
and `isPublishExcluded()` in `src/lib/bundle.mjs`, plus the skill manifest.

- **633 tracked artifacts** at the freeze commit; partition closure 633 of 633.
- **Kit Core: 159** — hooks 24, docs 8, templates 4, scripts 99, plus `src/`.
- **Shipped surface: 219** skill files.
- **Maintainer-only: 228.**
- **Consumer-owned project extension: 16.**
- **Residual, named not dropped: 11** — 8 published docs that carry no rule
  surface, 2 repo-metadata files, 1 analysis artifact (this wave's own
  `docs/evidence/2026-07-28-codex-exec-version-pin.md`). 0 unclassified.
- **Install manifest: 356 files** — skill 219, script 101, hook 24, doc 8,
  template 4. `HELPER_FILES` 137, `STUB_TARGETS` 10.
- **Logical skills: 44** — 36 mirrored on both surfaces, 7 Claude-only, 1
  Codex-only.

**Against the magnitudes #380 expected** (24 hooks, 96 scripts, 8 docs, 4
templates, 44 logical skills): hooks 24 ✓, docs 8 ✓, templates 4 ✓, logical
skills 44 ✓. **Scripts return 101, not 96** — the query counts every manifest
entry of kind `script`, of which 2 carry `installRole: maintainer`. The
substrate reports what the query returns and does not reconcile the expectation;
adjudicating the 5 is a census question, not a substrate one.

## Reproduction — what re-runs, and what a re-run means

A counted number nobody can re-derive is a defect. The three derivations
reproduce; the fourth is a freeze and says so.

| Command | Reproduction |
|---|---|
| `node docs/analysis/welle-31/derive-inventory.mjs --check` | every field but `derivedAt`; the population is pinned to the artifact's own `sourceCommit`, so landing this analysis cannot move the denominator |
| `node docs/analysis/welle-31/derive-stations.mjs --check` | byte-equal |
| `node docs/analysis/welle-31/derive-census.mjs --json \| diff - docs/analysis/welle-31/substrate/census.json` | byte-equal |
| `node docs/analysis/welle-31/export-evidence.mjs` | **does not reproduce by design** — it fetches live bodies and stamps each with its fetch time. Its freeze is verified by digest instead: `node docs/analysis/welle-31/verify-evidence.mjs` re-runs each recorded `gh` argv and compares sha256. 17 of 17 matched on 2026-07-29. |

`derivedAt` is the only excluded field, and it is excluded for the only honest
reason: no re-run can reproduce a past instant. Every counted field is compared.

## Substrate hygiene

`derive-census.mjs` exits non-zero on any substrate defect and prints the list:
dimension ids appearing in two dimensions, a journey referencing an undeclared
dimension id, a duplicate journey or station id, a journey without a station
table, an uncovered seed, or a citation that does not resolve. At this freeze it
reports `PROBLEMS: none`.
