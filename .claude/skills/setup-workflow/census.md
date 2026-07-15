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

The table below is the machine-checkable reference contract for setup. The
paths under `retain` are consumer-owned evidence. `hook` and `gate` describe
kit-owned enforcement wiring, wherever the consumer documents that wiring;
they are not permission to invent a second setup mechanism.

```json census-setup-effects
[
  {"state":"missing","actor":"setup","choice":"none","profile":"absent","active":"absent","hook":"absent","gate":"absent","selfTest":false,"retain":[],"repeat":"no-write"},
  {"state":"yes","actor":"setup","choice":"yes","profile":"create-minimal","active":"absent","hook":"absent","gate":"absent","selfTest":true,"retain":[],"repeat":"no-write"},
  {"state":"later","actor":"setup","choice":"later","profile":"absent","active":"absent","hook":"absent","gate":"absent","selfTest":false,"retain":[],"repeat":"no-write"},
  {"state":"no","actor":"setup","choice":"no","profile":"absent","active":"absent","hook":"absent","gate":"absent","selfTest":false,"retain":[],"repeat":"no-write"},
  {"state":"existing","actor":"setup","choice":"existing","profile":"preserve","active":"preserve","hook":"preserve","gate":"preserve","selfTest":false,"retain":["profile","active","scanner","scanner-test"],"repeat":"no-write"},
  {"state":"explicit-enable","actor":"census-update","choice":"existing","profile":"enable-transactionally","active":"activate-verified","hook":"enable-after-verification","gate":"enable-after-verification","selfTest":false,"retain":["scanner","scanner-test"],"repeat":"no-write"},
  {"state":"disable","actor":"census-update","choice":"existing","profile":"disable-transactionally","active":"preserve","hook":"remove","gate":"remove","selfTest":false,"retain":["profile","active","scanner","scanner-test"],"repeat":"no-write"}
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

Run only the focused census foundation self-test already shipped with the kit.
A passing self-test proves the mechanism is available, not that this repository
has been scanned. Setup must not install pre-commit, pre-push, CI, planning, or
handoff gates for `yes`, `later`, or `no`.

## Later activation and disable

`later` and `no` are setup choices, not partially active censuses. A later,
explicit `census-update` invocation is the sole activation route: it may create
or adopt the profile, then scan and call `activateCensus` only after its normal
verification succeeds. Setup itself never calls `activateCensus`.

Disable enforcement before changing consumer content. Update the profile
transactionally to `enabled: false`, verify the derived state is `disabled`,
and remove only kit-owned gate wiring. Treat local scanners, their tests, the
profile, and the active snapshot as consumer-owned evidence. List those files
and ask for separate deletion approval; without that approval, retain them.
Setup never deletes consumer-owned files as part of disable.

## Setup report

Report the choice, adopted or created paths, derived state, self-test result,
and whether enforcement changed. Name every action skipped on an idempotent
rerun. Never claim surface coverage during setup: only `census-update` can
produce a verified `X of Y` result.
