# A Model roster replaces the optimization dial

Status: accepted (2026-07-27, Program #287, Welle 18 / #294) — supersedes the
Routing-policy clause of
[ADR-0006](./0006-routing-knowledge-access-and-policy-are-separate.md)

ADR-0006 made "optimization goals and optional advanced overrides" inputs of
the Routing policy, and setup asked the user to pick Balanced, Quality, or
Cost. That dial cannot be made to work. The goal is always the right model for
the job, and a cheap-but-weak model can cost more per completed task than a
strong one — so a Cost dial does not express a preference the resolver can act
on without knowing cost per *completed* task, which no benchmark owner
publishes. Meanwhile the dial was never read: `readRoutingProfile` has zero
callers and `resolveRoute` always returns `routing-infrastructure-missing`.

We decided the user control is a **Model roster** — a positive list of
model-and-effort pairs the user authorizes — plus three **Standard routes**
that decide when no decisive evidence covers the resolved Routing intent.

1. **The optimization dial is removed everywhere it appears, not only from the
   Routing policy.** The Routing intent loses its optimization goal too. What a
   user is willing to spend is a Routing profile choice, not a property of the
   work; leaving the field in the intent while the resolver ignores it would
   leave a dead concept in the domain language. The glossary entry and the
   intent schema both drop it.
2. **`unreachable` and `missingInfrastructure` are kept.** They are unrelated to
   the dial, and the resolver's fallback semantics depend on them.
3. **Transport authorization belongs to the Routing profile.** Selecting Claude
   Code and Codex does not authorize either to drive the other's CLI. ADR-0006
   is already explicit that a detected transport is not an approved one; this
   ADR names where the approval is stored — the global profile document, as its
   own interview answer, narrowable per project by intersection only.
4. **The Routing policy is derived, not stored.** The profile is the stored
   personal choice and carries no revision. The policy is the constraint object
   derived from profile plus inventory for one dispatch, and it carries the
   composed revision so a Dispatch receipt can prove which constraints applied.
5. **Cost is displayed and used as a tiebreak inside a cohort of identical
   currency and unit — never as the ranking motor.** This is what the Cost dial
   was reaching for, at the only altitude where it is honest.
6. **The Kit ships no opinion about which models are good.** Excluding a model
   is one user's preference under one subscription, not a default truth. The
   inventory stays unfiltered per ADR-0006; the roster authorizes.

## `inherit` is retained, and the condition that would have removed it

This ADR was drafted to remove `inherit` entirely if verify-spike 18c (#296)
could not prove that the session-default model-and-effort pair is readable back
and identifiable against the roster. **The spike came back positive, so
`inherit` is retained** in the constrained form: inheritance is permitted only
when the session-default pair is attested *and* inside the effective roster,
and otherwise blocks.

The condition under which `inherit` is removed entirely therefore stands as a
standing test, not a settled negative: **if the session-default pair ceases to
be readable back on a surface, `inherit` is removed for that surface rather
than left as an unprovable path.** A receipt that cannot name the pair it
inherited is not proof of anything.

The spike qualifies the retention with an identification requirement. One and
the same Claude Code session reports its default model under three different
identifiers — `opus[1m]` in `~/.claude/settings.json`, `claude-opus-5[1m]` in
the session's init event, and `claude-opus-5` in the server-returned
`message.model`. The attested channel is the one that drops the context
variant. Roster identification therefore requires an explicit normalization
rule and a decision on whether the context variant is part of pair identity;
until that rule exists, "identified against the roster" is not a check a
receipt may claim to have made.

## Consequences

- ADR-0006's Routing-policy clause (item 3, "optimization goals and optional
  advanced overrides") and its closing sentence "Model preferences and
  optimization overrides remain optional advanced settings" no longer describe
  the system. The rest of ADR-0006 — the separation of Evidence catalog, Access
  graph, and Routing policy; detection is not authorization; the surface
  adapter capability declaration; the Dispatch receipt requirement — stands
  unchanged and remains the foundation this ADR builds on.
- `advanced.optimization` is removed from the Routing profile schema, and
  `optimization` from the Routing policy schema, each with a deterministic
  version-aware decoder that records the drop rather than silently discarding a
  choice the user made.
- Setup's Balanced / Quality / Cost prompt is replaced by roster admission and
  Standard-route nomination.
- Model-and-effort is pair identity. Effort domains are per model — some models
  support an effort level others do not, and some carry no effort axis at all —
  so a pair is authorized as a pair, never as a model with an effort attached
  afterwards.
