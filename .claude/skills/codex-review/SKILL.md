---
name: codex-review
description: A standalone adversarial PLAN-review loop where Claude Code (builder) and OpenAI Codex (read-only critic) tag-team an implementation plan before any code is written. Use this when you ALREADY have a plan or a clear idea and just want the cross-model stress-test — no requirements interview first. Claude drafts/loads the plan into PLAN.md, Codex reviews it in a read-only sandbox and returns VERDICT:APPROVED or VERDICT:REVISE, Claude revises and re-submits to the SAME Codex session (context preserved) until APPROVED or a configurable MAX_ROUNDS cap is hit. Human approves the converged plan before code. Use when the user says "/codex-review", "codex review my plan", "have Codex review my plan", "argue this plan with Codex", "adversarial plan review", "make Claude and Codex argue/fight over the plan", or is about to build something high-stakes (auth, schema, concurrency, migrations, payments) and wants a second-model sanity check on the PLAN before implementation. For a guided requirements interview BEFORE the review, use /grill-me-codex instead. NOT for reviewing already-written CODE (that is the Codex plugin's /codex:review) and NOT for trivial changes.
---

# Codex-Review — Adversarial Plan-Review Loop

Two models, one plan, a bounded argument. **Claude is the builder and orchestrator. Codex is a read-only critic** that can read the repo and the plan but cannot touch a single file. They communicate strictly through `PLAN.md` + a Codex session that persists across rounds. The human enters at exactly two points: kickoff and final sign-off.

This is a **deliberate, high-stakes tool** — reach for it on auth, data models, concurrency, migrations, payments, anything expensive to get wrong. Skip it for obvious/cheap work.

## Prerequisites (verify once, fast)

- Codex CLI installed and recent: `codex --version` (need ≥ 0.130; the default `gpt-5.5` model errors on older CLIs).
- Codex authenticated: a prior `codex login` (ChatGPT account is fine). If a run returns an auth/model error, surface it to the user — do not silently retry.
- Do NOT pin `-m` unless the user asks. The user's `~/.codex/config.toml` default model is used. Pinning `gpt-5.x-codex` variants fails on ChatGPT-account auth.
- **Sandbox flag differs between the two commands.** `codex exec` accepts `-s read-only`. `codex exec resume` does NOT — it rejects `-s` ("unexpected argument"). On resume you MUST force read-only via `-c sandbox_mode="read-only"`, because `config.toml` may default `sandbox_mode` to `danger-full-access` (+ `approval_policy="never"`) — which would let Codex WRITE files mid-loop. This is the single most important safety detail in this skill: verified end-to-end on 2026-06-04.

## Tunable variables (read from skill args, else default)

| Var | Default | Meaning |
|-----|---------|---------|
| `MAX_ROUNDS` | `5` | Hard cap on review rounds. The loop ALWAYS terminates at this. |
| `PLAN_FILE` | `PLAN.md` | Where the evolving plan lives (repo root). |
| `LOG_FILE` | `PLAN-REVIEW-LOG.md` | Append-only transcript of the argument (every round's critique + what changed). The artifact. |

If the user invoked the skill with an argument like `rounds=3`, use that for `MAX_ROUNDS`. Echo the resolved values back before starting.

## Flow

### Step 0 — Kickoff (human gate #1)

The invocation itself is the kickoff. Confirm scope in one line: what is being planned. If the user gave no task, ask for it (one question). Then proceed — do NOT ask for approval round-by-round; that comes at the end.

### Step 1 — Claude plans

Do real planning: read the relevant code, think through the approach, surface decisions and tradeoffs. Then write the plan to `PLAN_FILE` in this structure:

> **Where to write it:** `PLAN.md` + `PLAN-REVIEW-LOG.md` are per-session scratch — write them in the working directory the implementing session will actually use, and run Codex from there (`-C <dir>` on the round-1 `exec`; `exec resume` rejects both `-C` and `-s`, so run resume from that cwd and force read-only via `-c sandbox_mode="read-only"`). A project may gitignore these files, so don't rely on git to carry them across checkouts/worktrees. In worktree-based repos, create the issue worktree BEFORE this write and plan inside it.

```markdown
# Plan: <task>
_Round 0 — initial draft by Claude_

## Goal
<one paragraph>

## Approach
<numbered steps, concrete>

## Key decisions & tradeoffs
<the contestable choices — name them explicitly so Codex has something to bite>

## Risks / open questions
<what you're unsure about>

## Out of scope
<bounds>
```

Initialize `LOG_FILE`:
```markdown
# Plan Review Log: <task>
Started <stamp the user's local time if known, else "session start">. MAX_ROUNDS=<n>.
```

Show the user the plan inline and say you're sending it to Codex for adversarial review.

### Step 2 — The loop

Maintain `ROUND` (start 1) and `THREAD_ID` (empty until round 1 returns).

**The review prompt** sent to Codex each round (adjust the task line):

> You are an adversarial reviewer for an implementation plan. Be skeptical and specific — your job is to find what breaks, not to be agreeable. Read the plan at `PLAN.md` (and any repo files you need; you are read-only). Identify concrete flaws: security holes, race conditions, missing edge cases, schema conflicts, wrong assumptions, observability gaps, simpler alternatives. For each, give a one-line fix. Do NOT modify any files. End your reply with EXACTLY one line: `VERDICT: APPROVED` if the plan is sound enough to implement, or `VERDICT: REVISE` if it still has material problems.

**Round 1** (creates the session — capture `thread_id`):

Stream `--json` to a FILE, never pipe to `grep` — `codex exec --json | grep` deadlocks on codex-cli ≥0.137. **Always launch with `< /dev/null`** — a backgrounded `codex exec … &` without it blocks on stdin and sits at **0 CPU / 0 bytes** forever (the #1 cause of the "silent hang"; verified 2026-06-09). Background it so a **90s liveness probe** still catches a genuine sandbox deadlock.

```bash
codex exec -s read-only --json -o /tmp/codex-verdict.txt "$(cat REVIEW_PROMPT)" \
  < /dev/null > /tmp/codex-r1.jsonl 2>/dev/null &
CODEX_PID=$!
sleep 90                                          # liveness probe (REQUIRED)
if kill -0 "$CODEX_PID" 2>/dev/null; then
  CPU=$(ps -o time= -p "$CODEX_PID" 2>/dev/null | tr -dc '0-9:')   # cumulative CPU, e.g. 00:00:00
  BYTES=$(wc -c < /tmp/codex-r1.jsonl 2>/dev/null || echo 0)
  if [ "${CPU:-00:00:00}" = "00:00:00" ] && [ "${BYTES:-0}" -eq 0 ]; then
    kill -9 "$CODEX_PID" 2>/dev/null; echo "CODEX-HUNG"   # alive + 0 CPU + 0 bytes = blocked, NOT working
  fi
fi
wait "$CODEX_PID" 2>/dev/null
THREAD_ID=$(grep -o '"thread_id":"[^"]*"' /tmp/codex-r1.jsonl | head -1 | cut -d'"' -f4)
```
- **`CODEX-HUNG` printed** (alive + 0 CPU + 0 bytes at 90s) → **first suspect the stdin block**: confirm the launch has `< /dev/null` and retry. That fixes it in nearly every case. **NEVER `pgrep`/`kill` codex procs to "clear contention"** — that murders the user's live, unrelated codex sessions and does **not** fix a stdin hang. Only if `< /dev/null` is present and it still hangs (genuine sandbox deadlock) → **STOP**: tell the user, offer to proceed without the cross-model review or retry once. Don't touch other codex processes.
- **Healthy:** CPU climbs past `00:00:00` and/or `/tmp/codex-r1.jsonl` grows; `THREAD_ID` parses; critique lands in `/tmp/codex-verdict.txt`. `2>/dev/null` hides cosmetic MCP/auth noise.
- **Clean finish but no verdict file + no `THREAD_ID`** = auth/model failure → stop, tell the user.

**Rounds 2..MAX** (resume the SAME session — Codex remembers its earlier critiques, won't re-litigate settled points):

```bash
# NOTE: resume rejects -s. Force read-only via -c sandbox_mode, or Codex
# inherits config.toml (possibly danger-full-access) and could write files.
codex exec resume "$THREAD_ID" -c sandbox_mode="read-only" --json \
  -o /tmp/codex-verdict.txt \
  "I revised the plan. Re-review PLAN.md. Same rules. End with VERDICT: APPROVED or VERDICT: REVISE." \
  < /dev/null 2>/dev/null >/dev/null &
```
Wrap resume in the **same 90s liveness probe** (background + `wait`). Resume discards the `--json` stream, so probe on the verdict file: `BYTES=$(wc -c < /tmp/codex-verdict.txt)` plus the `CPU` check — `00:00:00` CPU + empty verdict at 90s → kill, treat as `CODEX-HUNG`, same STOP path as round 1.

Both `codex exec` and `codex exec resume` support `--json` (stream → parse `thread_id` first round) and `-o/--output-last-message` (verdict capture).

**Each round, after Codex returns:**
1. Read `/tmp/codex-verdict.txt`. Append to `LOG_FILE`: `## Round <n> — Codex` + the full critique.
2. Grep the last line for the verdict token.
   - `VERDICT: APPROVED` → break the loop, go to Step 3 (converged).
   - `VERDICT: REVISE` → Claude reads the critique, decides **what's actually worth acting on** (Claude has final say — Codex advises, it does not command). Revise `PLAN_FILE`. Append to `LOG_FILE`: `### Claude's response` + what you changed and what you rejected and why. Increment `ROUND`.
3. If `ROUND > MAX_ROUNDS` → break to Step 3 (deadlock).

### Step 3 — Resolution (human gate #2)

**If APPROVED:** Present to the user — the final `PLAN_FILE`, a 3-bullet summary of what the argument improved, and the round count. Ask: *"Plan survived N rounds of Codex. Implement it now?"* Only on a yes does Claude write code. **No code is written during the loop.**

**If MAX_ROUNDS hit without APPROVED (deadlock):** Do NOT pretend it converged. Surface the unresolved disagreements explicitly: list each point Codex still flags and Claude's counter-position. Hand it to the human to break the tie. This is a legitimate, useful outcome — a flagged disagreement beats a false "approved."

## Hard rules

- Codex is read-only EVERY round — `-s read-only` for the first call, `-c sandbox_mode="read-only"` for every resume (resume has no `-s`). It never writes. If you're tempted to give it write access, stop — that's a different skill.
- The loop ALWAYS terminates at `MAX_ROUNDS`. No unbounded recursion.
- Claude is the final arbiter on every REVISE — incorporate good critiques, reject bad ones *with a reason logged*. Don't cave to Codex on everything (that defeats the cross-model check) and don't ignore it (that defeats the point).
- Code only after human gate #2.
- `LOG_FILE` is the deliverable — it tells the whole story of the argument. Keep it complete.

## What NOT to do

- Don't use this to review existing code — that's `/codex:review`.
- Don't pin a `-codex` model variant on ChatGPT-account auth — it 400s.
- Don't skip the log — the argument transcript is the most valuable artifact.
- Don't let Codex edit files. Read-only, always.
