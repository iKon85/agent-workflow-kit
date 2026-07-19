---
name: grill-with-docs-codex
description: Two-act plan hardening with living documentation. ACT 1 (you ↔ Claude) — Claude interviews you relentlessly about a plan, one question at a time, challenging it against your project's existing domain model and glossary (CONTEXT.md), sharpening fuzzy terms, stress-testing with concrete scenarios, cross-referencing code, and updating CONTEXT.md + ADRs inline as decisions crystallise. ACT 2 (Claude ↔ Codex) — Claude writes the locked plan to PLAN.md and OpenAI Codex adversarially reviews it in a read-only sandbox (VERDICT:APPROVED/REVISE), Claude revises and re-submits to the SAME Codex session until APPROVED or a MAX_ROUNDS cap, then you sign off before any code. Use when the user says "/grill-with-docs-codex", "grill me against the docs then have codex review", "stress-test this against our domain model then get a second model on it", or is about to build something high-stakes in a project with established terminology/ADRs and wants alignment, documentation, AND a cross-model sanity check. Builds on Matt Pocock's grill-with-docs (MIT). NOT for reviewing already-written code (use /codex:review) and NOT for trivial changes.
---

# Grill-with-Docs-Codex — Grill Against Your Domain, Then Get Reviewed

Two acts. Act 1 aligns intent *and* keeps your living docs honest; Act 2 has a different model attack the result.

- **Act 1** is Matt Pocock's `grill-with-docs`, used under MIT (see `THIRD-PARTY-NOTICES.md`). It interrogates you, challenges your plan against `CONTEXT.md`/ADRs, and updates them inline.
- **Act 2** is the original Codex adversarial review loop — cross-model, read-only, bounded.

You enter at two points: answering the grill, and signing off the converged plan.

---

## ACT 1 — GRILL WITH DOCS (you ↔ Claude)

<what-to-do>

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the codebase, look it up rather than asking me. The *decisions*, though, are mine — put each one to me and wait for my answer.

Do not write `PLAN.md` or proceed to Act 2 until I confirm we have reached a shared understanding.

**Coherence default:** a feature that builds on existing features inherits the existing building blocks across every layer (UI components, backend services/calculations, data paths, conventions). The grill locks only the deltas (what is intentionally excluded/restricted/different, each with a reason) and the consumer walk-through (what the receiving user sees/gets). A parallel rebuild of something that exists is a defect, not a design option.

</what-to-do>

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

</supporting-info>

### Lifecycle completeness for multi-phase plans

Is the plan a **multi-phase pattern** (expand-contract, dual-write, backfill, staged rollout)? Then **enumerate all phases explicitly** (e.g. expand → read-switch → write-switch → contract), mark which are in THIS plan vs. **deferred**, and check which **ordering guard** prevents phase N before phase N-1. A deferred phase that lives only as a code comment is a finding — it belongs in the board as a tracking issue (CLAUDE.md §Backlog-Workflow "deferred phase = tracking issue immediately"). Incident precedent: a read-switch was built, the write-switch only commented, and the contraction issue jumped ahead → live edits got shadowed.

### Cross-cutting fork — pattern vs. concept

Is the change **cross-cutting** (a new pattern OR a new data structure/domain distinction, touching ≥3 places, OR "everywhere / distinguish X of Y / migrate")? Then classify it **during the grill** — don't defer it to the post-spec self-critique; the classification becomes part of the `PLAN.md` that Codex reviews in Act 2:

- **Pattern** (old→new, e.g. TanStack Query replacing manual loading): the denominator is **grep-able** → put in the plan: a census of all old spots + a `*.guard.test.ts` that stays red as long as old spots exist outside a shrinking allowlist.
- **Concept** (a new distinction, e.g. Project↔Campaign): `grep` cannot find the **absence** of a concept → put in the plan: a **code-derived** surface list (routes/pages/exports/reports) × a **domain verdict per surface** (counts / N/A / open); "counts" rows become tracked items. **If the project has a tool that generates this surface list from code** (an "Impact Census" / blast-radius report — see the project convention file): **run it early and grill against the `X of Y` table, not against gut feeling** — the "NOT COVERED"/invariant parts (dynamic dispatch, lifecycle) stay manual.

Never claim "complete" from plan/memory — count the denominator fresh, report `X of Y`. Substance, trigger threshold + guard template → the project convention file `docs/conventions/spec-completeness.md` (if present), §Cross-cutting fork.

### Census preflight before plan-lock

For a cross-cutting plan, run `python3 .claude/hooks/drift-guard.py --census-status` before locking it. When an activated census reports `block_handoff: true` (including stale or open surfaces), stop the lock, run `$census-update`, resolve the findings, and retry. When the census is disabled or not activated, keep the status visible and perform the existing manual surface walk; do not replace that walk with census guesses.

### Handoff to Act 2

When the decision tree is resolved, the glossary/ADRs are updated, and we're aligned, **write the agreed plan to `PLAN.md`** (use the canonical terms from `CONTEXT.md`), then run Act 2:

> **Where to write it:** `PLAN.md` + `PLAN-REVIEW-LOG.md` are per-session scratch — write them in the working directory the implementing session will actually use, and invoke the wrapper from that directory. A project may gitignore these files, so don't rely on git to carry them across checkouts/worktrees. In worktree-based repos, create the issue worktree BEFORE this write and plan inside it.

```markdown
# Plan: <task>
_Locked via grill-with-docs — by Claude + <user>. Terms per CONTEXT.md._

## Goal
<one paragraph, in the project's ubiquitous language>

## Approach
<numbered, concrete steps>

## Key decisions & tradeoffs
<the contestable choices the grill resolved — link any ADRs created>

## Risks / open questions
<anything still open>

## Out of scope
<bounds>
```

Initialize `PLAN-REVIEW-LOG.md`:
```markdown
# Plan Review Log: <task>
Act 1 (grill-with-docs) complete — plan locked, CONTEXT.md/ADRs updated. MAX_ROUNDS=<n>.
```

---

## ACT 2 — REVIEW (Claude ↔ Codex)

Hand the locked plan to Codex for adversarial review. Mechanics verified end-to-end (2026-06-04).

### Prerequisites
- Let `scripts/codex-exec.sh` preflight Codex before launch. It enforces the
  exact tested-version allowlist, authentication, platform, and capabilities;
  surface any failure rather than retrying silently.
- Do NOT pin `-m` (config default is used; `gpt-5.x-codex` variants 400 on ChatGPT-account auth).
- **Echo the active model before Round 1** so the user can confirm: read the `model` line from `~/.codex/config.toml` (absent = "CLI default"); state it alongside the resolved tunables. If the user objects, stop before burning a round.

### Tunables (args, else default)
| Var | Default | Meaning |
|-----|---------|---------|
| `MAX_ROUNDS` | `5` | Hard cap. Loop ALWAYS terminates here. |
| `PLAN_FILE` | `PLAN.md` | The plan from Act 1. |
| `LOG_FILE` | `PLAN-REVIEW-LOG.md` | Append-only argument transcript. |

Invoked with e.g. `rounds=3` → use it. Echo resolved values first.

### Review prompt (each round)
> You are an adversarial reviewer for an implementation plan. Be skeptical and specific — your job is to find what breaks, not to be agreeable. Read the plan at `PLAN.md` (and `CONTEXT.md`/ADRs for the domain language) and any repo files you need (you are read-only). Identify concrete flaws: security holes, race conditions, missing edge cases, schema conflicts, domain-language mismatches, wrong assumptions, observability gaps, simpler alternatives. For each, give a one-line fix. Do NOT modify any files. End with EXACTLY one line: `VERDICT: APPROVED` or `VERDICT: REVISE`.

### Round 1 — fresh wrapper-owned session

```bash
if ROUND_RESULT=$(scripts/codex-exec.sh new --profile review --mode read-only --prompt "$REVIEW_PROMPT"); then
  RUN_ID=$(printf '%s\n' "$ROUND_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')
  CODEX_REPORT=$(printf '%s\n' "$ROUND_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["verdict"])')
else
  FAILURE_RESULT=$(scripts/codex-exec.sh handle-failure --result "$ROUND_RESULT") || :
  printf '%s\n' "$FAILURE_RESULT" >&2
  exit 1
fi
```

### Rounds 2..MAX — resume SAME session

```bash
if ROUND_RESULT=$(scripts/codex-exec.sh resume "$RUN_ID" --prompt "I revised the plan. Re-review PLAN.md — check prior findings + flag anything new. End with VERDICT: APPROVED or VERDICT: REVISE."); then
  CODEX_REPORT=$(printf '%s\n' "$ROUND_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["verdict"])')
else
  FAILURE_RESULT=$(scripts/codex-exec.sh handle-failure --result "$ROUND_RESULT" --run-id "$RUN_ID") || :
  printf '%s\n' "$FAILURE_RESULT" >&2
  exit 1
fi
```

The wrapper persists read-only mode and owns stdin closure, hang detection, the
overall timeout, stderr redaction, and its process group. `handle-failure`
surfaces the structured status and cleanup metadata for `LOG_FILE`, then the
caller stops before report handling. A surfaced `HUNG` returns to the user for
the choice to retry once with a fresh run or proceed without cross-model
review. Never inspect, signal, or kill foreign Codex processes.

### Each round
1. Read `CODEX_REPORT`; append `## Round <n> — Codex` + critique to `LOG_FILE`.
2. Last line verdict: `APPROVED` → Resolution (converged); `REVISE` → Claude decides what's worth acting on (final arbiter), revise `PLAN_FILE`, append `### Claude's response` (what changed/rejected + why), increment.
3. round > `MAX_ROUNDS` → Resolution (deadlock).

After harvesting the final report and updating the log, delete the successful
run state:

```bash
scripts/codex-exec.sh finalize "$RUN_ID"
```

### Resolution (you sign off)
- **APPROVED:** present final plan + 3-bullet summary of what the two acts improved + round count. Ask: implement now — Codex builds it (`/codex-build`), Claude builds it, or stop? No code during either act.
- **Deadlock (cap hit, no APPROVED):** list unresolved points + Claude's counter-position; hand to user. Don't fake convergence.
- **Act 3 (optional):** user picks Codex → invoke the `codex-build` skill with `SPEC_FILE=PLAN.md` and the same `LOG_FILE`. Roles flip: Codex writes in a bounded workspace-write sandbox, Claude reviews the diff + runs the proof; build rounds append to the same log.

---

## Hard rules
- Act 1 precedes Act 2. `CONTEXT.md` stays a glossary only — no implementation details.
- Codex is read-only EVERY round — establish it once through the wrapper's
  `review` + `read-only` new call; every resume inherits it.
- Loop ALWAYS terminates at `MAX_ROUNDS`. Claude is final arbiter on REVISE (reject with logged reason). Code only after sign-off. `LOG_FILE` is the deliverable.
- A `HUNG` wrapper result always returns to the user for the proceed-without or
  retry-once choice.

## What NOT to do
- Don't review already-written code (`/codex:review`). Don't pin `-codex` variants on ChatGPT auth. Don't let Codex edit files. Don't skip Act 1.
- Don't substitute the plugin `/codex:adversarial-review` for Act 2 on a **gitignored** `PLAN.md`: that command is **diff-scoped** and never reads a gitignored plan — it'll only critique the tracked diff (e.g. `CONTEXT.md`) or, if you `git add -f PLAN.md`, flag the staging itself (and you must unstage before any commit). THIS skill's Act-2 `codex exec` works because its prompt explicitly says *Read the plan at `PLAN.md`* — codex read-only can open on-disk gitignored files. (Observed 2026-06-08: 3 plugin rounds reviewed only the glossary, never the plan.)
