<!-- setup-workflow: state=filled -->
# Convention — Spec completeness before implementation

## Self-Critique-Check

**Trigger:** A spec states a concrete count, quantity, or `N of M` claim.

**Check:** Is each number freshly derived from the source rather than estimated or recalled?

**Korrektur:** Recount from code and replace the claim, or mark it explicitly as an implementation-time assumption.

## Vertical-slice completeness

Every user-facing slice is an outcome tracer, carries at least one acceptance criterion, names its estimated blast radius, and identifies seam ownership. Every prep slice names the omitted half and the later slice that closes it. `to-issues` must re-derive this readiness rather than trusting a pre-cut table.

## Self-Critique-Check

**Trigger:** A spec contains a wave/slice table or decomposes into multiple issues.

**Check:** Are rows outcomes rather than layer names, and do enablers name the outcome wave that closes them?

**Korrektur:** Reword or split layer-only rows and make every deferred half explicit.

