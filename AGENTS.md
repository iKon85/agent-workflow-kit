# AGENTS.md

`CLAUDE.md` is the shared repository workflow source — read it in full; its
rules apply equally to Codex unless a rule names a surface-specific hook,
command, or Claude-only skill (the `-codex` cross-model skills,
`write-a-skill`, `git-guardrails-claude-code`, `setup-pre-commit` have no
`.agents/skills` mirror and are invoked from Claude Code only).

Codex-surface specifics:

- Skills live in `.agents/skills/`; they are a generated mirror of
  `.claude/skills/` (via `codex-adapter-sync`). Author changes on the Claude
  side first and sync the mirror in the same PR — never edit only the mirror.
- The "load the playbook skill first" rule applies to the `.agents/skills`
  copies.
- Delegation/model-routing doctrine referenced from `~/.claude/CLAUDE.md`
  §Task-Routing has a Codex mirror in the user-global `AGENTS.md` where
  present; otherwise stay conservative: serialize, terse reports.
