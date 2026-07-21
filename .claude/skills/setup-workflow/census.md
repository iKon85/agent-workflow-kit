# Optional project census

The census is a consumer-owned, counted map of product surfaces and behavior
families. It is optional. Setup records only the user's choice; `census-update`
does the factual scan, resolves ambiguity, verifies a candidate, and activates
the result transactionally.

## Setup state matrix

| State or choice | Setup action | Observable result on repeat |
|---|---|---|
| `missing` | Explain the census in plain language and ask `yes / later / no`; do not infer an answer. | Ask again only while no choice has been recorded; write no hook or gate. |
| `yes` | Create the minimal consumer-owned profile, or adopt the existing documented profile path. Set `enabled: true`, keep the active snapshot absent, run only the shipped census self-test, and report `bootstrap` / "not yet meaningful". | Adopt the same profile byte-for-byte; do not rescan, activate, or add another self-test. |
| `later` | Record a retryable deferral outside the active profile. | Leave census files, hooks, and gates absent; an ordinary setup rerun is a no-op, while an explicit `census-update` may activate later. |
| `no` | Record an explicit opt-out with census state `disabled`. | Keep the opt-out and do not create census files, hooks, or gates. |
| `existing` | Adopt the repository's explicitly documented profile and active-snapshot paths without replacing consumer-owned content. Derive its state through the public census API. | Preserve every existing byte and report the derived state. |
| `explicit-enable` | On a later explicit `census-update` invocation, let that skill scan, decide, verify, and transactionally activate without rerunning setup. | An unchanged verified census reports `current` and performs no write. |
| `disable` | Set the profile to `enabled: false` transactionally and remove census hooks/gates from enforcement. | Stay `disabled`; retain consumer-owned profiles, scanners, tests, and snapshots unless the user separately approves their deletion. |

## Deterministic setup effects

The table below is the machine-checkable reference contract for setup. Its
ordered `operations` are the only effects the setup proof may execute. Choice
persistence always means `docs/agents/census.md`: the normal setup sentinel is
the first line and `<!-- census: choice=<yes|later|no> -->` is the second.
Paths under `retain` are consumer-owned evidence. Enforcement operations refer
only to kit-owned wiring documented by the consumer; they are not permission to
invent another census engine.

```json census-setup-effects
[
  {"state":"missing","actor":"setup","choice":"none","operations":[],"retain":[],"repeat":"no-write"},
  {"state":"yes","actor":"setup","choice":"yes","operations":["reconcile-choice-doc","reconcile-minimal-profile","derive-state","run-foundation-self-test"],"retain":[],"repeat":"no-write"},
  {"state":"later","actor":"setup","choice":"later","operations":["reconcile-choice-doc"],"retain":[],"repeat":"no-write"},
  {"state":"no","actor":"setup","choice":"no","operations":["reconcile-choice-doc","derive-state"],"retain":[],"repeat":"no-write"},
  {"state":"existing","actor":"setup","choice":"recorded","operations":["adopt-choice-doc","derive-state"],"retain":["choice-doc","profile","active","scanner","scanner-test"],"repeat":"no-write"},
  {"state":"explicit-enable","actor":"census-update","choice":"recorded","operations":["delegate-census-update","run-census-update-contract"],"retain":["choice-doc","profile","active","scanner","scanner-test"],"repeat":"no-write"},
  {"state":"disable","actor":"census-update","choice":"recorded","operations":["remove-kit-hook","remove-kit-gate","update-profile-disabled","derive-state"],"retain":["choice-doc","profile-unknown-keys","active","scanner","scanner-test"],"repeat":"no-write"}
]
```

## Bootstrap profile

When `yes` creates the default `.census/profile.json`, write the deterministic
profile shape documented by `census-update`: `schemaVersion: 1`, `enabled:
true`, and empty `decisions`, `localScanners`, and `overrides` arrays. Do not
create `.census/active.json`. Its absence is the evidence that the honest state
is `bootstrap`, not `current`.

Before writing, check for an existing repository convention and adopt it. A
pre-existing profile remains consumer-owned: preserve unknown keys and do not
replace its decisions. Never derive `current` from file presence; use
`resolveCensusState` from `scripts/census/index.mjs`.

Run the focused `scripts/census/state.test.mjs` census foundation self-test
already shipped with the kit.
A passing self-test proves the mechanism is available, not that this repository
has been scanned. Setup must not install pre-commit, pre-push, CI, planning, or
handoff gates for `yes`, `later`, or `no`.

## Later activation and disable

`later` and `no` are setup choices, not partially active censuses. A later,
explicit `census-update` invocation is the sole activation route. Setup
delegates this route to the shipped `census-update` contract and its focused
`scripts/test_census_update_contract.test.mjs` proof; it does not reproduce
activation, snapshots, or enforcement. Setup itself never calls `activateCensus`.

Activation owns durable enforcement: every focused test declared by the active
profile must remain transitively reachable through one shared project-local
census check entry point from both local CI and pre-push. `census-update`
reconciles that narrow kit-owned census wiring idempotently and requires an
executable wiring proof before it can report `current`; setup does not pre-wire
the optional bootstrap state.

Disable follows the ordered contract: remove only the kit-owned census wiring
(including the kit-owned hook and gate block), then atomically replace only the
profile's `enabled` value with `false`, preserving unknown keys, and verify
`disabled` through `resolveCensusState`. Enforcement removal must finish before
any profile mutation. Treat the choice document, local scanners, their tests,
the profile, and the active snapshot as consumer-owned evidence. List those
files and ask for separate deletion approval; without that approval, retain them.
Setup never deletes consumer-owned files as part of disable.

## Setup report

Report the choice, adopted or created paths, derived state, self-test result,
and whether enforcement changed. Name every action skipped on an idempotent
rerun. Never claim surface coverage during setup: only `census-update` can
produce a verified `X of Y` result.
