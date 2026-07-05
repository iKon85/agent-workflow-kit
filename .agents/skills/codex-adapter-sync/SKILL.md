---
name: codex-adapter-sync
description: "Use to audit and update the Codex adapter after changes to CLAUDE.md, package CLAUDE.md files, .claude/skills, .claude/agents, or Codex setup. Checks AGENTS.md, .agents/skills, .codex/config.toml, .codex/agents, and .gitignore for drift."
---

# Codex Adapter Sync

Use this skill when the user asks for a Codex adapter sync, Codex drift check,
Claude-to-Codex migration check, or when changes to Claude-facing project
knowledge may need to be reflected in Codex-facing files.

## Scope

Source side:
- `CLAUDE.md`
- `frontend/CLAUDE.md`
- `backend/CLAUDE.md`
- `~/.claude/CLAUDE.md` when the user explicitly mentions global Claude
  instruction drift or global Claude changes
- `.claude/skills/`
- `.claude/agents/`
- `.gitignore`

Codex adapter side:
- `AGENTS.md`
- `.agents/skills/`
- `.codex/config.toml`
- `.codex/agents/`
- `.gitignore`

## Workflow

1. Establish a worktree before making adapter changes — pick the mode by how
   the sync was triggered:
   - **In-current-worktree (default for a per-slice gate).** If you are already
     in a non-main slice/feature worktree — e.g. invoked as the mandatory
     `codex-adapter-sync` gate at the end of a skill-touching slice — sync the
     adapter **here**, in that same worktree. Commit the adapter changes
     alongside the slice and ship them in the slice's own PR. Do **not** spin up
     a separate adapter branch or PR: a per-slice gate that demanded its own
     worktree/PR would collide with the slice it is gating.
   - **Dedicated adapter worktree.** Only when invoked standalone from the main
     checkout (no active slice worktree): create or reuse a dedicated adapter
     worktree before inventory or edits — your project's worktree helper (or
     `git worktree add`) on an issue-anchored branch when an anchor exists, or a
     `chore/codex-adapter-sync-<slug>` worktree for a deliberate no-issue chore
     — and ship it through its own PR.
   - Either way: never land adapter changes directly on `main`. Move any
     accidental main-checkout adapter diff into the chosen worktree first, then
     leave the main checkout clean.
2. Inventory the source side and adapter side from inside that worktree. If
   global Claude instructions are in scope, read them from the main thread but
   keep personal overrides, secrets, and machine-local state out of the repo
   diff.
3. Compare project knowledge:
   - New or changed durable conventions in `CLAUDE.md` should be reflected in
     `AGENTS.md` only as concise adapter guidance or references.
   - Do not duplicate long `CLAUDE.md` sections into `AGENTS.md`.
   - Keep `CLAUDE.md` as the source of truth.
   - Durable global safety/workflow rules from `~/.claude/CLAUDE.md` should be
     mirrored only when Codex would otherwise miss them. Prefer a short
     Codex-facing adapter rule in `AGENTS.md` or a minimal safe Codex config
     change; do not copy personal style, identities, credentials, or long
     global sections.
4. Compare skills:
   - Important repo/domain/workflow skills from `.claude/skills/` belong in
     `.agents/skills/`.
   - Keep each `SKILL.md` and its support files together.
   - Do not copy skills into `.codex/skills/`.
   - Leave clearly Claude-only setup, hook, or personal/meta skills out unless
     the user explicitly wants them ported.
   - Translate Claude-specific model delegation instead of copying it
     literally (tier mapping per your routing doctrine; if the repo carries a
     Codex mirror table in `AGENTS.md`, keep it in sync). In particular, Claude `Agent` dispatches with
     `model: sonnet` should become Codex `spawn_agent` dispatches with the
     appropriate `agent_type`; for mechanical coding/git work use a `worker`
     subagent with `model: gpt-5.4-mini` and `reasoning_effort: low` unless the
     source skill gives a stronger task-specific reason. Claude `opus` /
     judgment-tier dispatches (subtle logic, review/verify verdicts) map to
     `model: gpt-5.5` with `reasoning_effort: high` (verdicts never below
     high). Translate Claude `effort:` params to the nearest
     `reasoning_effort` value (`minimal|low|medium|high|xhigh`; Claude `max`
     → `xhigh`). Keep user gates, security judgment, and approval decisions
     in the main thread.
   - Keep dual-surface generic/vendored skill bodies content-synced. When a
     Codex mirror must intentionally differ from the Claude source, bracket the
     source region and the Codex replacement with a matching transform marker
     pair:
     `<!-- mirror-xform:start <short-reason> -->` and
     `<!-- mirror-xform:end -->`. The `<short-reason>` must match, in order,
     on both sides. Stale source content is not a transform: copy it into the
     Codex mirror instead. A mirror-parity lint (if your project ships one)
     strips paired regions and fails on unmarked or unpaired drift.
   - **Escalation-target rewrite (standard adaptation).** A Claude-only,
     vendored escalation skill (`surfaces: [claude]` in the manifest — e.g.
     `grill-with-docs-codex`, `grill-me-codex`, Chase AI's cross-model Act-2
     variants) has no `.agents` mirror. Any Codex-side reference to that skill
     name is a dangling target and must be rewritten to its plain, dual-surface
     counterpart (`grill-with-docs`, `grill-me`) instead. Reword the sentence
     around the swapped name so it stays coherent on the Codex surface — in
     particular, drop any claim that a *different* model reviews the plan
     afterwards (Act 2): that mechanic is Claude-orchestrator-specific
     (dispatches `codex exec` as a subprocess) and does not apply once the
     agent running the skill already is Codex. For a dual-surface
     generic/vendored skill, do this inside a paired `mirror-xform` region (see
     above) so the Claude source keeps citing the real `-codex` skill
     unchanged while the Codex mirror gets the plain, reworded sentence; for a
     Codex-only project-private skill, rewrite the reference directly, no
     marker needed. A reference to the skill's real upstream repo name or a
     real doc file path that merely happens to contain the string (e.g.
     `chaseai-yt/grill-me-codex`, `docs/agents/skills/grill-with-docs-codex.md`)
     is not an escalation target and must NOT be rewritten — rewriting it would
     break attribution/a real link.
5. Validate Codex skill frontmatter:
   - `name` and `description` are required.
   - Quote `description` when it contains colons, arrows, commas, or other
     YAML-sensitive punctuation.
   - Keep `description` under 1024 characters.
   - Keep trigger detail in the body if the original Claude description is too
     long.
6. Compare agents:
   - Claude agents are `.md` files under `.claude/agents/`.
   - Codex agents are `.toml` files under `.codex/agents/`.
   - Convert agent instruction bodies into `developer_instructions`.
   - If no Claude agents exist, keep only a short README or no-op note.
7. Compare config and ignore rules:
   - Keep `.codex/config.toml` minimal and safe.
   - Never add secrets, provider credentials, auth tokens, or local personal
     overrides.
   - Ensure `.gitignore` excludes local Codex state and override files while
     allowing checked-in project config, agents, and skills.
8. Before edits, show the exact files that will be created or changed.
9. After edits, validate:
   - `.codex/config.toml` parses as TOML.
   - All `.agents/skills/*/SKILL.md` files load without Codex warnings.
   - No skill description exceeds 1024 characters.
   - `.codex/config.toml`, `.codex/agents/*.toml`, and `.agents/skills/**`
     are not accidentally ignored.
10. Prepare the branch for review:
   - Commit the adapter changes on the worktree branch after checking for
     secrets and ignored files.
   - Push the branch and create or update a PR.
   - Report the PR URL, changed files, skipped items, and verification results.

## Output

Report:
- What changed.
- What was intentionally skipped.
- Any source files that still need human judgment.
- Verification commands and results.
