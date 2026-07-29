<!-- language-census: ok -->
# Cost table — one counted row per derived journey (70 of 70)

**Generated** by `classify.mjs`. Do not hand-edit — re-run
`node docs/analysis/welle-31/cost-walk/classify.mjs` instead.

Substrate commit `c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2` · journey denominator **70 of 70** (the substrate's set, verbatim — Amendment 1).

Column meanings and every threshold are fixed in
[`ac-1-measurement-record.md`](./ac-1-measurement-record.md), committed before this table existed.

- **steps** — stations on the journey
- **gates** — stations that can refuse passage (human-gate/platform-gate, or mechanical/platform-enforced)
- **human** — stations the human must personally clear · **standing** — authority granted once and reused
- **traversal** — attributed change-traffic (commits in the window touching this journey's specific paths); *not* telemetry, and blind for consumer/platform actors
- **artifacts** — distinct repository paths this journey's stations cite
- **failure modes** — issue numbers cited by the station table or the journey derivation

## Totals

| Quantity | Count |
|---|---|
| journeys | 70 |
| stations (steps) | 237 |
| gates | 173 |
| human interactions | 52 |
| standing authorizations | 6 |
| journeys with a named recovery record | 37 of 70 |
| journeys citing at least one issue | 16 of 70 |
| commits in the traversal population | 327 |

## Classification

| Bin | Journeys |
|---|---|
| `covered-and-priced` | 29 of 70 |
| `unwatched` | 10 of 70 |
| `secured-out-of-proportion` | 8 of 70 |
| `unknown` | 23 of 70 |

Judgment pass covers **28 of 70** journeys; the remaining **42** are named in `classification.json` under `judgmentPass.namedNonCoverage` and in `fable-pass.md`.

## `covered-and-priced` — 29 of 70

| Journey | Actor | Seed | steps | gates | human | standing | traversal | recovery | artifacts | failure modes |
|---|---|---|---:|---:|---:|---:|---:|---|---:|---|
| `slice-pr-landing` | agent | — | 5 | 3 | 1 | 0 | 45 | named | 4 | — |
| `session-ends` | agent | seed-6 | 4 | 2 | 1 | 0 | 31 | named | 3 | #320 #343 |
| `land-planning-output` | maintainer | seed-4 | 3 | 2 | 0 | 0 | 27 | named | 2 | #343 |
| `plan-to-executable-slices` | maintainer | seed-3 | 4 | 4 | 2 | 0 | 26 | named | 3 | #341 #343 |
| `worktree-create-and-bind` | agent | — | 4 | 3 | 0 | 0 | 26 | named | 4 | — |
| `small-direct-path` | maintainer | seed-8 | 3 | 2 | 2 | 0 | 24 | named | 2 | #343 |
| `goal-level-delegation-afk-sweep` | maintainer | seed-7 | 5 | 3 | 1 | 2 | 24 | named | 3 | #343 |
| `cross-model-plan-hardening` | maintainer | — | 3 | 3 | 2 | 0 | 23 | named | 3 | — |
| `delegate-build-to-codex` | maintainer | — | 4 | 3 | 2 | 0 | 19 | named | 3 | — |
| `release-the-kit` | maintainer | seed-5 | 6 | 6 | 1 | 3 | 18 | named | 5 | #205 #243 #257 |
| `small-bug-fix-to-merged-and-released` | maintainer | seed-2 | 5 | 4 | 0 | 1 | 14 | named | 5 | #205 #243 #257 #343 |
| `anchor-reconcile-on-slice-event` | agent | — | 3 | 2 | 0 | 0 | 13 | named | 3 | — |
| `recovery-guard-false-red-blocks-capability` | maintainer | — | 3 | 1 | 1 | 0 | 13 | named | 2 | — |
| `worktree-teardown` | agent | — | 3 | 3 | 1 | 0 | 11 | named | 3 | #320 |
| `program-graph-decomposition` | maintainer | — | 4 | 4 | 2 | 0 | 10 | named | 6 | #322 |
| `recovery-wrong-branch-commit` | agent | — | 3 | 3 | 1 | 0 | 9 | named | 2 | — |
| `domain-grill-and-context-update` | maintainer | — | 3 | 2 | 2 | 0 | 8 | none | 2 | — |
| `router-recommends-a-starting-point` | maintainer | — | 3 | 2 | 2 | 0 | 8 | none | 1 | — |
| `bug-diagnosis-to-regression-test` | agent | — | 4 | 2 | 1 | 0 | 6 | named | 2 | — |
| `sync-the-codex-mirror` | maintainer | — | 3 | 2 | 0 | 0 | 6 | none | 3 | — |
| `scale-check-route-a-new-build` | maintainer | — | 3 | 2 | 2 | 0 | 5 | none | 1 | — |
| `two-axis-code-review` | agent | — | 4 | 2 | 1 | 0 | 5 | none | 2 | — |
| `verify-a-fact-before-plan-lock` | agent | — | 4 | 2 | 2 | 0 | 4 | named | 1 | — |
| `resolve-a-bounded-tradeoff` | maintainer | — | 3 | 2 | 2 | 0 | 4 | none | 2 | — |
| `improve-codebase-architecture` | agent | — | 3 | 2 | 1 | 0 | 4 | none | 1 | — |
| `security-audit-of-the-app` | maintainer | — | 3 | 2 | 1 | 0 | 4 | named | 2 | — |
| `kit-build-and-staleness-check` | maintainer | — | 3 | 2 | 0 | 0 | 4 | named | 3 | — |
| `design-a-deep-module` | agent | — | 3 | 1 | 1 | 0 | 2 | none | 2 | — |
| `prototype-a-design` | agent | — | 3 | 2 | 2 | 0 | 1 | none | 1 | — |

## `unwatched` — 10 of 70

| Journey | Actor | Seed | steps | gates | human | standing | traversal | recovery | artifacts | failure modes |
|---|---|---|---:|---:|---:|---:|---:|---|---:|---|
| `recovery-interrupted-afk-run` | maintainer | — | 3 | 3 | 1 | 0 | 28 | none | 3 | — |
| `research-a-question` | agent | — | 3 | 1 | 1 | 0 | 26 | none | 2 | — |
| `audit-the-skill-surface` | maintainer | — | 3 | 2 | 0 | 0 | 20 | none | 3 | — |
| `prd-maturation` | maintainer | — | 3 | 2 | 1 | 0 | 14 | none | 3 | — |
| `idea-to-board-issue` | maintainer | seed-1 | 3 | 1 | 0 | 0 | 11 | none | 3 | #343 |
| `recovery-board-status-drift` | agent | — | 3 | 3 | 1 | 0 | 11 | none | 3 | — |
| `wayfinder-chart-a-foggy-effort` | maintainer | — | 3 | 3 | 3 | 0 | 10 | none | 2 | — |
| `inbound-triage-to-agent-ready` | maintainer | — | 3 | 1 | 0 | 0 | 9 | none | 3 | — |
| `backlog-to-waves-clustering` | maintainer | — | 3 | 2 | 2 | 0 | 9 | none | 1 | — |
| `spec-self-critique-before-review` | agent | — | 3 | 0 | 0 | 0 | 5 | none | 2 | — |

## `secured-out-of-proportion` — 8 of 70

| Journey | Actor | Seed | steps | gates | human | standing | traversal | recovery | artifacts | failure modes |
|---|---|---|---:|---:|---:|---:|---:|---|---:|---|
| `run-the-local-gate` | agent | — | 5 | 4 | 0 | 0 | 8 | named | 4 | — |
| `recovery-red-release-run-but-published` | maintainer | — | 4 | 3 | 2 | 0 | 8 | named | 2 | #205 |
| `author-or-improve-a-skill` | maintainer | — | 4 | 4 | 0 | 0 | 7 | none | 4 | — |
| `recovery-awaiting-tag-stacked-bump` | maintainer | — | 3 | 3 | 1 | 0 | 7 | named | 1 | #243 |
| `recovery-anchor-closed-early` | maintainer | — | 3 | 3 | 1 | 0 | 7 | named | 2 | #341 |
| `retro-after-a-session` | maintainer | — | 3 | 3 | 2 | 0 | 6 | named | 1 | — |
| `tdd-red-green-refactor` | agent | — | 3 | 3 | 0 | 0 | 4 | none | 1 | — |
| `resolve-a-merge-conflict` | agent | — | 3 | 3 | 1 | 0 | 1 | named | 1 | — |

## `unknown` — 23 of 70

| Journey | Actor | Seed | steps | gates | human | standing | traversal | recovery | artifacts | failure modes |
|---|---|---|---:|---:|---:|---:|---:|---|---:|---|
| `consumer-first-init` | consumer | — | 4 | 3 | 0 | 0 | (71) | named | 4 | — |
| `consumer-setup-workflow-project-layer` | consumer | — | 3 | 2 | 0 | 0 | (43) | named | 3 | — |
| `consumer-update-over-local-edits` | consumer | seed-5 | 5 | 5 | 0 | 0 | (37) | named | 7 | — |
| `consumer-diff-inspection` | consumer | — | 3 | 2 | 0 | 0 | (31) | none | 4 | — |
| `consumer-first-own-workflow` | consumer | — | 4 | 0 | 0 | 0 | (28) | none | 2 | #343 #380 |
| `consumer-uninstall` | consumer | — | 3 | 3 | 0 | 0 | (27) | none | 4 | — |
| `consumer-routing-profile-decision` | consumer | — | 3 | 2 | 0 | 0 | (24) | none | 4 | — |
| `consumer-ownership-override` | consumer | — | 3 | 2 | 0 | 0 | (23) | none | 4 | — |
| `recovery-update-conflicts-with-local-edits` | consumer | — | 3 | 2 | 0 | 0 | (22) | named | 3 | — |
| `consumer-kit-update-skill` | consumer | seed-5 | 3 | 2 | 0 | 0 | (21) | named | 2 | — |
| `consumer-contribution-bridge` | consumer | — | 3 | 2 | 0 | 0 | (20) | none | 3 | — |
| `guarded-tool-call-block` | platform | — | 4 | 3 | 0 | 0 | (11) | named | 5 | — |
| `recovery-teardown-blocked-by-symlinks` | consumer | — | 3 | 2 | 1 | 0 | (9) | named | 2 | #380 #2305 |
| `tag-triggered-publish` | platform | — | 4 | 4 | 1 | 0 | (8) | named | 2 | #257 |
| `consumer-automated-update-pr` | consumer | — | 3 | 2 | 0 | 0 | (5) | none | 2 | — |
| `consumer-census-establish` | consumer | — | 3 | 2 | 0 | 0 | (5) | named | 4 | — |
| `prompt-and-stop-time-advisory` | platform | — | 3 | 3 | 0 | 0 | (5) | none | 5 | — |
| `consumer-project-release` | consumer | — | 3 | 2 | 0 | 0 | (4) | none | 3 | — |
| `session-start-context-injection` | platform | — | 3 | 3 | 0 | 0 | (4) | none | 5 | — |
| `consumer-memory-lifecycle` | consumer | — | 3 | 2 | 0 | 0 | (3) | named | 2 | — |
| `ci-required-check-on-a-pull-request` | platform | — | 3 | 3 | 0 | 0 | (2) | named | 1 | — |
| `pages-site-publish` | platform | — | 3 | 3 | 0 | 0 | (2) | none | 2 | — |
| `consumer-setup-pre-commit` | consumer | — | 3 | 2 | 0 | 0 | (2) | none | 2 | — |

A traversal number in parentheses is **not** a traversal measurement: the
actor walks outside this repository, so the figure is maintainer churn on the
machinery and nothing more (AC-1 record §1).
