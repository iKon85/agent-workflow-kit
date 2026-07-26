# Worktree Lifecycle setup contract

Worktree Lifecycle is one opt-in capability backed by the consumer-owned
`docs/agents/workflow-capabilities.json` profile. Enabling it activates the
portable setup entry, shared branch/worktree facts, thin hook adapters, handoff
advisory, and safe cleanup policy as one unit.

## Choice matrix

| State | Setup action |
|---|---|
| `missing` | Ask `yes / later / no`; do not infer or write before the answer. |
| `yes` | Reconcile the enabled profile and exact kit-owned hook commands. |
| `later` | Record the retryable deferral; do not activate hooks. |
| `no` | Record the opt-out; do not activate hooks. |
| `existing` | Adopt the consumer profile byte-safely and preserve unknown keys. |
| `disable` | Remove only kit-owned hook wiring, then set `enabled: false`; retain the profile and unknown keys. |

```json worktree-lifecycle-setup-effects
[
  {
    "state": "missing",
    "choice": null,
    "operations": []
  },
  {
    "state": "yes",
    "choice": "yes",
    "operations": [
      "record-choice",
      "reconcile-profile-enabled",
      "reconcile-landing-artifact-policy",
      "reconcile-hook-wiring"
    ]
  },
  {
    "state": "later",
    "choice": "later",
    "operations": [
      "record-choice"
    ]
  },
  {
    "state": "no",
    "choice": "no",
    "operations": [
      "record-choice"
    ]
  },
  {
    "state": "existing",
    "choice": "yes",
    "operations": [
      "adopt-existing",
      "reconcile-landing-artifact-policy"
    ]
  },
  {
    "state": "disable",
    "choice": "yes",
    "operations": [
      "remove-hook-wiring",
      "update-profile-disabled"
    ]
  }
]
```

## Hook ownership

The exact kit-owned commands are:

- SessionStart: `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/branch-context.py"`
- UserPromptSubmit: `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/slice-handoff-hint.py"`
- PostToolUse on Bash: `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/branch-watch.py"`
- PreToolUse on Edit/Write/MultiEdit:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-worktree.py"`
- PreToolUse on Bash:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-worktree-cwd.py"` and
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-worktree-discipline.py"`

Preserve unrelated settings, hook groups, profile sections, and unknown keys.
Repeated reconciliation with the same choice is byte-identical.

## Planning-artifact ignore rules (offered, never installed)

The planning artefacts the shipped skills write live in the worktree, but
`.gitignore` is a consumer file the kit does not own: `init` and `update` never
touch it. Setup may therefore only **offer** the rules, from Section A11, using
`python3 scripts/worktree-lifecycle/ignore_seed.py`. The kit-owned declaration
of which artefacts those are is `scripts/worktree-lifecycle/plan-artifacts.json`.

| State | Setup action |
|---|---|
| `append` | Show the exact marker block, then ask. |
| approve | Run `ignore_seed.py apply` once: it appends that one block, append-only. |
| decline | Write nothing; a later rerun offers it again. |
| already ignored | Report `nothing to do`; ask nothing and write nothing. |
| re-run after approval | Byte-identical no-op; never a second block. |
| consumer-edited block | `blocked` — report the uncovered artefacts and leave the file untouched. |

The seeder never rewrites, reorders, or removes an existing line, and a tracked
artefact is reported rather than untracked for the consumer. Only this explicit,
approved step may write `.gitignore`.

## Scratch classification and sweep

Reconcile an explicit `scratchPatterns` array when enabling a new profile.
Derive its glob values from the consumer's ignored planning artefacts; an empty
array is valid. Existing values are consumer-owned and remain byte-identical on
adoption or rerun. Core never supplies filename defaults — the offered ignore
rules above are what give that derivation something real to read.

Also reconcile an explicit
`wrapup.landingGeneratedArtifactPatterns` array. Derive candidates from the
consumer's real landing commands and ignored outputs, show the exact list for
review, and write it only as part of that explicit setup decision. Never copy
another repository's values or infer deletion authority from `.gitignore`
alone. An empty array is valid. Existing configured values remain byte-identical.
If an existing enabled profile lacks the key, report one actionable setup
decision and leave the project layer unchanged until the consumer confirms the
derived list.

## Profile glob dialect

Every consumer-profile glob in this kit — Worktree Lifecycle and Workflow
Advisories alike — is matched by the one shared dialect in
`scripts/profile_globs.py`. There is no second matcher and no per-capability
variant:

- `*` matches any run of characters inside one path segment, never `/`.
- `?` matches exactly one character inside one path segment.
- `[seq]` and `[!seq]` are per-segment character classes; `/` is always a
  separator and never a class member.
- `**` as a complete segment matches zero or more segments, so a leading `**/`
  also matches the repository root and `dir/**` also matches `dir` itself.
- Matching is always case-sensitive, on every host filesystem.
- A pattern must match the whole repository-relative path.

Thus `**/__pycache__/**` covers root and nested caches, while `dist-kit/*` does
not cover `dist-kit/a/b`.

When adopting an existing profile, or after any kit update, review it before
trusting its patterns:

```bash
python3 scripts/profile_globs.py docs/agents/workflow-capabilities.json
```

The check names every pattern whose match set narrows or widens against that
key's legacy matcher, prints the concrete witness path that proves the
difference, and marks the keys that carry deletion authority. Exit code 1 means
at least one pattern needs review. Report the named patterns and let the
consumer rewrite them; never migrate a pattern automatically and never treat a
widened deletion-authority pattern as an accepted default. The check reads the
profile and never edits it.

The shipped read-only inventory is
`python3 scripts/worktree-lifecycle/cleanup.py sweep`. The same profile powers
its branch issue extraction and scratch-only cleanup verdicts.
