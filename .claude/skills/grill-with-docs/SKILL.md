---
name: grill-with-docs
disable-model-invocation: true
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation (CONTEXT.md, ADRs) inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions.
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill grill-with-docs --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

<what-to-do>

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the codebase, look it up rather than asking me. The *decisions*, though, are mine — put each one to me and wait for my answer.

Do not enact the plan until I confirm we have reached a shared understanding.

</what-to-do>

### Census preflight before plan-lock

For a cross-cutting plan, run `python3 .claude/hooks/drift-guard.py --census-status` before locking it. When an activated census reports `block_handoff: true` (including stale or open surfaces), stop the lock, run `$census-update`, resolve the findings, and retry. When the census is disabled or not activated, keep the status visible and perform the existing manual surface walk; do not replace that walk with census guesses.

## Related skills

**No codebase/`CONTEXT.md` present, or a simpler case?** → `grill-me` is enough — same grill without the docs layer (CONTEXT.md/ADRs).

<!-- mirror-xform:start codex-escalation -->
**High stakes / hard to reverse** (auth, schema, concurrency, migrations, payments)? → additionally `grill-with-docs-codex` — the same grill plus a cross-model review by Codex afterward (Claude Code surface).
<!-- mirror-xform:end -->

<plan-lock>

## Plan-lock — writing PLAN.md

Once all decisions are made (plan locked, before sign-off/handoff) and the session runs in a **worktree** → write the locked plan as `PLAN.md` to the worktree root. `PLAN.md` is **expected** to be ignored by git so it never travels over git — the kit never edits your `.gitignore` by itself, but `/setup-workflow` offers to add that rule (consistent with CLAUDE.md "plan inside the worktree"). This way the locked plan survives a session cut and `to-prd` finds its default source. Continuing same-session work **without** a worktree stays allowed (conversation = source); but for a deliberate **session cut** before `to-prd`, `PLAN.md` is mandatory. (The `-codex` variant already writes `PLAN.md` anyway.)

</plan-lock>

<supporting-info>

## Domain awareness

During codebase exploration, also look for existing documentation:

### File structure

Most repos have a single context:

```
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

If a `CONTEXT-MAP.md` exists at the root, the repo has multiple contexts. The map points to where each one lives:

```
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/                          ← system-wide decisions
├── src/
│   ├── ordering/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                 ← context-specific decisions
│   └── billing/
│       ├── CONTEXT.md
│       └── docs/adr/
```

Create files lazily — only when you have something to write. If no `CONTEXT.md` exists, create one when the first term is resolved. If no `docs/adr/` exists, create it when the first ADR is needed.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update CONTEXT.md inline

When a term is resolved, update `CONTEXT.md` right there. Don't batch these up — capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

`CONTEXT.md` should be totally devoid of implementation details. Do not treat `CONTEXT.md` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

### Coherence is the default — the grill locks only the deltas

A feature that builds on existing features inherits the existing building blocks by default, across **every** layer: the UI renders the same components, the backend calls the same services and calculations, data flows through the same paths, conventions carry over. Do not interview the user about how such a feature should look or behave where an existing counterpart exists — that is already decided. Lock only:

1. **The deltas:** what is intentionally excluded, restricted, or different (navigation, filters, actions, person data, write access, …). Every delta is an explicit decision with a reason.
2. **The consumer walk-through:** who consumes the result and what they see/get — walked through from the consumer's side, not the owner's.

A parallel rebuild of something that exists — a simplified UI stand-in, a re-implemented calculation, a second data path — is a defect to surface, never a silent shortcut. (Incident: a share feature shipped rebuilt, simplified renderers across 6 pages because "looks like the page minus chrome" was treated as open design space instead of the default; half the implementation was replaced.)

### Cross-cutting fork — pattern vs. concept (before plan-lock)

Is the change **cross-cutting** (a new pattern OR a new data structure/domain distinction, touching ≥3 places, OR "everywhere / distinguish X of Y / migrate")? Then classify it **during the grill** — don't defer it to the post-spec self-critique (otherwise Codex reviews a plan without it):

- **Pattern** (old→new, e.g. TanStack Query replacing manual loading): the denominator is **grep-able** → put in the plan: a census of all old spots + a `*.guard.test.ts` that stays red as long as old spots exist outside a shrinking allowlist.
- **Concept** (a new distinction, e.g. Project↔Campaign): `grep` cannot find the **absence** of a concept → put in the plan: a **code-derived** surface list (routes/pages/exports/reports) × a **domain verdict per surface** (counts / N/A / open); "counts" rows become tracked items. **If the project has a tool that generates this surface list from code** (an "Impact Census" / blast-radius report — see the project convention file): **run it early and grill against the `X of Y` table, not against gut feeling** — the "NOT COVERED"/invariant parts (dynamic dispatch, lifecycle) stay manual.

Never claim "complete" from plan/memory — count the denominator fresh, report `X of Y`. Substance, trigger threshold + guard template → the project convention file `docs/conventions/spec-completeness.md` (if present), §Cross-cutting fork.

</supporting-info>

## Re-grill reconcile — execute-ready (Wave 26)

Triggers when you **re-grill an issue that already exists in the graph** (a leaf of a grilled epic, or a child of an anchor). Goal: leave the rooted sub-graph **execute-ready**, never silently drift.

1. **Read the parent-anchor decisions FIRST** — fetch the anchor body + its PRD/key decisions and take the seam decision **from there**. Do **not** re-derive the architecture from the leaf (lesson: a leaf whose central decision was never read got re-litigated through question rounds). For an atomic leaf, its own body/PRD is the reference.
2. **Check the leaf for internal contradiction** (Fix B): a body that contradicts itself ("no new UI" + "build a name field") or the anchor decision → **no execute**. Likewise a leaf that says *"final cut depends on #X"* via `<!-- final-cut-depends-on: #X -->` where **#X is closed** without resolving the cut.
3. **On drift/contradiction:** update the affected issue(s), re-stamp `plan_revision`, set the correct bucket. An internal contradiction → set the leaf to **HITL** (remove `ready-for-agent`, add the `headings.vorBau` heading — board profile `docs/agents/board-sync.md`; <project> currently `## Vor Bau zu klären`); the drift-guard then blocks a build-handoff via `target_buildable`. So the contradiction flows through existing machinery — no semantic heuristic in the hook.
4. **Audit, non-blocking:** `python3 scripts/execute-ready-check.py --issue <n> --mode audit` → visible two-liner. The **blocking** net is the drift-guard at handoff (`.claude/hooks/drift-guard.py`).
5. **Global `-codex` variant** can't change the repo → leave a pointer note ("reconcile the issues + re-stamp plan_revision, repo-side"); real enforcement = the repo hook. **Honest bound:** the hook fires at the handoff/session boundary, not at a "grill-exit" event; a same-session global-codex grill → direct `/implement` (no handoff) is a documented residual (global follow-up).

**Markers used here** (HTML comments, grep-able): `<!-- guard-ack: #<n> r<N> reason:<text> by-user -->` (deliberate handoff override), `<!-- final-cut-depends-on: #<n> -->`, `<!-- handoff-intent: build|grill -->`, `<!-- guard-legacy -->` (grandfathered legacy-anchor → warn not block). **Canonical table of all markers:** module docstring of `scripts/execute-ready-check.py`.
