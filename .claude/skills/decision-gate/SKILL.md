---
name: decision-gate
description: Resolve a bounded trade-off choice or a targeted research gap with read-only investigation, a documented weigh-up, and a reasoned decision. Use when a plan or slice hinges on a concrete "which option" choice or a "need to research this first" gap that is above a binary yes/no fact (verify-spike) but below a high-stakes, hard-to-reverse, ADR-worthy decision (grill-with-docs-codex). Output is a trade-off table plus a justified pick sunk into an ADR/issue/comment. NOT for binary fact-checks (verify-spike), open-ended design feel (prototype), or bug root-cause (diagnose).
---

# Decision Gate

A decision-gate resolves **a bounded "which option" choice — or a targeted research gap — with evidence, not a hunch.** You have two or more candidate approaches (or one approach you cannot yet commit to), the call is small enough that a full design-grill is overkill, but it is more than a single yes/no fact. The gate makes the choice **documented and defensible** instead of decided in your head.

This is the "Architecture Decisions — best-practice first" rule at small scale: when a slice carries a real trade-off or an unresearched assumption, do the read-only legwork, lay the options side by side, and write down the pick with its reasons before any build slice depends on it.

## When this and not another skill

<!-- mirror-xform:start codex-escalation -->
| You are deciding… | Skill |
|---|---|
| "Which of these options, given these trade-offs?" / "I need to research this before I can choose." (bounded, sub-grill) | **decision-gate** |
| "Is this one fact true against the real lib / runtime / DB / platform?" (binary yes/no) | `verify-spike` |
| "Is this high-stakes / hard-to-reverse / ADR-worthy?" (auth, schema, concurrency, migrations, payments) | `grill-with-docs-codex` |
| "Does this design / state model / UI feel right?" (open-ended exploration) | `prototype` |
| "Why is this broken / slow?" (root-cause of a known defect) | `diagnose` |
<!-- mirror-xform:end -->

<!-- mirror-xform:start codex-escalation -->
Threshold check, both directions: if the choice is **binary and empirically settleable**, drop down to `verify-spike`. If it is **high-stakes or hard-to-reverse** (a central seam, a one-way door, an ADR), escalate up to `grill-with-docs-codex` — do not let a real architecture decision hide in a decision-gate.
<!-- mirror-xform:end -->

## Steps

1. **Frame the options and the criteria.** Name the competing approaches (or the single unresearched approach) as a short list, and the axes the choice turns on — e.g. complexity, blast radius, performance, reversibility, fit with existing patterns. Write down what "good" looks like on each axis *before* you research, so the pick is not retrofitted to a foregone conclusion.
2. **Research/measure read-only, per option.** Gather evidence for each option against the real thing — read the consuming code (`grep`/Read), the actual lib/runtime behaviour, an official doc/best-practice source, or a quick throwaway measurement. Borrow the feedback-loop toolkit from `diagnose` Phase 1 for any measurement. Read-only: no schema/migration/shared-state writes; if you need numbers, measure against a scratch read, never mutate.
3. **Lay it out as a trade-off table.** Options × criteria, one row per option, with a **cited cell** (a `file:line`, a measured value, a doc link) — not an adjective. An empty or hand-waved cell means that option is not actually researched yet.
4. **Decide and sink it durably, with reasons inline.** State the chosen option and *why it wins on the criteria that matter*, plus what you consciously traded away. Sink it where the decision lives — an ADR (if it grew ADR-worthy, reconsider escalating), the issue body, the plan, or a PR comment — with the trade-off evidence attached so a later reader trusts the pick without redoing the research.
5. **Delete throwaway measurement code.** Any scratch probe built in step 2 is thrown away (or folded into real code). The *decision + its table* is the only keeper; nothing throwaway rots in the repo (`prototype`'s closing rule).

## Rules

1. **Read-only.** No schema changes, no migrations, no writes to a shared/prod resource. Research and measurement only; a DB question hits a read or a scratch row.
2. **Evidence per cell, not assertion.** "Option A is faster/cleaner" is not a trade-off — the measured number, the `file:line`, the doc is. A table of adjectives is an unresearched guess in a table costume.
3. **Decide — do not just survey.** The output is a *pick with reasons*, not a neutral menu. Name what you traded away so the runner-up's strengths are on record. A genuine tie on the criteria that matter is a finding, not a license to coin-flip: default to the most reversible option and say why, or surface the tie to the user as an outcome question.
4. **Scope honestly.** The decision holds for the options and context you weighed. State that scope so a new option or a changed constraint re-opens the gate instead of inheriting a stale pick.
<!-- mirror-xform:start codex-escalation -->
5. **Respect the threshold.** Mid-gate, if it turns high-stakes or hard-to-reverse → stop and escalate to `grill-with-docs-codex`; if it collapses to one binary fact → drop to `verify-spike`. The gate is for the bounded middle, not a place to quietly settle a big decision.
<!-- mirror-xform:end -->
