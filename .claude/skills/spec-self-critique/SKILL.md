---
name: spec-self-critique
description: "Use AFTER writing or editing a spec (a `SPEC.md`/`PLAN.md` or any spec/design doc), BEFORE asking the user to review — runs a 12-point structural Self-Critique checklist, fixes issues inline, and emits a visible summary. Enriches each check from a project layer if one is present. Triggers right after a spec has been written. NOT for reviewing finished code/diffs (code-review) — this pass runs on the spec text itself."
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill spec-self-critique --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# Spec Self-Critique

A portable, structural self-review pass over a freshly written spec/plan. The **generic 12-point skeleton** below ships as-is; a **project layer** (if present) enriches each point with project-specific incidents, grep patterns, conventions, and extra sub-checks.

## When to invoke

- After a spec was written/edited (a `SPEC.md` / `PLAN.md`, or a spec/design doc), BEFORE the user-review gate.

## Readiness preflight — first

<!-- readiness:optional-preflight:start -->
Before any other step, run this once from the project root:

```bash
node scripts/readiness.mjs check --skill spec-self-critique --json
```

- `ready`: continue without a readiness message. Ready is silent.
- `degraded`: keep the generic 12-point critique active, omit only the inactive block `projectEnrichment`, and emit exactly one concise summary: `Readiness degraded — inactive block projectEnrichment (specCritiqueLayer: <state>). Run /setup-workflow, configure docs/agents/skills/spec-self-critique.md, then rerun this skill.`
- `blocked`: stop before continuing and report the non-ready required capability plus the exact `/setup-workflow` recovery path.
- Invalid is always visible: include the `invalid` capability state in the single summary and never treat it as an opt-out. Do not emit separate warnings later in the workflow.
<!-- readiness:optional-preflight:end -->

<!-- readiness:block projectEnrichment -->
When `projectEnrichment` is active, read `docs/agents/skills/spec-self-critique.md` and apply its per-point enrichment, including project-specific incidents, grep patterns, conventions, and extra sub-checks. Project-specific checks belong in that layer, **not here**; `/retro` appends new project-specific lore there rather than into this generic skeleton.
<!-- readiness:end -->

## Altitude — a portable kit concept

The generic skeleton recognizes two spec altitudes: a **Feature-PRD** (the
default — every point above and below assumes this) and a **Program-PRD**
(marked `<!-- prd: program -->`, produced by the kit's `scale-check` →
`grill-with-docs` → `to-prd` program route — a native anchor over a
multi-wave `## Wellenplan`). This is a **portable kit concept**, not a
project-specific rule, so it stays **in this generic skeleton** — the
"project-specific → project layer" routing rule above is about *this
project's* incidents/grep patterns, not about a kit-wide spec shape the
skill itself already knows.

Two points read differently at Program-Altitude — both get a dedicated
fixture in `scenarios.md`:

- **Point 3 (Scope)** at `prd: program`: scope is not "small enough for one
  plan" — it is "each wave holds 2–7 slices; the program splits via its wave
  plan, the PRD itself is never split."
- **Point 12 (Vertical-slice completeness)** at `prd: program`: reads against
  **Wellenplan rows**, not a slice/PR table — each wave is an outcome
  cut/tracer, never a layer cut ("a backend wave" is the anti-pattern); an
  enabler wave names the half it cuts off and the outcome wave that closes it.

Every other point runs unchanged at either altitude.

## How to invoke

Read the most recently written/edited spec in full. Walk the 12-point checklist (points 1–12; **8b/8c are sub-checks of point 8**, not main points). Per point:

1. Decide: does the spec trigger this rule?
2. If yes: run the check.
3. If violated: fix the spec inline (Edit tool, not "TODO later").
4. Note the correction for the summary.

End with a visible summary in the chat:

```
Self-Critique complete — <N> corrections:
- Point <X>: <short description>
- ...
```

or, if none were needed: `Self-Critique complete — no corrections needed.` THEN ask the user-review question.

## The 12-point checklist

**1. Placeholder scan + empirical re-check**
Scan for `TBD` / `TODO` / "später" / "fill in details" / vague requirements → fix inline. Plus, when applicable:
- **Cited counts** ("24 call-sites: 6 start, 8 succeed, …") → re-verify each empirically (`grep`); recon from the brainstorming phase can be stale, and wrong numbers mislead the effort estimate.
- **Folder move / rename** → broaden the caller-audit grep (search the path-segment without a `from …`-anchor, to catch mocks, dynamic imports, type-only imports) AND require a typecheck-backstop step right after the move (path-depth breaks inside the moved files aren't found by a caller grep).
- **Cited prior diagnosis** (issue body, investigation, memory snapshot, earlier plan) → verify each core claim empirically before finalizing. Such artifacts are hypotheses, not validated facts; drift compounds if left unchecked.
- **Risk mitigation** → it must name a concretely checkable **output string**, not just an action ("rowCount is 2307" is checkable; "rowCount > 1000" is a claim about a claim).
Skip only if none of these apply.

**2. Internal consistency**
Do sections contradict each other? Does the architecture match the feature description? Do numbers/orders agree between tables and prose?

**3. Scope check**
Small enough for **one** implementation plan, or must it split into sub-specs?
**At Program-Altitude** (`prd: program`) this reads differently — see
"Altitude" above: each wave holds 2–7 slices, the program splits via its wave
plan, and the PRD itself is never split.

**4. Ambiguity check**
Could a requirement be read two ways? If so, pick one interpretation and make it explicit.

**5. State transitions**
*Trigger:* the spec mentions "Live", "SSE", "WebSocket", "Polling", "EventSource", "Realtime", "Stream", or incoming updates.
*Check:* are all transitions played through — `idle → running → awaiting_decision → succeeded | failed` — plus `mid-flight reload`, `multi-tab parallel`, `connection-loss + reconnect`, `aborted`?

**6. Convention scope**
*Trigger:* the spec introduces a new pattern, convention, single-entry broker, wrapper, or consistency layer.
*Check:* is it explicitly scoped — applied app-wide vs only touched surfaces? Does the spec require a follow-up item for the untouched surfaces (in the spec body, not retroactively)?

**7. User walk-through**
*Trigger:* the spec has UI stages, wizards, or multi-step user interactions.
*Check:* are the sub-steps per UI stage walked through — what does the user see at each stage — not just the data model?

**8. Project-convention check**
*Trigger:* always.
*How:* iterate your project's documented conventions. Default location: from the project root, `docs/conventions/*.md`. For each convention file that carries a `## Self-Critique-Check` block (format: **Trigger / Check / Korrektur**):
1. Evaluate its Trigger against the current spec.
2. On match: run its Check. On violation: fix the spec inline + note it.
3. A convention with no such block → skip it non-blocking + collect a warning ("convention `<file>` is missing a `## Self-Critique-Check` block").
No conventions directory / no blocks (e.g. a fresh project) → **soft skip** (non-blocking). Emit collected warnings at the end of the pass.

**8b. Marker-wording check**
*Trigger:* a convention mandates a header marker comment.
*Check:* the spec's marker must be copied **verbatim** from the convention, not paraphrased. Open the convention, compare the marker block 1:1, fix inline on any drift (drift makes the convention worthless as the single source of truth).

**8c. Structurally-trivial post-invariant**
*Trigger:* the spec has aggregation functions with post-invariants.
*Check:* for each post-invariant, can it ever fire under the current code path? Play the path through (all branches, all math ranges). If it is structurally impossible to violate under the current code, drop it or replace it with a property test (a property fires on every regression; a structurally-true post never does).

**9. Primitive recon (DRY)**
*Trigger:* the spec introduces a new UI primitive, hook, component, helper, repo function, or service — OR substantially touches (≥30 LOC) an existing file.
*Check:* did you `grep`/`ls` for an existing primitive/helper with overlapping responsibility (including in callers/pages, not just component dirs)? If one exists → switch the spec to reuse it. If a pattern is replicated 3+× → require a helper-extraction acceptance-criterion.

**10. User-action feedback**
*Trigger:* the spec describes a user action (click, submit, import, bulk op, setup run) that triggers a ≥2-step process.
*Check:* does the spec document, per sub-step, what the user sees on screen — progress, retry/throttle visibility (esp. external APIs or long waits), mode-switch visibility (e.g. bulk → per-item fallback), and a "why is this counter stalled" hint for per-resource paths?

**11. Live-verify bug-plausibility**
*Trigger:* the spec has a live-verify block with a bug-variant + an expected property failure.
*Check:* play the bug-variant through — does it actually change the target property (e.g. does it break the asserted ordering/monotonicity)? Is only one direction sharp? If the variant does NOT violate the property, pick a variant that does and fix the spec inline (a wrong variant yields a passing live-verify that catches no real regression).

**12. Vertical-slice completeness**
*Trigger:* the spec/PRD has a slice/phase table or splits into multiple PRs.
*Check:*
- (a) each *user-facing* slice = a tracer bullet "`<user action> → <visible result>`", **not** a layer name ("config UI", "backend resolver");
- (b) each byte-neutral/infra slice names its **omitted half** + the **closing follow-up slice** (otherwise the connecting path falls between two slices);
- (c) the first outcome slice after ≥1 prep slice is traced against the code with a concrete value (`grep`/Read), not trusted as "config-driven".
*Correction:* reword/split a layer-only slice; pull in a new slice for an uncovered half.
**At Program-Altitude** (`prd: program`), apply (a)–(c) analogously to
**Wellenplan rows** instead of a slice table — see "Altitude" above: each wave
is an outcome cut/tracer, never a layer cut, and an enabler wave names both
the half it omits and the outcome wave that closes it.

**Gate home.** This skill runs **automatically as the mandatory last step of `to-prd`** (on the Draft-PRD) — the visible two-line summary is required **before** the user-review question. The **slice-completeness gate (point 12)** additionally sits in `to-issues`. The skill stays **standalone-callable** for manual spec/PLAN reviews.

## Anti-patterns of this skill

- **"Skipped self-critique because the spec is small"** — it runs on mini-specs too. Cost: 2–3 min; payoff: structural bugs caught in the spec phase.
- **"Made corrections silently inline, no summary"** — the visible summary is part of acceptance. A silent pass is indistinguishable from a skipped one.
- **"Improvised what a convention would say"** — if a convention file has no `## Self-Critique-Check` block, skip it non-blocking + collect a warning. Do not invent the rule.

## Verification fixtures

See `scenarios.md` in this skill dir for project-neutral fixtures (one per check) — walk them when refactoring the checklist. If a project layer is present, it may carry richer, project-specific scenarios.
