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
> If a question can be answered by exploring the codebase, explore the codebase instead.
>
> **Coherence default:** a feature that builds on existing features inherits the existing building blocks across every layer (UI components, backend services/calculations, data paths, conventions). The grill locks only the deltas (what is intentionally excluded/restricted/different, each with a reason) and the consumer walk-through (what the receiving user sees/gets). A parallel rebuild of something that exists is a defect, not a design option.

### Querschnitts-Weiche — Muster vs. Konzept (vor Plan-Lock)

Ist die Änderung **querschnittig** (neues Muster/Pattern ODER neue Datenstruktur/Domänen-Unterscheidung, betrifft ≥3 Stellen, ODER „überall / X von Y unterscheiden / migrieren")? Dann **während des Grills** klassifizieren — nicht in die Post-Spec-Self-Critique vertagen; die Klassifizierung wird Teil des `PLAN.md`, den Codex in Act 2 reviewt:

- **Muster** (Alt→Neu, z.B. TanStack-Query ersetzt manuelles Laden): der Nenner ist **grep-bar** → in den Plan: Census aller Alt-Stellen + ein `*.guard.test.ts`, der rot bleibt, solange Alt-Stellen außerhalb einer schrumpfenden Allowlist existieren.
- **Konzept** (neue Unterscheidung, z.B. Projekt↔Kampagne): `grep` findet die **Abwesenheit** eines Konzepts nicht → in den Plan: eine **code-abgeleitete** Flächen-Liste (Routen/Seiten/Exporte/Auswertungen) × **fachliches Verdikt pro Fläche** (zählt / N/A / offen); „zählt"-Zeilen werden getrackte Items.

„vollständig" nie aus Plan/Gedächtnis behaupten — Nenner frisch zählen, `X von Y` melden. Substanz, Trigger-Schwelle + Guard-Template → die Projekt-Konvention-Datei `docs/conventions/spec-completeness.md` (falls vorhanden), §Querschnitts-Weiche.

When the decision tree is resolved and we're aligned, **write the agreed plan to `PLAN.md`** in this structure, then move to Act 2:

> **Where to write it:** `PLAN.md` + `PLAN-REVIEW-LOG.md` are per-session scratch — write them in the working directory the implementing session will actually use, and run Codex from there (`-C <dir>` on the round-1 `exec`; `exec resume` rejects both `-C` and `-s`, so run resume from that cwd and force read-only via `-c sandbox_mode="read-only"`). A project may gitignore these files, so don't rely on git to carry them across checkouts/worktrees. In worktree-based repos, create the issue worktree BEFORE this write and plan inside it.

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
- `codex --version` ≥ 0.130 (older CLIs error on the default `gpt-5.5` model).
- Codex authenticated (prior `codex login`; ChatGPT account is fine). On auth/model error, surface it — don't silently retry.
- Do NOT pin `-m`. Use the config default. Pinning `gpt-5.x-codex` variants 400s on ChatGPT-account auth.

### Tunables (read from args, else default)
| Var | Default | Meaning |
|-----|---------|---------|
| `MAX_ROUNDS` | `5` | Hard cap on review rounds. The loop ALWAYS terminates here. |
| `PLAN_FILE` | `PLAN.md` | The plan Act 1 produced. |
| `LOG_FILE` | `PLAN-REVIEW-LOG.md` | Append-only argument transcript. The artifact. |

If invoked with e.g. `rounds=3`, use that for `MAX_ROUNDS`. Echo resolved values before starting.

### The review prompt (sent each round)
> You are an adversarial reviewer for an implementation plan. Be skeptical and specific — your job is to find what breaks, not to be agreeable. Read the plan at `PLAN.md` and any repo files you need (you are read-only). Identify concrete flaws: security holes, race conditions, missing edge cases, schema conflicts, wrong assumptions, observability gaps, simpler alternatives. For each, give a one-line fix. Do NOT modify any files. End your reply with EXACTLY one line: `VERDICT: APPROVED` if the plan is sound enough to implement, or `VERDICT: REVISE` if it still has material problems.

### Round 1 — fresh session (capture `thread_id`)
Stream `--json` to a FILE, never pipe to `grep` — `codex exec --json | grep` deadlocks on codex-cli ≥0.137. **Always launch with `< /dev/null`** — a backgrounded `codex exec … &` without it blocks on stdin and sits at **0 CPU / 0 bytes** forever (the #1 cause of the "silent hang"; verified 2026-06-09). Background it so a **90s liveness probe** still catches a genuine sandbox deadlock.
```bash
CODEX_TMP="/tmp/codex-$(pwd | sha1sum | cut -c1-8)"; mkdir -p "$CODEX_TMP"   # run-unique per worktree cwd: STABLE across round-1+resume turns, collision-free under parallel sessions
codex exec -s read-only --json -o $CODEX_TMP/verdict.txt "$(cat REVIEW_PROMPT)" \
  < /dev/null > $CODEX_TMP/r1.jsonl 2>/dev/null &
CODEX_PID=$!
sleep 90                                          # liveness probe (REQUIRED)
if kill -0 "$CODEX_PID" 2>/dev/null; then
  CPU=$(ps -o time= -p "$CODEX_PID" 2>/dev/null | tr -dc '0-9:')   # cumulative CPU, e.g. 00:00:00
  BYTES=$(wc -c < $CODEX_TMP/r1.jsonl 2>/dev/null || echo 0)
  if [ "${CPU:-00:00:00}" = "00:00:00" ] && [ "${BYTES:-0}" -eq 0 ]; then
    kill -9 "$CODEX_PID" 2>/dev/null; echo "CODEX-HUNG"   # alive + 0 CPU + 0 bytes = blocked, NOT working
  fi
fi
wait "$CODEX_PID" 2>/dev/null
THREAD_ID=$(grep -o '"thread_id":"[^"]*"' $CODEX_TMP/r1.jsonl | head -1 | cut -d'"' -f4)
```
- **`CODEX-HUNG` printed** (alive + 0 CPU + 0 bytes at 90s) → **first suspect the stdin block**: confirm the launch has `< /dev/null` and retry. That fixes it in nearly every case. **NEVER `pgrep`/`kill` codex procs to "clear contention"** — that murders the user's live, unrelated codex sessions and does **not** fix a stdin hang. Only if `< /dev/null` is present and it still hangs (genuine sandbox deadlock) → **STOP Act 2**: tell the user, offer to sign off without the cross-model review or retry once. Don't touch other codex processes.
- **Healthy:** CPU climbs past `00:00:00` and/or `$CODEX_TMP/r1.jsonl` grows; `THREAD_ID` parses; critique lands in `$CODEX_TMP/verdict.txt`. `2>/dev/null` hides cosmetic MCP/auth noise.
- **Clean finish but no verdict file + no `THREAD_ID`** = auth/model failure → stop, tell the user.

### Rounds 2..MAX — resume the SAME session (Codex remembers its prior critiques)
```bash
# resume REJECTS -s. Force read-only via -c sandbox_mode, or Codex inherits
# config.toml (possibly danger-full-access) and could WRITE files. This is the
# single most important safety line in the skill — verified 2026-06-04.
CODEX_TMP="/tmp/codex-$(pwd | sha1sum | cut -c1-8)"; mkdir -p "$CODEX_TMP"   # run-unique per worktree cwd: STABLE across round-1+resume turns, collision-free under parallel sessions
codex exec resume "$THREAD_ID" -c sandbox_mode="read-only" --json \
  -o $CODEX_TMP/verdict.txt \
  "I revised the plan. Re-review PLAN.md — check whether your prior findings are addressed and flag anything new. End with VERDICT: APPROVED or VERDICT: REVISE." \
  < /dev/null 2>/dev/null >/dev/null &
```
Wrap resume in the **same 90s liveness probe** (background + `wait`). Resume discards the `--json` stream, so probe on the verdict file: `BYTES=$(wc -c < $CODEX_TMP/verdict.txt)` plus the `CPU` check — `00:00:00` CPU + empty verdict at 90s → kill, treat as `CODEX-HUNG`, same STOP path as round 1. Both `codex exec` and `codex exec resume` support `--json` and `-o/--output-last-message`.

### Each round, after Codex returns
1. Read `$CODEX_TMP/verdict.txt`; append to `LOG_FILE`: `## Round <n> — Codex` + the full critique.
2. Grep the last line for the verdict:
   - `VERDICT: APPROVED` → break to Resolution (converged).
   - `VERDICT: REVISE` → Claude decides **what's actually worth acting on** (Claude is final arbiter — Codex advises, doesn't command). Revise `PLAN_FILE`. Append `### Claude's response` to `LOG_FILE`: what changed, what was rejected, why. Increment round.
3. If round > `MAX_ROUNDS` → break to Resolution (deadlock).

### Resolution (you sign off — final gate)
- **APPROVED:** present the final `PLAN_FILE`, a 3-bullet summary of what the two acts improved, and the round count. Ask: *"Grilled + survived N rounds of Codex. Implement it now?"* Code only on yes. **No code is written during either act.**
- **MAX_ROUNDS hit without APPROVED (deadlock):** do NOT fake convergence. List each unresolved point + Claude's counter-position; hand it to the user to break the tie. A flagged disagreement beats a false "approved."

---

## Hard rules
- Act 1 always precedes Act 2 — don't write `PLAN.md` until the grill has actually resolved the decision tree with the user.
- Codex is read-only EVERY round — `-s read-only` first call, `-c sandbox_mode="read-only"` on every resume (resume has no `-s`). It never writes.
- The loop ALWAYS terminates at `MAX_ROUNDS`.
- Claude is final arbiter on every REVISE — incorporate good critiques, reject bad ones *with a logged reason*. Don't cave to everything (defeats the cross-model check) and don't ignore it (defeats the point).
- Code only after the user's final sign-off.
- `LOG_FILE` is the deliverable — keep the whole argument.

## What NOT to do
- Don't review already-written code — that's `/codex:review`.
- Don't pin a `-codex` model variant on ChatGPT-account auth — it 400s.
- Don't let Codex edit files. Read-only, always.
- Don't skip Act 1 — the grill is half the value.
