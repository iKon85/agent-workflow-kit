---
name: grill-me-codex
description: Two-act plan hardening. ACT 1 (you ↔ Claude) — Claude interviews you relentlessly about a plan or design, one question at a time, recommending an answer for each and exploring the codebase when it can answer itself, until every branch of the decision tree is resolved. ACT 2 (Claude ↔ Codex) — Claude writes the locked plan to PLAN.md and OpenAI Codex adversarially reviews it in a read-only sandbox (VERDICT:APPROVED/REVISE), Claude revises and re-submits to the SAME Codex session until APPROVED or a MAX_ROUNDS cap, then you sign off before any code. Use when the user says "/grill-me-codex", "grill me then have codex review", "grill me and stress-test the plan", "interview me about this plan then get a second model on it", or is about to build something high-stakes (auth, schema, concurrency, migrations, payments) and wants both alignment AND a cross-model sanity check before implementation. Builds on Matt Pocock's grill-me (MIT). For the docs-aware variant use /grill-with-docs-codex; if you already have a plan and want only the Codex review use /codex-review. NOT for reviewing already-written code (use /codex:review) and NOT for trivial changes.
---

# Grill-Me-Codex — Get Grilled, Then Get Reviewed

Two acts, two different jobs:

- **Act 1 fixes the #1 failure mode: building the wrong thing.** Claude interrogates *you* until intent is locked — no guessing at ambiguity. (This act is Matt Pocock's `grill-me`, used under MIT — see `THIRD-PARTY-NOTICES.md`.)
- **Act 2 fixes the #2 failure mode: a plan that sounds right but breaks.** A *different model* (Codex) adversarially attacks the locked plan. Cross-model = no echo chamber.

You enter at two points only: answering the grill, and signing off the converged plan. Codex is read-only the whole time and never touches a file.

---

## ACT 1 — GRILL (you ↔ Claude)

> Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.
>
> Ask the questions one at a time, waiting for my answer before continuing. Asking multiple questions at once is bewildering.
>
> If a *fact* can be found by exploring the codebase, look it up rather than asking me. The *decisions*, though, are mine — put each one to me and wait for my answer.
>
> Do not write `PLAN.md` or proceed to Act 2 until I confirm we have reached a shared understanding.
>
> **Coherence default:** a feature that builds on existing features inherits the existing building blocks across every layer (UI components, backend services/calculations, data paths, conventions). The grill locks only the deltas (what is intentionally excluded/restricted/different, each with a reason) and the consumer walk-through (what the receiving user sees/gets). A parallel rebuild of something that exists is a defect, not a design option.

### Cross-cutting fork — pattern vs. concept (before plan-lock)

Is the change **cross-cutting** (a new pattern OR a new data structure/domain distinction, touching ≥3 places, OR "everywhere / distinguish X of Y / migrate")? Then classify it **during the grill** — don't defer it to the post-spec self-critique; the classification becomes part of the `PLAN.md` that Codex reviews in Act 2:

- **Pattern** (old→new, e.g. TanStack Query replacing manual loading): the denominator is **grep-able** → put in the plan: a census of all old spots + a `*.guard.test.ts` that stays red as long as old spots exist outside a shrinking allowlist.
- **Concept** (a new distinction, e.g. Project↔Campaign): `grep` cannot find the **absence** of a concept → put in the plan: a **code-derived** surface list (routes/pages/exports/reports) × a **domain verdict per surface** (counts / N/A / open); "counts" rows become tracked items.

Never claim "complete" from plan/memory — count the denominator fresh, report `X of Y`. Substance, trigger threshold + guard template → the project convention file `docs/conventions/spec-completeness.md` (if present), §Cross-cutting fork.

### Census preflight before plan-lock

For a cross-cutting plan, run `python3 .claude/hooks/drift-guard.py --census-status` before locking it. When an activated census reports `block_handoff: true` (including stale or open surfaces), stop the lock, run `$census-update`, resolve the findings, and retry. When the census is disabled or not activated, keep the status visible and perform the existing manual surface walk; do not replace that walk with census guesses.

When the decision tree is resolved and we're aligned, **write the agreed plan to `PLAN.md`** in this structure, then move to Act 2:

> **Where to write it:** `PLAN.md` + `PLAN-REVIEW-LOG.md` are per-session scratch — write them in the working directory the implementing session will actually use, and invoke the wrapper from that directory. A project may gitignore these files, so don't rely on git to carry them across checkouts/worktrees. In worktree-based repos, create the issue worktree BEFORE this write and plan inside it.

```markdown
# Plan: <task>
_Locked via grill — by Claude + <user>_

## Goal
<one paragraph — reflects what the grilling actually settled>

## Approach
<numbered, concrete steps>

## Key decisions & tradeoffs
<the contestable choices the grill resolved — name them so Codex has something to bite>

## Risks / open questions
<anything still genuinely open>

## Out of scope
<bounds the grill established>
```

Initialize `PLAN-REVIEW-LOG.md`:
```markdown
# Plan Review Log: <task>
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=<n>.
```

---

## ACT 2 — REVIEW (Claude ↔ Codex)

Now hand the locked plan to Codex for adversarial review. Same engine, mechanics verified end-to-end (2026-06-04).

### Prerequisites (verify once, fast)
- Let `scripts/codex-exec.sh` preflight Codex before launch. It enforces the
  exact tested-version allowlist, authentication, platform, and capabilities;
  surface any failure rather than retrying silently.
- Do NOT pin `-m`. Use the config default. Pinning `gpt-5.x-codex` variants 400s on ChatGPT-account auth.
- **Echo the active model before Round 1** so the user can confirm: read the `model` line from `~/.codex/config.toml` (absent = "CLI default"); state it alongside the resolved tunables. If the user objects, stop before burning a round.

### Tunables (read from args, else default)
| Var | Default | Meaning |
|-----|---------|---------|
| `MAX_ROUNDS` | `5` | Hard cap on review rounds. The loop ALWAYS terminates here. |
| `PLAN_FILE` | `PLAN.md` | The plan Act 1 produced. |
| `LOG_FILE` | `PLAN-REVIEW-LOG.md` | Append-only argument transcript. The artifact. |

If invoked with e.g. `rounds=3`, use that for `MAX_ROUNDS`. Echo resolved values before starting.

### The review prompt (sent each round)
> You are an adversarial reviewer for an implementation plan. Be skeptical and specific — your job is to find what breaks, not to be agreeable. Read the plan at `PLAN.md` and any repo files you need (you are read-only). Identify concrete flaws: security holes, race conditions, missing edge cases, schema conflicts, wrong assumptions, observability gaps, simpler alternatives. For each, give a one-line fix. Do NOT modify any files. End your reply with EXACTLY one line: `VERDICT: APPROVED` if the plan is sound enough to implement, or `VERDICT: REVISE` if it still has material problems.

Use this guard for every wrapper round. The conditional assignment is safe
under `set -e`: a non-zero wrapper exit reaches the structured failure branch
instead of terminating before cleanup.

```bash
run_codex_round() {
  if ROUND_RESULT=$("$@"); then
    ROUND_EXIT=0
  else
    ROUND_EXIT=$?
  fi
  ROUND_STATUS=$(printf '%s\n' "$ROUND_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status", "EXEC_FAILED"))')
  if (( ROUND_EXIT != 0 )) || [[ "$ROUND_STATUS" != OK ]]; then
    printf '%s\n' "$ROUND_RESULT" >&2
    FAILED_RUN_ID=$(printf '%s\n' "$ROUND_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("runId", ""))')
    if [[ -z "$FAILED_RUN_ID" && "${2:-}" == resume ]]; then
      FAILED_RUN_ID=${3:-}
    fi
    if [[ -n "$FAILED_RUN_ID" ]]; then
      scripts/codex-exec.sh abort "$FAILED_RUN_ID"
    fi
    if [[ "$ROUND_STATUS" == HUNG ]]; then
      printf '%s\n' 'STOP: ask the user whether to retry once with a fresh run or continue without cross-model review.' >&2
    fi
    return 1
  fi
  RUN_ID=$(printf '%s\n' "$ROUND_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')
  CODEX_REPORT=$(printf '%s\n' "$ROUND_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["verdict"])')
}
```

### Round 1 — fresh wrapper-owned session

```bash
run_codex_round scripts/codex-exec.sh new --profile review --mode read-only --prompt "$REVIEW_PROMPT" || exit 1
```

### Rounds 2..MAX — resume the SAME session

```bash
run_codex_round scripts/codex-exec.sh resume "$RUN_ID" --prompt "I revised the plan. Re-review PLAN.md — check whether your prior findings are addressed and flag anything new. End with VERDICT: APPROVED or VERDICT: REVISE." || exit 1
```

The wrapper persists read-only mode and owns stdin closure, hang detection, the
overall timeout, stderr redaction, and its process group. The guard surfaces
every structured failure, aborts only when the result or a resume call supplies
a known run ID, executes the `HUNG` user-choice path, and stops before report
handling. Never inspect, signal, or kill foreign Codex processes.

### Each round, after Codex returns
1. Read `CODEX_REPORT`; append to `LOG_FILE`: `## Round <n> — Codex` + the full critique.
2. Grep the last line for the verdict:
   - `VERDICT: APPROVED` → break to Resolution (converged).
   - `VERDICT: REVISE` → Claude decides **what's actually worth acting on** (Claude is final arbiter — Codex advises, doesn't command). Revise `PLAN_FILE`. Append `### Claude's response` to `LOG_FILE`: what changed, what was rejected, why. Increment round.
3. If round > `MAX_ROUNDS` → break to Resolution (deadlock).

After harvesting the final report and updating the log, delete the successful
run state:

```bash
scripts/codex-exec.sh finalize "$RUN_ID"
```

### Resolution (you sign off — final gate)
- **APPROVED:** present the final `PLAN_FILE`, a 3-bullet summary of what the two acts improved, and the round count. Ask: *"Grilled + survived N rounds of Codex. Implement it now — Codex builds it (`/codex-build`), Claude builds it, or stop here?"* Code only on a yes. **No code is written during either act.**
- **MAX_ROUNDS hit without APPROVED (deadlock):** do NOT fake convergence. List each unresolved point + Claude's counter-position; hand it to the user to break the tie. A flagged disagreement beats a false "approved."

### ACT 3 (optional) — BUILD (Codex ↔ Claude, roles flipped)

If the user picks Codex: invoke the `codex-build` skill with `SPEC_FILE=PLAN.md` and the same `LOG_FILE` — it appends `## Act 3 — Build` to the log, so one artifact tells the whole story (grilled → reviewed → built → verified). Roles flip: Codex writes the code in a bounded workspace-write sandbox, Claude reviews the diff and runs the proof. If the user picks Claude, implement directly as usual.

---

## Hard rules
- Act 1 always precedes Act 2 — don't write `PLAN.md` until the grill has actually resolved the decision tree with the user.
- Codex is read-only EVERY round — establish it once through the wrapper's
  `review` + `read-only` new call; every resume inherits it.
- The loop ALWAYS terminates at `MAX_ROUNDS`.
- Claude is final arbiter on every REVISE — incorporate good critiques, reject bad ones *with a logged reason*. Don't cave to everything (defeats the cross-model check) and don't ignore it (defeats the point).
- Code only after the user's final sign-off.
- `LOG_FILE` is the deliverable — keep the whole argument.

## What NOT to do
- Don't review already-written code — that's `/codex:review`.
- Don't pin a `-codex` model variant on ChatGPT-account auth — it 400s.
- Don't let Codex edit files. Read-only, always.
- Don't skip Act 1 — the grill is half the value.
