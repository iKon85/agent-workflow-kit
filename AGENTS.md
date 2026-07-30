# AGENTS.md

`CLAUDE.md` is the shared repository workflow source — read it in full,
§Behavioral core included: the four adopted principles, the two-class
verify-first rule and add-only-on-observed-failure bind Codex identically. Its
rules apply equally unless a rule names a surface-specific hook,
command, or Claude-only skill (the `-codex` cross-model skills,
`write-a-skill`, `git-guardrails-claude-code`, `setup-pre-commit` have no
`.agents/skills` mirror and are invoked from Claude Code only).

Codex-surface specifics:

- Keep `CLAUDE.md` as the source of truth. Mirror only the concise Codex
  guidance needed to apply it; do not duplicate its long workflow sections
  here.
- Skills live in `.agents/skills/`; they are a generated mirror of
  `.claude/skills/` (via `codex-adapter-sync`). Author changes on the Claude
  side first and sync the mirror in the same PR — never edit only the mirror.
- The "load the playbook skill first" rule applies to the `.agents/skills`
  copies.
- A standalone adapter sync from `main` runs in a dedicated worktree and PR;
  a sync triggered by an active slice stays in that slice's worktree and PR.
- Model and effort are configuration, not doctrine: where a Routing profile
  exists it decides them, whether or not the hand-maintained model × effort
  table is still present in `~/.claude/CLAUDE.md` §Task-Routing. That section
  keeps only the judgment that is not data; retiring the table is the
  previewed, backed-up, explicitly accepted
  `node scripts/doctrine-migration/index.mjs`. Where no Routing profile can
  decide, stay conservative: serialize, terse reports.
- Keep user gates, security judgment, and approval decisions in the main
  thread. A subagent's report is class-1 evidence, never the read itself.
- Never expose `.env*`, credentials, tokens, or local override contents in
  command output. Do not commit local Codex state or personal configuration.
- Project-scoped Codex defaults live in `.codex/config.toml`; project agents
  live in `.codex/agents/`. Claude-only hooks and skills are not copied unless
  an explicit Codex adaptation exists.

## Prod

Published as the `@ikon85/agent-workflow-kit` npm package and matching GitHub
release through GitHub Actions. Live distribution:
https://www.npmjs.com/package/@ikon85/agent-workflow-kit and
https://github.com/iKon85/agent-workflow-kit/releases.

**Deploy trigger:** pushing a matching annotated `v<version>` tag on the
canonical `main` commit. Merging a prepared version integrates it only and
leaves it `awaiting-tag`; it cannot publish. The tag-triggered workflow validates
tag identity, package version, main ancestry, artifact integrity, and tests,
then publishes to npm (`--access public --provenance`) and creates or reconciles
the matching GitHub release. Manual dispatch requires an explicit existing tag
and is recovery only. A red run does not prove nothing was published (#205) —
check `npm view` and `gh release view` before reacting. `release:guard` blocks a
bump stacked on a still-untagged previous release (#243): tag the pending
version, never bury it.

**One human gate: the Semver.** The confirmed Semver authorizes the whole
release — metadata, merge, tag and publish. After merge the agent verifies the
version on canonical `main`, tags, and monitors to `released` without asking
again; a narrower build-only request never becomes this authority. Tagging
stays irreversible, and the protection is the gates that run regardless of who
is watching, not a prompt (#257). Full flow: `CLAUDE.md` §Consumer contract →
Release.
