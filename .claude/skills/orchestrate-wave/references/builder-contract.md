# Builder Contract — template (fill slots, embed VERBATIM)

SSOT for every delegated slice prompt in `orchestrate-wave` Phase 2. The
orchestrator copies the block below and fills the `{{SLOTS}}` with verbatim
material from the locked plan/issue — never paraphrased (paraphrase drift has
produced real contract errors). Tier + effort per SKILL.md §Standing rules →
Routing.

The **Hard rules** and **Commands** sections below carry generic defaults so the
template is never shipped with an unresolved project slot. When a project layer
is present (`orchestrate-wave` Phase 0 probe → `§Builder Hard Rules` /
`§Builder Commands`), the orchestrator REPLACES the generic lines with the
project's exact rules and commands before dispatch — the builder must see exact
commands, not "your project's tests".

```text
You are the implementer for slice #{{ISSUE}} of wave #{{ANCHOR}}.
Worktree: {{WORKTREE_PATH}} (branch {{BRANCH}}) — work ONLY here.

## Scope (verbatim from issue/plan — do not reinterpret)
{{WHAT_AND_AC_VERBATIM}}

## Plan decisions that bind you
{{PLAN_DECISIONS_VERBATIM}}

## File map (recon)
{{FILE_LINE_MAP}}
{{CONSUME_ONLY_LINES}}

## Hard rules
- Follow this project's UI/content conventions (from the project layer
  §Builder Hard Rules — e.g. UI-text language, design tokens, formatters).
  Absent a project layer: match the surrounding code's conventions exactly.
- Size gates (recommended default): no new file >300 lines, no function >50
  lines — unless the project sets its own limit.
- If your slice adds a guard/helper/auth-check: WIRE it into its consumer + add a
  negative test — an unwired helper is dead code.
- STOP + report on any contract ambiguity — do NOT guess (this discipline has
  caught real contract errors).
- Do NOT run a browser/E2E or a dev server — the orchestrator verifies centrally.

## Commands (exact — deviations produce false reds)
Run, for EVERY package you edit: your package's unit tests for the files you
touched, a typecheck, and the project's fast pre-PR gate. State the EXACT
commands here from the project layer §Builder Commands. Absent a project layer,
use: run your package tests + typecheck + fast gate, and name the exact
invocation for each in this prompt so the builder cannot guess a wrong one.

## Workflow order (non-negotiable)
1. Implement (red→green test-first where the slice has logic).
2. Commit your ONE commit on the slice branch FIRST — before any longer verify
   (verify-then-forget-to-commit leaves the orchestrator hand-committing your
   worktree). Do NOT push. Do NOT `--no-verify` (pre-commit hooks must pass).
3. Run the commands above. Never end your turn with a background command still
   running.

## Report back (concise)
Files touched · decisions taken · test results (exact output) · commit SHA ·
STOP items · what the orchestrator should visually verify.
```

Orchestrator notes:

- `{{CONSUME_ONLY_LINES}}` come from the Phase-1 reconciliation, e.g.
  "X already exists in `<file>` — do NOT add it, consume only."
- For dependent slices, fill hub artifact paths from the hub agent's report
  (Phase 2 "capture reusable names"), not from the plan's guesses.
