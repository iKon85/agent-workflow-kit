---
name: census-update
description: "Build, refresh, or check an optional project-local census. Use when a user invokes census-update, asks to establish a counted surface census, or needs to reconcile census drift; scan facts in the current repository, guide only ambiguous decisions, and activate a verified candidate transactionally."
---

# Census Update

Build and maintain the current repository's consumer-owned census through the
public API in `scripts/census/index.mjs`. Keep this skill a thin coordinator:
do not copy, rename, or reimplement the scanner, state, delta, fingerprint, or
transaction logic.

## Boundaries

- Work only in the current repository. Never inspect another project, aggregate
  cross-project findings, learn shared recipes from other repositories, or
  propose an upstream kit change.
- Treat code as the source of facts. Never ask the user which files, paths, or
  patterns exist.
- Ask only for one genuinely ambiguous decision at a time. Include a concise
  recommendation and the evidence behind it.
- Keep generated scanners, tests, profiles, decisions, and the active census in
  the consumer repository. Do not add a dependency without explicit approval.

## Public mechanism

Import only the stable exports from `scripts/census/index.mjs`:
`scanCensus`, `serializeCensus`, `fingerprintCensus`,
`CENSUS_BUILDER_VERSION`, `diffCensus`, `CENSUS_STATES`, `CENSUS_VERDICTS`,
`resolveCensusState`, `activateCensus`, and `CensusTransactionError`.

Resolve the consumer's project-local census profile and active-census path. If
no profile exists, report `bootstrap` and stage a consumer-owned profile rather
than silently enabling a gate. Preserve any existing local path convention.

## Workflow

1. **Check.** Read the local profile and active census, if present. Report a
   missing profile as `bootstrap`; otherwise derive one
   of `disabled`, `bootstrap`, `current`, `refresh_required`, `updating`, or
   `failed` through the public API. An explicit opt-out is disabled. Do not
   write during this step.
2. **Scan facts.** Call `scanCensus` once with the current repository root.
   Product code and production configuration form the surface denominator;
   tests and docs remain evidence. Let the scanner exclude secrets, ignored,
   generated, and vendored content. Never read excluded content to explain a
   result.
3. **Show the delta.** For an active census, call `diffCensus` and show only
   added, changed, removed, and open names. Do not dump the full scan unless the
   user asks. For bootstrap, show the discovered families and counts.
4. **Resolve ambiguity.** Recommend a decision for each ambiguous behavior or
   surface and ask separately. Record the user's decision with its evidence.
   `nicht relevant` requires a durable justification. Never infer it silently. <!-- language-census: ok -->
5. **Handle unknown patterns locally.** Keep an unknown surface `offen`. It can
   become `abgedeckt` only after this repository contains a small local scanner
   and a focused passing test for that pattern. Run that test before rescanning.
6. **Verify a candidate.** Build the candidate from the fresh scan and recorded
   decisions. Fail verification when any surface or behavior remains `offen`,
   when a required local scanner test fails, or when the candidate fingerprints
   do not describe the current repository.
7. **Activate.** Call `activateCensus` with a real verifier so it stages, verifies,
   and atomically swaps under its local lock. On `CensusTransactionError`, report
   `updating` or `failed` and keep the previous active census authoritative.
8. **Prove the result.** Report surface coverage as `X of Y`, then render the
   behavior overview separately. State the resulting census state and the
   builder version.

## Decision rules

- Store a justified `nicht relevant` verdict as a visible decision beside the <!-- language-census: ok -->
  candidate; do not erase the family from the overview.
- A change-local override may suppress a known mechanical false-positive in
  the displayed delta only when its reason and scope are visible. It must not
  alter scanner facts, fingerprints, `offen` verdicts, or state resolution, so
  real drift can never become `current` through an override.
- Any unexpected product area stays `offen` and therefore prevents `current`,
  even if every known area is covered.
- Facts discovered after a decision invalidate that decision's stale premise;
  rescan and ask again only if the remaining choice is genuinely ambiguous.

## No-write and recovery proof

Before activation, compare the fresh candidate with the active census using
the public fingerprints and deterministic `serializeCensus` output. If the
repository and decisions are unchanged and the derived state is `current`,
report `current` and do not call `activateCensus` or write any file.

If scanning, a local test, verification, or activation fails, report `failed`,
discard the candidate when safe, and confirm that the previous active census
bytes are unchanged. Never manufacture `current` after an error.

## Final report

Return only the useful audit trail:

- state and builder version;
- compact delta;
- surface coverage `X of Y`;
- separate behavior overview;
- visible `nicht relevant` justifications and active override, if any; <!-- language-census: ok -->
- local scanner tests run and the transaction/no-write result.
