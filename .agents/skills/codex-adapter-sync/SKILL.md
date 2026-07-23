---
name: codex-adapter-sync
description: "Use to audit and update the Codex adapter after changes to CLAUDE.md, package CLAUDE.md files, .claude/skills, .claude/agents, or Codex setup. Checks AGENTS.md, .agents/skills, .codex/config.toml, .codex/agents, and .gitignore for drift."
---

# Codex Adapter Sync

Use this skill when the user asks for a Codex adapter sync, Codex drift check,
Claude-to-Codex migration check, or when changes to Claude-facing project
knowledge may need to be reflected in Codex-facing files.

## Audit mode (default)

Audit is a read-only diagnosis from the current checkout. Inventory and compare
the source and adapter surfaces, then report the exact proposed changes. Do not
create or switch branches or worktrees, edit files, or change external state.

## Apply mode

Apply only when the user asked to update or fix the adapter. Create or reuse the
correct issue or slice worktree before the first edit. Never apply adapter
changes on `main`; move any accidental main-checkout diff into the worktree and
leave the main checkout clean.

## Routing intent

Durable issues and handoffs describe task shape with provider-neutral
`routing-intent` and `reasoning-intent` values. Never persist a provider model
identifier or copy a resolved route back into shared work. The supported
built-in agent names remain `default`, `worker`, and `explorer`.

At dispatch time, resolve the intent by comparing the Kit-owned Evidence
catalog with the user-local Access graph and Routing policy. Keep those
contracts separate: catalog facts include inaccessible models, the Access graph
attests available paths and enforcement, and personal policy filters facts
without changing them. Report the best overall route separately from the best
currently executable route. Unknown transports and stale capability evidence
block; missing routing infrastructure may fall back only through explicit
`inherit`.

Apply any selected provider route only through the active surface's verified
adapter. An AFK dispatch must prove its requested and applied route plus model
and effort enforcement in a one-execution Dispatch receipt. Credentials,
personal access state, and personal policy stay outside repositories and
package-owned files. Keep user gates, security judgment, and approval decisions
in the main thread.

## Scope

Source side:
- every repository instruction file matched by `**/CLAUDE.md`
- `~/.claude/CLAUDE.md` when the user explicitly mentions global Claude
  instruction drift or global Claude changes
- `.claude/skills/`
- `.claude/agents/`
- Claude hook declarations and implementations
- `.gitignore`

Codex adapter side:
- every repository instruction file matched by `**/AGENTS.md` or
  `**/AGENTS.override.md`
- `.agents/skills/`
- every trusted project config layer matched by `**/.codex/config.toml`
- `.codex/agents/`
- Codex hook declarations
- `.gitignore`

## Inventory

Derive a fresh, counted inventory from the repository root; do not assume only
known package names or root-level files. Include:

- arbitrary nested `**/CLAUDE.md`, `**/AGENTS.md`, and
  `**/AGENTS.override.md` instruction layers;
- every `**/.codex/config.toml`, noting that Codex loads project config and
  hooks only from trusted project layers;
- `.claude/skills/**`, `.agents/skills/**`, `.claude/agents/**`, and
  `.codex/agents/**`;
- Claude hook definitions in `.claude/settings*.json` and implementations in
  `.claude/hooks/**` as adaptation candidates;
- Codex targets in `.codex/hooks.json` and inline `[hooks]` tables in each
  active config layer; and
- ignore rules and every skill reference, asset, script, template, and other
  distributed support file, regardless of extension.

For every relevant Claude hook behavior, record one explicit classification:
**Codex-adapted** with its target, or **intentionally Claude-only** with the
reason. Never port hooks blindly.

## Custom-agent validation

Codex custom-agent files are standalone TOML config layers. Parse every
`.codex/agents/*.toml` file and require non-empty string values for the required
`name`, `description`, and `developer_instructions` fields. Validate supported
optional `model` and `model_reasoning_effort` fields as strings when present,
then let strict Codex config validation reject unsupported keys or values.
Reject a file that is malformed, misses a required field, or uses the legacy
schema. A README or no-op note is not a custom-agent TOML file.

## Validation

Run validation from the repository root and keep the evidence in the report:

1. Run `codex --strict-config --version` from the root and from a representative
   nested directory for every discovered project config layer. Any unknown
   active key is a failure, not a warning to ignore.
2. Validate skill metadata and loading with the repository's strict
   skill-frontmatter guard when one is available, then start a fresh Codex
   session and check that every enabled skill is discoverable without load
   warnings.
3. Parse and validate every custom-agent TOML file against the
   Custom-agent validation section above; strict config validation must also
   accept its supported optional fields.
4. Use `git check-ignore --no-index` on `.codex/config.toml`, every
   `.codex/agents/*.toml`, `.agents/skills/**`, `.codex/hooks.json`, and any
   adapted hook implementation. A checked-in adapter target being ignored is a
   failure; local state and override files should remain ignored.
5. Resolve every path named by skill prose and verify that all references,
   assets, scripts, templates, and other distributed support files exist. Run
   the repository's all-file mirror-parity guard when available so non-Markdown
   presence parity and Markdown body/`mirror-xform` parity are both checked.
6. Recompute the dual-surface skill denominator from the manifest, compare all
   distributed files in both trees, and report the fresh result as **X of Y**
   mirrored skills. Do not reuse a remembered count.
7. Enforce this repository's 1024-character description cap as a named
   repository safeguard. It is not a Codex product limit; the local guard owns
   the policy and must fail when a description exceeds it.

## Workflow

1. Select the mode from the user's request. Audit in the current checkout. For
   Apply, reuse the active non-main slice worktree when the sync gates that
   slice; otherwise create or reuse a dedicated issue-anchored adapter worktree.
2. Build the Inventory before proposing or making changes. If global Claude
   instructions are in scope, inspect them without exposing personal overrides,
   secrets, credentials, or machine-local state.
3. Compare project knowledge and instruction precedence:
   - New or changed durable conventions in `CLAUDE.md` should be reflected in
     `AGENTS.md` only as concise adapter guidance or references.
   - Do not duplicate long `CLAUDE.md` sections into `AGENTS.md`.
   - Keep `CLAUDE.md` as the source of truth.
   - Durable global safety/workflow rules from `~/.claude/CLAUDE.md` should be
     mirrored only when Codex would otherwise miss them. Prefer a short
     Codex-facing adapter rule in `AGENTS.md` or a minimal safe Codex config
     change; do not copy personal style, identities, credentials, or long
     global sections.
4. Compare every skill and distributed support file:
   - Important repo/domain/workflow skills from `.claude/skills/` belong in
     `.agents/skills/`.
   - Keep each `SKILL.md` and its support files together.
   - Do not copy skills into `.codex/skills/`.
   - Leave clearly Claude-only setup, hook, or personal/meta skills out unless
     the user explicitly wants them ported.
   - Translate Claude-specific delegation rather than copying it literally.
     Apply the Routing intent section above only when an explicit user-local
     route is justified; otherwise preserve explicit inheritance.
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
5. Compare agents, hooks, config, and ignore rules:
   - Claude agents are `.md`; Codex custom agents are `.toml` and must satisfy
     Custom-agent validation.
   - Classify each Claude hook behavior using the Inventory contract and check
     Codex hook targets at every active trusted config layer.
   - Keep `.codex/config.toml` minimal and safe. Never add secrets, provider
     credentials, auth tokens, or local personal overrides.
   - Ensure ignore rules exclude local Codex state and override files while
     allowing checked-in config, agents, hooks, skills, and support files.
6. In Audit mode, run every read-only Validation step that the checkout
   supports and report the proposed file changes without mutating anything.
7. In Apply mode, show the exact files to create or change before editing, make
   only those changes, then run the complete Validation section. Prepare the
   existing worktree branch for review: check for secrets and ignored files,
   commit the adapter changes, push, and create or update its PR.

Codex skill frontmatter must also satisfy these repository rules:

- `name` and `description` are required.
- Quote `description` when it contains colons, arrows, commas, or other
  YAML-sensitive punctuation.
- Enforce the Validation section's named description safeguard.
- Keep trigger detail in the body if the original Claude description is too
  long.

## Output

Report:
- What changed.
- What was intentionally skipped.
- Any source files that still need human judgment.
- Verification commands and results.
