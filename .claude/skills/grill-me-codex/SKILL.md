---
name: grill-me-codex
description: Two-act plan hardening. ACT 1 (you ↔ Claude) — Claude interviews you relentlessly about a plan or design, one question at a time, recommending an answer for each and exploring the codebase when it can answer itself, until every branch of the decision tree is resolved. ACT 2 (Claude ↔ Codex) — Claude writes the locked plan to PLAN.md and OpenAI Codex adversarially reviews it in a read-only sandbox (VERDICT:APPROVED/REVISE), Claude revises and re-submits to the SAME Codex session until APPROVED or a MAX_ROUNDS cap, then you sign off before any code. Use when the user says "/grill-me-codex", "grill me then have codex review", "grill me and stress-test the plan", "interview me about this plan then get a second model on it", or is about to build something high-stakes (auth, schema, concurrency, migrations, payments) and wants both alignment AND a cross-model sanity check before implementation. Builds on Matt Pocock's grill-me (MIT). For the docs-aware variant use /grill-with-docs-codex; if you already have a plan and want only the Codex review use /codex-review. NOT for reviewing already-written code (use /codex:review) and NOT for trivial changes.
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill grill-me-codex --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

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

> **Where to write it:** `PLAN.md` + `PLAN-REVIEW-LOG.md` are per-session scratch — write them where this session already runs, and invoke the wrapper from that directory. Planning creates no worktree: a worktree isolates a build, so it belongs to the implementing session, which creates it when the build starts. A project may gitignore these files, so don't rely on git to carry them across checkouts/worktrees; being ignored is also what makes them scratch, deletable at teardown and needing no cleanup step of their own.
>
> **Durable output is the opposite case:** decision records, glossary edits and research notes this grill produced are ordinary work and have to reach a commit. Land them with `$wrapup` — a planning session with no worktree takes its Content route, which claims an explicitly confirmed file list and opens the ordinary PR, with no teardown half. Never leave them behind as an uncommitted session leftover.

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

Before dispatch, resolve a provider-neutral Routing intent — an explicit intent
block first, otherwise the workflow classifier — and authorize the whole run
once through a Dispatch plan whose hash binds every unit, intent, route and
reason. Dispatch only through `src/lib/routeDispatcher.mjs`, and require a
Dispatch receipt from the shared spawn guard that carries the authorization id
the plan recorded. A detected transport is not authorization; AFK dispatch
stops unless requested/applied route, model/effort enforcement, environment
precedence, and catalog/access/policy revisions are proved.

`scripts/codex-exec.sh` is the transport that decision names, never a
second router: the wrapper applies the resolved pair and its rollout file
is the readback the receipt quotes. Echoing a config default is not proof.

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

### Rounds 2..MAX — resume the SAME session

```bash
if ROUND_RESULT=$(scripts/codex-exec.sh resume "$RUN_ID" --prompt "I revised the plan. Re-review PLAN.md — check whether your prior findings are addressed and flag anything new. End with VERDICT: APPROVED or VERDICT: REVISE."); then
  CODEX_REPORT=$(printf '%s\n' "$ROUND_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["verdict"])')
else
  FAILURE_RESULT=$(scripts/codex-exec.sh handle-failure --result "$ROUND_RESULT" --run-id "$RUN_ID") || :
  printf '%s\n' "$FAILURE_RESULT" >&2
  exit 1
fi
```

The wrapper persists read-only mode and owns stdin closure, hang detection, the
overall timeout, stderr redaction, and its process group. `handle-failure`
surfaces the structured status and cleanup metadata, then the caller stops
before report handling. A surfaced `HUNG` returns to the user for the choice to
retry once with a fresh run or sign off without cross-model review. Never
inspect, signal, or kill foreign Codex processes.

Separately, cancellation or a decision to stop orchestration after an OK round
but before normal finalize must abort the known run:

```bash
scripts/codex-exec.sh abort "$RUN_ID"
```

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
