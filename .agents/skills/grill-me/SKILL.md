---
name: grill-me
disable-model-invocation: true
description: "Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions \"grill me\"."
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.

## Related skills

**Codebase with `CONTEXT.md`/ADRs present?** → use `grill-with-docs` instead of this skill — same grill, additionally sharpened against the existing domain model, maintains `CONTEXT.md`/ADRs inline.

<!-- mirror-xform:start codex-escalation -->
**High stakes / hard to reverse** (auth, schema, concurrency, migrations, payments)? On the Claude Code surface, this grill is followed by a cross-model review by Codex — not available on this surface.
<!-- mirror-xform:end -->

## Coherence is the default — the grill locks only the deltas

A feature that builds on existing features inherits the existing building blocks by default, across **every** layer: the UI renders the same components, the backend calls the same services and calculations, data flows through the same paths, conventions carry over. Do not interview the user about how such a feature should look or behave where an existing counterpart exists — that is already decided. Lock only:

1. **The deltas:** what is intentionally excluded, restricted, or different (navigation, filters, actions, person data, write access, …). Every delta is an explicit decision with a reason.
2. **The consumer walk-through:** who consumes the result and what they see/get — walked through from the consumer's side, not the owner's.

A parallel rebuild of something that exists — a simplified UI stand-in, a re-implemented calculation, a second data path — is a defect to surface, never a silent shortcut. (Incident: a share feature shipped rebuilt, simplified renderers across 6 pages because "looks like the page minus chrome" was treated as open design space instead of the default; half the implementation was replaced.)

## Cross-cutting fork — pattern vs. concept (before plan-lock)

Is the change **cross-cutting** (a new pattern OR a new data structure/domain distinction, touching ≥3 places, OR "everywhere / distinguish X of Y / migrate")? Then classify it **during the grill** — don't defer it to the post-spec self-critique (otherwise Codex reviews a plan without it):

- **Pattern** (old→new, e.g. TanStack Query replacing manual loading): the denominator is **grep-able** → put in the plan: a census of all old spots + a `*.guard.test.ts` that stays red as long as old spots exist outside a shrinking allowlist.
- **Concept** (a new distinction, e.g. Project↔Campaign): `grep` cannot find the **absence** of a concept → put in the plan: a **code-derived** surface list (routes/pages/exports/reports) × a **domain verdict per surface** (counts / N/A / open); "counts" rows become tracked items.

Never claim "complete" from plan/memory — count the denominator fresh, report `X of Y`. Substance, trigger threshold + guard template → the project convention file `docs/conventions/spec-completeness.md` (if present), §Cross-cutting fork.

## Plan-lock — writing PLAN.md

Once all decisions are made (plan locked, before sign-off/handoff) and the session runs in a **worktree** → write the locked plan as `PLAN.md` to the worktree root (gitignored since, doesn't travel over git — consistent with CLAUDE.md "plan inside the worktree"). This way the locked plan survives a session cut and `to-prd` finds its default source. Continuing same-session work **without** a worktree stays allowed (conversation = source); but for a deliberate **session cut** before `to-prd`, `PLAN.md` is mandatory. (The `-codex` variant already writes `PLAN.md` anyway.)

## Re-grill reconcile — execute-ready (Wave 26)

Applies when you **re-grill an issue that already exists** (a leaf of a grilled epic, or a child of an anchor) — the most common re-grill path, since campaign HITL slices route via `/grill-me → /tdd`. Goal: the rooted sub-graph comes out **execute-ready**, never silent drift. (grill-me has no docs layer — CONTEXT.md/ADR don't apply; core rules identical to grill-with-docs §"Re-Grill Reconcile".)

1. **Read parent-anchor decisions FIRST** — fetch the anchor body + its PRD/key decisions, take the seam decision **from there**. Do not re-derive the architecture from the leaf (lesson: a leaf whose central decision was never read got re-litigated through question rounds). For an atomic leaf, its own body/PRD is the reference.
2. **Check the leaf for internal contradiction**: a body that contradicts itself ("no new UI" + "build a name field") or the anchor decision → **no execute**. Likewise a leaf that says *"final cut depends on #X"* via `<!-- final-cut-depends-on: #X -->` where **#X is closed** without resolving the cut.
3. **On drift/contradiction:** update the affected issue(s), re-stamp `plan_revision`, set the correct bucket. Internal contradiction → set the leaf to **HITL**: strip `ready-for-agent` via `python3 scripts/board-sync.py add --bucket hitl --issue <n>` (the helper stays the owner of the workflow labels — no bare `gh issue edit --add-label`), add the `headings.vorBau` heading (board profile `docs/agents/board-sync.md`; <project> currently `## Vor Bau zu klären`). The drift-guard then blocks the build handoff via `target_buildable` — the contradiction flows through existing machinery, no heuristic in the hook.
4. **Audit, non-blocking:** `python3 scripts/execute-ready-check.py --issue <n> --mode audit` → a visible two-liner. The **blocking** net is the drift-guard at handoff (`.claude/hooks/drift-guard.py`).

**Markers** (HTML comments, grep-able): `<!-- guard-ack: #<n> r<N> reason:<text> by-user -->`, `<!-- final-cut-depends-on: #<n> -->`, `<!-- handoff-intent: build|grill -->`, `<!-- guard-legacy -->`. Canonical table of all markers: module docstring of `scripts/execute-ready-check.py`.
