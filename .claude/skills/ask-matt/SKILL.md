---
name: ask-matt
description: Ask which skill or flow fits your situation. A router over the skills in this repo.
disable-model-invocation: true
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill ask-matt --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# Ask Matt

> **Homage + Router.** Adopted from Matt Pocock's `ask-matt` (MIT, github.com/mattpocock/skills @ `7a83a3a`) — the name stays as a nod to upstream, the content is adapted to *this* repo's skill set (the plan→execute→land→learn line plus our gates, cross-model review, and land/learn skills). Provenance: `docs/agents/provenance.md`. Folder↔upstream-name note: `/diagnose` = upstream `diagnosing-bugs`, `/write-a-skill` = upstream `writing-great-skills` (renamed upstream, local names kept).

You don't remember every skill, so ask.

A **flow** is a path through the skills. Most paths run along one **main flow**; on-ramps and gates merge onto it. Everything else is standalone, or a vocabulary layer that runs underneath.

## The main flow: idea → ship

The route most work travels. You have an idea and want it built.

0. **Size unclear? `/scale-check` first.** A new undertaking without a clear
   size — a new app, a big cross-cutting change, a genuine "where do I even
   start?" — runs `/scale-check` before anything else: a short plain-language
   dialog that routes it to a Program, a Feature, a Direct-Slice, or a Bug,
   and hands back a paste-ready start prompt for the chosen route. **Rule: a
   new build without a clear size runs `scale-check` first** — never guess
   the altitude and jump straight into step 1. Skip this step outright when
   the size is already obvious (a one-line fix, a known bug) — go straight to
   the entry that fits.
<!-- mirror-xform:start codex-escalation -->
1. **`/grill-with-docs`** — sharpen the idea by relentless interview. Start here when you **have a codebase**: it's stateful, retaining what it learns in `CONTEXT.md` and ADRs. (No codebase? Use `/grill-me` — see Standalone.) For high-stakes/hard-to-reverse work, add the cross-model variant **`/grill-with-docs-codex`** (see Cross-model review).
<!-- mirror-xform:end -->
2. **Branch — can you settle every question in conversation?** If a question needs a runnable answer (state, business logic, a UI you have to see), detour through a prototype, bridged by **`/handoff`** in both directions (see Crossing sessions): `/handoff` out → fresh session → **`/prototype`** to answer with throwaway code → `/handoff` back what you learned.
3. **Gate — does a slice hinge on an unknown?** Clear it *before* building (see Gate-before-build): a binary fact → **`/verify-spike`**; a bounded "which option" trade-off → **`/decision-gate`**.
4. **Branch — is this a multi-session build?**
   - **Yes** → **`/to-prd`** (turn the thread into a PRD) → **`/to-issues`** (split into independently-grabbable issues / a wave anchor). Clear context between issues: fresh session per issue, kick off **`/implement`** with the PRD + the single issue.
   - **No** → **`/implement`** right here, same context window.

   Either way, **`/implement`** builds each issue by driving **`/tdd`** internally — one red-green slice at a time — then closes out with **`/code-review`** (the two-axis Standards×Spec review; project layer at `docs/agents/code-review.md`, seeded by `/setup-workflow`) before committing. Reach for **`/tdd`** on its own to build a concrete behaviour test-first without a full spec, and **`/code-review`** on its own to review any branch/PR against a fixed point.
5. **Land** → **`/wrapup`** (see Land). **Learn** → **`/retro`** (see Learn).

### Context hygiene

Keep steps 1–4 in **one unbroken context window** — don't compact or clear until after `/to-issues` — so grilling, PRD, and issues build on the same thinking. Each `/implement` then starts fresh from the issue. If a session gets large before `/to-issues`, don't push on degraded — `/handoff` and continue fresh.

## Depth Ladder

Prefer the smallest depth that produces a clear next action.

- **Program:** the size is genuinely unclear — a new app, a big cross-cutting
  undertaking, several independently-shippable stages. Run `/scale-check`
  first (it owns the altitude criteria catalog — this router only names it);
  two or more criteria tripped routes to a program grill → `/to-prd` →
  `/to-issues`. The explicit Program identity makes the Planning facade select
  its internal graph engine; the user never chooses that engine.
- **Deep:** `/grill-with-docs` followed by `/to-prd` and `/to-issues` when
  terminology, contracts, rollout order, or ownership are still uncertain.
- **Medium:** `/to-issues` for a ready artefact that needs slicing.
- **Light:** direct `/implement` for a small, well-understood change.
- **Gate:** insert `/verify-spike` or `/decision-gate` before any depth level
  when a slice hinges on an unresolved fact or trade-off.

## Gate-before-build

When `/to-issues` cuts a slice that hinges on an unknown, it tags the slice instead of guessing. The gate is its own slice, sequenced *before* the build slice it blocks.

- **`/verify-spike`** — a single yes/no fact against the real lib/runtime/DB/platform, answered by a throwaway read-only harness with output-proof.
- **`/decision-gate`** — a bounded trade-off ("which option") or a targeted research gap: options × criteria table + reasoned pick, sunk to an ADR/issue.
<!-- mirror-xform:start codex-escalation -->
- **`/grill-with-docs-codex` / `/grill-me-codex`** — for genuinely hard-to-reverse calls, escalate to a cross-model grill (see Cross-model review).
<!-- mirror-xform:end -->

## On-ramps

A starting situation that generates work, then merges onto the main flow.

- **Bugs and requests piling up** → **`/triage`**. Moves issues through triage and produces agent-ready issues that `/implement` later picks up. Only for issues **you didn't create** — `/to-issues` output is already agent-ready, don't triage it.
- **Something's broken** → **`/diagnose`**. For the hard ones: the bug that resists a first glance, the intermittent flake, the regression between two known-good states. Refuses to theorise until it has a **tight feedback loop** — one command that already goes red on *this* bug — then fixes with a regression test. Its post-mortem hands off to **`/improve-codebase-architecture`** when the finding is that there's no good seam.
- **A huge, foggy effort too big for one agent session** — a greenfield build or a sprawling feature where the way from here to the destination isn't yet visible, and it's still **pre-spec** (before any grill or PRD) → **`/wayfinder`** (user-invoked). It charts a **shared map** of investigation slices on the tracker and resolves them one at a time — producing **decisions, not deliverables** — until the fog lifts and the route is clear, then merges onto the main flow at **`/to-prd`** (or, if the effort turned out small enough, straight to **`/implement`**). Where `/grill-with-docs` sharpens an idea you can hold in one session, wayfinder is for the one you can't. Once an undertaking has already resolved into several independently-shippable waves, `/scale-check` → `/to-issues` stays the primary route.
- **A backlog to cluster** → **`/board-to-waves`**. Groups an existing board into themed waves when you need to *find* the next wave rather than start fresh.
- **A whole wave to LAND** → **`/orchestrate-wave`**. When a wave anchor (file-disjoint slices, specs already locked) is ready to build, verify and land end-to-end — often AFK: it dispatches an implementer per slice in its own worktree, integrates serially, verifies centrally, and lands the wave. The execute-and-land node of the wave ladder (`scale-check` → `to-issues`/`board-to-waves` → `orchestrate-wave`). A single slice just goes to `/implement`.

## Cross-model review (Codex)

An independent second model catches what one model rationalises. Read-only, bounded.

<!-- mirror-xform:start codex-escalation -->
- **`/grill-me-codex` / `/grill-with-docs-codex`** — run the grill (Act 1), then a *different* model (Codex) adversarially reviews the locked plan (Act 2) before any code.
<!-- mirror-xform:end -->
- **`/codex-review`** (Claude Code only) — standalone: you already have a plan, just want the cross-model stress-test.

## Codebase health

Not feature work — upkeep.

- **`/improve-codebase-architecture`** — run in spare moments to keep the codebase good for agents, or step back from the diff to the structure when a change is fighting the codebase. Surfaces **deepening opportunities**; picking one _generates an idea_ for the main flow at `/grill-with-docs`.
- **`/security-audit`** — a whole-app, application-layer security audit run as an independent two-model pass (two models audit the same code separately, then the remediation plan is hardened before any fix). Run before a release or after the attack surface changes (new endpoint, new input source, auth change, dependency bump). Infra hardening (ports/TLS/SSH/backups) is audited separately.

## Vocabulary underneath

Model-invoked references that run *beneath* the other skills — each the single source of truth for its vocabulary. Reach for them when the **words**, not the process, are the problem.

- **`/domain-modeling`** — sharpen the project's *domain* language: challenge a fuzzy term, resolve an overloaded word, record a hard-to-reverse decision as an ADR. The active discipline `/grill-with-docs` drives to keep `CONTEXT.md` a clean glossary. (ADR conventions: `docs/adr/README.md`.)
- **`/codebase-design`** — the deep-module vocabulary (module, interface, depth, seam, adapter, leverage, locality) for designing a module's *shape*. `/tdd` and `/improve-codebase-architecture` both speak it.
- **`/write-a-skill`** (Claude Code only) — reference for writing and editing skills well (invocation, information hierarchy, progressive disclosure, leading words, pruning, failure modes). *This router is itself an instance of its "router skill" pattern.*

## Land

- **`/wrapup`** — the land-and-clean closeout: make the branch landable, enforce the PR-body contract, merge, reconcile the board, sweep merged branches, surface what's still open. Does not replace live verification — verify the user outcome first.
- **`/local-ci`** — the pre-PR gate: run the repo's local CI (fast static guards + the full gate) before opening a PR. When your host can't enforce a required status check at merge (a Free-plan private repo has no branch protection), the gate has to be local — this is it.
- The **pre-commit / pre-push gate** fires automatically (installed once via `/git-guardrails-claude-code` / `/setup-pre-commit`, both Claude Code only), blocking a broken commit/push.

## Learn

- **`/retro`** — in-session post-mortem that proposes concrete changes to rules, skills, or hooks, each with per-patch approval.
- **`/audit-skills`** — the anti-drift audit: check the repo's own skills against code/doc reality and fix the rot (dead paths, stale line numbers, broken cross-refs). Run it periodically or when a SessionStart drift-hint flags a skill whose declared source moved.
- **`/write-a-skill`** (Claude Code only) — turn a move you keep repeating into a reusable skill (see Vocabulary).

## Crossing sessions

- **`/handoff`** — compacts the conversation into a markdown file when a thread is full or you need to branch (e.g. into a `/prototype` session). You don't continue in place — open a new session and reference that file. `/handoff` forks; `/compact` continues.
- **`/compact`** (built-in) — stay in the same conversation, letting earlier turns be summarized. Use at intentional breaks between phases, not mid-phase.

## Standalone

Off the main flow entirely.

- **`/grill-me`** — the same relentless interview as `/grill-with-docs`, but for when you have **no codebase**. Stateless — saves nothing locally.
- **`/prototype`** — a small throwaway program that answers one design question (does this state model feel right; what should this UI look like). Keep the answer, delete the code.
- **`/research`** — delegate reading/docs legwork to a **background agent**: it investigates a question against **primary sources** and leaves a cited Markdown note in the repo. Keep working while it reads. Model-invoked (also triggerable by name); the note it produces is something to carry *into* the main flow at `/grill-with-docs` — research feeds the thinking, it doesn't replace it.
- **`/resolving-merge-conflicts`** — a disciplined loop for an in-progress merge/rebase conflict: understand each side's intent, preserve both where possible, always resolve (never `--abort`).
- **`/git-worktree-recover`** — reflog recovery for a branch mix-up: a commit landed on the wrong branch, the branch switched unexpectedly, or work looks lost. Finds the misplaced commit, moves it to the right branch, and sets up a clean worktree.
- **`/spec-self-critique`** — red-team your own spec before committing to build it.

## Precondition

- **`/setup-workflow`** — run before your first engineering flow to configure the issue tracker, triage labels, board profile, and doc layout the other skills assume.

## Repo-specific skills

This repo also carries **project-private domain/tooling skills** (data layer, migrations, forecast/risk logic, brand, blast-radius census, …) that don't ship in the kit. For those, see the **project-skill table in `CLAUDE.md`** — they're model-invoked and fire on their own triggers.
