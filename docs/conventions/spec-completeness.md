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

## Excess — the excess criterion

The counterpart of completeness: completeness asks what is missing, this asks
what is too much. **Would a senior engineer read this and call it
overcomplicated?** Every mechanism kept or added — a rule, a gate, a guard, an
abstraction, a config knob, a checklist item — needs an **observed incident**
behind it, never a conceivable one.
**Over-engineering is a defect of the same severity as a hole** — an unearned
mechanism is reported like a missing requirement, and neither is waived because
the other side reads clean.

This is the single definition. Every reviewing surface points here instead of
restating it.

## Self-Critique-Check

**Trigger:** Always.

**Check:** Does every mechanism this spec keeps or adds name the observed
incident that demands it?

**Korrektur:** Cut the mechanism, or name its incident in the spec. Report an
unearned mechanism at the severity a missing requirement would get.

