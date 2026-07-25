---
name: codex-build
description: Hand a frozen spec (PLAN.md or any locked plan) to OpenAI Codex to IMPLEMENT inside a bounded workspace-write sandbox, while Claude stays the spec-writer and reviewer — the exact role-flip of /codex-review. Codex builds from the spec against a declared allowed-write set, Claude reads the full diff like a contributor PR, runs the proof test, and iterates fixes via the SAME Codex session up to MAX_FIX_ROUNDS before taking over. Human approves the diff before any commit. Use when the user says "/codex-build", "have codex build this", "codex implement the plan", "hand the plan to codex", "delegate the build to codex", or right after a plan survives /grill-me-codex, /grill-with-docs-codex, or /codex-review and they choose Codex for implementation (Act 3). Also for standalone delegation — refactors, mechanical migrations, bug fixes with a known repro, test/coverage writing — anything that reads as a work order. NOT for tiny edits (~<20 lines — delegation overhead loses), NOT for design work (if writing the spec forces decisions, that's /grill-me-codex first), NOT for reviewing existing code (/codex:review), and NOT for anything needing Claude-session tools (MCP, secrets, browser).
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill codex-build --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# Codex-Build — Codex Types, Claude Verifies

> **Local adaptation note:** adapted from Chase AI's `codex-build` (which itself adapts Peter Steinberger's `codex-first` pattern). Upstream runs Codex with `--yolo` / full access; this fork deliberately does NOT — Codex writes inside a **workspace-write sandbox** against a **declared allowed-write set**, never `danger-full-access`, and the approval policy is never weakened. See `THIRD-PARTY-NOTICES.md`.

The role-flip of `/codex-review`: there, Claude builds the plan and Codex critiques read-only. Here, **Codex is the builder with bounded write access; Claude is the spec-writer and reviewer.** Codex implements a frozen spec end-to-end; Claude judges the diff like a contributor PR, demands proof, and iterates fixes in the same Codex session. The human enters at exactly two points: kickoff and diff sign-off.

**Spec quality decides success.** Codex starts with zero session context — everything it needs must be in the prompt. A plan that survived `/grill-me-codex` or `/codex-review` already is a frozen spec; that's the ideal input.

## Prerequisites (verify once, fast)

- Let `scripts/codex-exec.sh` preflight Codex before launch. It enforces the
  exact tested-version allowlist, authentication, platform, and capabilities;
  surface any failure rather than retrying silently.
- Do NOT pin `-m` or model config (e.g. `model_reasoning_effort`) unless the user asks. Pinning `gpt-5.x-codex` variants 400s on ChatGPT-account auth; config defaults come from `~/.codex/config.toml`.
- **Echo the active model at kickoff** so the user can confirm: read the `model` line from `~/.codex/config.toml` (absent = "CLI default"); state it with the resolved tunables. If the user objects, stop before launching the build.
- **Codex has a native image-generation tool** in delegated sessions (ChatGPT-account backed, no API key; upstream-verified 2026-07-08). Specs may therefore include "generate these image assets yourself" steps: name exact file paths, dimensions, and style in the prompt contract.
- Run the wrapper from the target working directory's root so every round keeps
  the same bounded workspace.

## Tunables (read from args, else default)

| Var | Default | Meaning |
|-----|---------|---------|
| `SPEC_FILE` | `PLAN.md` | The frozen spec Codex implements. |
| `MAX_FIX_ROUNDS` | `2` | Fix iterations via resume before Claude takes over and finishes directly. |
| `LOG_FILE` | `PLAN-REVIEW-LOG.md` | Append-only build transcript. If it exists (Act 1/2 ran), append `## Act 3 — Build`; else create it. |
| `PROOF_CMD` | from spec | Exact test/verify command Codex must run as proof. If the spec lacks one, ask the user ONE question to get it before launching. |

Echo resolved values before starting.

## Step 0 — Gates (before any Codex launch)

1. **Spec gate.** `SPEC_FILE` must exist and read as a work order (goal, concrete steps, bounds). No spec → offer `/grill-me-codex` (interview first) or `/codex-review` (have a plan, want it stress-tested) instead. If the user insists on building from a rough idea, write the spec WITH them first — that's design, and design stays with Claude.
2. **Clean-tree gate.** `git status -sb`. Dirty working tree → STOP and ask the user to commit or stash first. Non-negotiable: Codex writes files, and a dirty tree means its diff can't be isolated or cleanly reverted.
3. **Isolation gate.** Run on a dedicated feature branch — in worktree-based repos, in the slice's worktree, never the main tree. Codex's diff must be revertable without touching parallel work.
4. **Allowed-write set.** Derive from the spec the explicit set of files/directories Codex may create or modify (the spec's "Key paths" / file list). This goes into the prompt contract AND is enforced after every round (Step 3). Can't derive one → the spec is not a work order yet; sharpen it first.
5. Confirm scope in one line, then go. No round-by-round approvals; the human gate is at the end.

## Step 1 — The build prompt (contract, via temp file)

Never inline-quote the prompt — write it to a temp file. Fill this contract completely; when chained from a grill/review skill, derive it from the plan's sections:

```bash
CODEX_TMP="/tmp/codex-$(pwd | sha1sum | cut -c1-8)"; mkdir -p "$CODEX_TMP"   # run-unique per worktree cwd: stable across exec+resume turns, collision-free under parallel sessions
P="$CODEX_TMP/build-prompt.txt"
cat >"$P" <<'EOF'
GOAL: <one paragraph — what done looks like>
SPEC: Read <SPEC_FILE> at the repo root. It is a frozen, already-reviewed spec.
  Implement it exactly. If a step is impossible as written, implement the
  closest faithful version and report the deviation — do not redesign.
KEY PATHS: <files/dirs Codex will touch or must read first>
ALLOWED WRITES: <the explicit allowed-write set from Step 0.4 — Codex must not
  create or modify anything outside it; if the spec seems to require it,
  report instead of writing>
CONSTRAINTS: <"don't touch X", style rules, deps that must not change>
NON-GOALS: <explicitly out of scope — from the plan's Out of scope section>
PROOF: Run `<PROOF_CMD>` and include its full output in your report.
OUTPUT: End with a report — files changed (one line each: path + what/why),
  proof output, and any deviations from the spec with reasons.
EOF
```

## Step 2 — Launch Codex (fresh wrapper-owned session)

```bash
if ROUND_RESULT=$(scripts/codex-exec.sh new --profile build --mode workspace-write --prompt-file "$P"); then
  RUN_ID=$(printf '%s\n' "$ROUND_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["runId"])')
  CODEX_REPORT=$(printf '%s\n' "$ROUND_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["verdict"])')
else
  FAILURE_RESULT=$(scripts/codex-exec.sh handle-failure --result "$ROUND_RESULT") || :
  printf '%s\n' "$FAILURE_RESULT" >&2
  exit 1
fi
```

- The `build` profile establishes and persists `workspace-write`; never request
  `danger-full-access` or weaken the approval policy. The wrapper bounds Codex
  to the working directory, and the allowed-write gate (Step 3) narrows it to
  the declared set. Work outside those bounds belongs to Claude and must be
  split out of the spec.
- The wrapper owns stdin closure, hang detection, the overall build timeout,
  stderr redaction, and the launched process group. Never inspect, signal, or
  kill foreign Codex processes.
- `RUN_ID` is opaque. Retain it only for resume/finalize/abort; harvest the
  report from `CODEX_REPORT` before deleting run state.
- `handle-failure` surfaces every failed or cancelled structured result plus
  cleanup metadata; the caller then stops before report handling. A surfaced
  `HUNG` returns to the user for the choice to retry once with a fresh run or
  stop delegation and let Claude take over. Never target a process directly.

- **Heads-up on completion (required):** when a background Codex run finishes, the FIRST line of your next message to the user must be a loud standalone banner — `🔔 CODEX FINISHED — <what> (exit ok/fail) — verifying now` — BEFORE any verification output. The user is not watching tool calls; never let a completed build slide silently into the verify phase.

## Step 3 — Verify (Claude, always, never delegated)

Codex's report is advisory. Verify yourself:

1. **Allowed-write gate:** `git status --porcelain=v1` — every changed AND untracked path must be inside the allowed-write set from Step 0.4. Any path outside it is a finding: surface it to the user before anything else, and don't fold it silently into the diff review.
2. Read the FULL diff (`git diff`). Judge it like a contributor PR: correctness, spec fidelity, style match with surrounding code, nothing touched outside scope.
3. Run `PROOF_CMD` yourself (or the focused tests for the changed area). Codex's pasted output doesn't count as proof.
4. Append to `LOG_FILE` under `## Act 3 — Build`: `### Round <n> — Codex build` + `CODEX_REPORT` + `### Claude's verdict` + what passed/failed review.

## Step 4 — Fix loop (same session, bounded)

Problems found → resume the SAME session (Codex keeps its context; cheaper and better than a fresh run). Write the fix list to a second temp file (`$CODEX_TMP/fix-prompt.txt`), same contract discipline: exact problem, exact file, proof expected, same allowed-write set.

```bash
if ROUND_RESULT=$(scripts/codex-exec.sh resume "$RUN_ID" --prompt-file "$CODEX_TMP/fix-prompt.txt"); then
  CODEX_REPORT=$(printf '%s\n' "$ROUND_RESULT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["verdict"])')
else
  FAILURE_RESULT=$(scripts/codex-exec.sh handle-failure --result "$ROUND_RESULT" --run-id "$RUN_ID") || :
  printf '%s\n' "$FAILURE_RESULT" >&2
  exit 1
fi
```

The wrapper enforces the persisted workspace-write mode on every resume.
Re-verify (Step 3, including the allowed-write gate) after each round. After
`MAX_FIX_ROUNDS` failed rounds: abort this run, STOP delegating, and let Claude
take over and finish the remaining fixes directly. Log the takeover.

```bash
scripts/codex-exec.sh abort "$RUN_ID"
```

## Step 5 — Human gate (diff sign-off)

Present: 3-bullet summary of what was built, files-changed list, proof-test output (pass/fail, verbatim tail), rounds used, any spec deviations. Ask: *"Codex built it, proof passes, diff reviewed. Commit?"*

- On yes, harvest and log the final report, then delete the wrapper state before
  Claude commits:

  ```bash
  scripts/codex-exec.sh finalize "$RUN_ID"
  ```

- Commit ONLY after that finalize succeeds — and Claude writes the commit,
  never Codex.
- Rejected with another requested fix → keep the known run and route back to
  Step 4 (or take over directly if fix rounds are spent).
- Cancellation or a decision to stop delegation → abort the known run before
  returning control:

  ```bash
  scripts/codex-exec.sh abort "$RUN_ID"
  ```

## Hard rules

- Clean tree before launch. Always. No exceptions.
- **The mode is bounded every round:** establish `workspace-write` in the
  wrapper's new call and let every resume inherit it. Never `--yolo`, never
  `danger-full-access`, never a weakened approval policy — if the task can't
  be done inside those bounds, it isn't a Codex delegation.
- The allowed-write gate runs after EVERY round — out-of-set writes are findings, not noise.
- Claude never skips the diff read. Codex claims are advisory until Claude has read the diff and run the proof.
- Fix loop terminates at `MAX_FIX_ROUNDS` — then Claude takes over. No unbounded delegation ping-pong.
- Commits, pushes, releases, GitHub mutations: Claude-side only, after the human gate. Codex never commits.
- `LOG_FILE` is the deliverable — with Acts 1/2 it tells the whole story: grilled → reviewed → built → verified.

## What NOT to do

- Don't build without a spec — that's designing by delegation, and it fails. Route to `/grill-me-codex` or `/codex-review` first.
- Don't use for ~<20-line single-obvious-change edits — just make the edit.
- Don't pin `-codex` model variants on ChatGPT-account auth — 400s.
- Don't resume with `--last`; use the wrapper's explicit opaque `RUN_ID` so
  parallel sessions cannot target each other.
- Don't let Codex commit, and don't auto-commit yourself — human gate first.
