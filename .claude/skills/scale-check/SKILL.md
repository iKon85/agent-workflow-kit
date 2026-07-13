---
name: scale-check
disable-model-invocation: true
description: "Route an undertaking to the right altitude before any planning starts — a short plain-language dialog (3–6 questions) deciding between a Program, a Feature, a single Direct-Slice, or a Bug, then hand back a paste-ready start prompt for the chosen route. Use at the very start of a new build when the size is unclear (a new app, a big cross-cutting feature, or a where-do-I-start question). Owns the altitude criteria catalog; when in doubt it routes to Feature. NOT for slicing a chosen plan (to-issues) and NOT for clustering an existing backlog (board-to-waves)."
---

# scale-check — Route an undertaking to its altitude

Answers one question in plain language: **"how big is this, and where do I start?"**
The output is a **verdict** (Program / Feature / Direct-Slice / Bug), the **route**
that fits it, and a **paste-ready start prompt** for that route. No requirements
interview, no code, no board writes — this is a routing dialog, not a planning
skill.

This skill is the **single owner of the altitude criteria catalog** below. Other
skills only *reference* it — a backlog-grooming pass escalates a candidate that
trips the program criteria, and the skill router names it as the first step for a
new build without a clear size. Keep the catalog here and cite it from there;
never fork a second copy.

## When to reach for it

- A new undertaking whose size is genuinely unclear — greenfield app, "a bunch of
  related work", a feature that might be bigger than one feature.
- Someone asks "where do I start?" / "is this a program?" / "do I need a PRD?".
- **Not** when the size is already obvious: a one-line fix goes straight to a
  Direct-Slice, a known bug straight to a diagnosis — you can skip the dialog and
  hand back that route directly.

## The dialog — 3 to 6 plain-language questions

Ask **one question at a time**, in plain language (no PM jargon), and recommend an
answer where the person hesitates. Stop early once the verdict is unambiguous (two
program criteria already tripped, or an obvious single-slice/bug). Each answer maps
to the criteria catalog below.

1. **Is this fixing something that used to work, or building something new?**
   → "fixing" ends the dialog: **Bug** route.
2. **In one sentence, what should exist at the end that doesn't today?**
   (Frames the whole thing in outcome language — everything below hangs off this.)
3. **Does it arrive in one go, or in several stages you'd ship and learn from
   separately** (a first usable version, then expansions)?
4. **Is it one clear area of the app, or several parts that each stand on their
   own** (a whole new app counts as "several")?
5. **Realistically, is this a handful of focused changes, or many separate work
   sessions stretching over a longer horizon — and does its shape need big
   structural calls locked before day one** (data model, phasing, cross-area
   sequencing) **that would be expensive to revisit mid-build?**
6. **Are there distinct acceptance stages** — e.g. a pilot that has to pass before
   a wider rollout — **that gate what comes after them, and would progress only
   make sense as a rollup across many waves rather than one issue's status?**

Questions 3–6 are the four program-signal probes, each reaching two of the six
altitude criteria (3→C1, 4→C2, 5→C3+C5, 6→C4+C6); question 1 catches bugs,
question 2 anchors the outcome. You rarely need all six.

## Altitude criteria (the single source of truth)

Count how many of these the undertaking trips. **Two or more → Program route.**
Fewer than two → it is a Feature (or smaller). **When it is borderline or you are
unsure, route to Feature, never Program** — an emergent wave can always be promoted
later, but program scaffolding you never needed is pure waste, and the Feature
route can grow into a program the moment a second criterion clearly trips.

- **C1 — Staged delivery.** It ships in several successive stages (a first usable
  version, then expansions), not a single release.
- **C2 — Multiple subsystems.** It spans several parts that each stand on their own,
  or is a whole new app (greenfield), not one feature area.
- **C3 — Long horizon.** It realistically needs many separate build sessions/waves,
  not a handful of slices.
- **C4 — Acceptance gates.** It has distinct acceptance stages (pilot → rollout,
  phase gates) that gate later work.
- **C5 — Upfront structure decisions.** Its shape needs structure-bearing decisions
  locked before the first build day (data model, phasing, cross-area sequencing) —
  decisions that would be expensive to revisit mid-build.
- **C6 — Program-level overview.** Progress only makes sense as a rollup across many
  waves, not as one issue's status.

A single criterion is a strong Feature that may grow; **two or more is the program
threshold**. The threshold is deliberately low and the tie always breaks to Feature.

## Verdicts, routes, and start prompts

Report the verdict, which criteria tripped (for a Program) or why it stayed below
threshold, and the matching paste-ready start prompt. All four routes are existing
skills — this skill only picks the entry point.

### Program (≥2 criteria)

A multi-wave undertaking: grill it once into a Program-PRD with a wave plan, then
unfold that plan onto the board after a chat preview gate.

```
New program: <one-sentence outcome from Q2>.
Tripped altitude criteria: <e.g. C1 staged delivery, C2 multiple subsystems, C4 gates>.
1. Run a program grill with `grill-with-docs` — lock scope → phases → waves and any
   structure-bearing decisions (escalate a single bounded choice to `decision-gate`).
2. `to-prd` — it auto-detects the program mode from the Wellenplan chapter and writes
   a Program-PRD (native anchor over the waves).
3. `to-waves` — after one complete chat preview, materialize the whole Program with
   **all waves execute-ready by default**: complete slice contracts, buckets,
   dependencies and handoffs. Decision Gates, Verify Spikes and Design-Grill waves
   are explicit planned exceptions; generic late-binding cleanup is not.
```

### Feature (0–1 criteria, or any doubt)

One coherent feature — the standard single-wave line, unchanged.

```
New feature: <one-sentence outcome from Q2>.
`grill-with-docs` (sharpen the terms + decisions) → `to-prd` (publish the Draft-PRD)
→ `to-issues` (slice it into independently buildable tracer-bullet slices).
```

### Direct-Slice (a single, well-understood change)

One behavior, already clear enough to build — no PRD, no slicing.

```
Small change: <one-sentence behavior>.
`tdd` — one behavior at a time, red → green → refactor. No PRD, no decomposition.
```

### Bug (something that used to work)

```
Bug: <what's broken — expected vs. actual>.
`diagnose` — reproduce, minimize, hypothesize, instrument, fix, regression-test.
```

## Output shape

```
scale-check: verdict=<Program | Feature | Direct-Slice | Bug>
  criteria tripped=<C1,C2,… | none | n/a (bug/direct)>
  route=<program grill → to-prd → to-waves (all waves execute-ready by default) | grill-with-docs → to-prd → to-issues | tdd | diagnose>
  start-prompt: <the paste-ready block above, filled in>
```

Make the doubt-default visible: if it landed on Feature only because it was
borderline, say so — "one criterion tripped (C2); routed to Feature by the
tie-breaks-to-Feature rule — promote a wave later if a second one clearly appears."
