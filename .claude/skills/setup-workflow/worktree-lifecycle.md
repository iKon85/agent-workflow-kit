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
      "adopt-existing"
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
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-worktree.py"` and
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-worktree-cwd.py"`
- PreToolUse on Bash:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-worktree-discipline.py"`

`enforce-worktree-cwd.py` moved onto the Edit/Write/MultiEdit matcher with the
authorization re-cut: it judges the **write target** a structured payload names,
not the shell's working directory. A profile that still wires it under a `Bash`
matcher is not broken — the adapter simply has no opinion on a `Bash` payload —
but reconciliation moves it, so the guard reaches the writes it protects.

Preserve unrelated settings, hook groups, profile sections, and unknown keys.
Repeated reconciliation with the same choice is byte-identical.

## Planning-artifact ignore rules (offered, never installed)

The planning artefacts the shipped skills write live in the worktree, and the
worktree itself lives under the profile's declared root — but `.gitignore` is a
consumer file the kit does not own: `init` and `update` never touch it. Setup
may therefore only **offer** the rules, from Section A11, using
`python3 scripts/worktree-lifecycle/ignore_seed.py`.

The offer reads two declarations and never a literal typed into the helper: the
kit-owned artefact list in `scripts/worktree-lifecycle/plan-artifacts.json`, and
the consumer profile's own `worktreeRoot` (kit default `.worktrees`). The second
rule matters on its own — without it a stray `git add -A` stages every linked
worktree as an embedded git repository, and the resulting commit carries
gitlinks no clone can resolve.

| State | Setup action |
|---|---|
| `append` | Show the exact marker block, then ask. |
| approve | Run `ignore_seed.py apply` once: it appends that one block, append-only. |
| decline | Write nothing; a later rerun offers it again. |
| already ignored | Report `nothing to do`; ask nothing and write nothing. |
| re-run after approval | Byte-identical no-op; never a second block. |
| block that misses a rule | `blocked` — report the uncovered rules and leave the file untouched, whether the consumer edited the block or an older kit wrote a smaller one. |

The seeder never rewrites, reorders, or removes an existing line, and a tracked
artefact is reported rather than untracked for the consumer. Only this explicit,
approved step may write `.gitignore`.

## Scratch classification and sweep

Reconcile **no** pattern list. Deletion policy has exactly one configuration
surface, the ignore mechanism: a file is Scratch — deletable at teardown —
precisely when the repository's own exclude sources classify it as ignored.
Making a file deletable therefore means ignoring it, which is what the offered
planning-artifact rules above do. Setup never derives, writes, or reviews a
deletion pattern, and a profile that still carries one from an older kit keeps
it as consumer data: the loader ignores unknown keys in silence, so there is
nothing to migrate and nothing to warn about.

## Branch templates

`branchTemplate` names the branch of an issue-anchored slice and renders
`{type}`, `{issue}`, and `{slug}`. `contentBranchTemplate` names the issue-less
branch a session cuts when its output is durable content — a planning session
has no issue number — and renders `{type}` and `{slug}` only; an `{issue}`
placeholder in it is refused rather than filled with a guess.

Reconcile `contentBranchTemplate` with the default `{type}/{slug}` when
enabling a new profile, and offer the consumer their own naming instead.
An existing value is consumer-owned and remains byte-identical on adoption or
rerun.

## Seed declaration

`setupEntry` routes a session to the optional creation helper
(`scripts/worktree-lifecycle/setup.py`), which cuts the branch, adds the
worktree, and seeds it from `seed`. Offering it is never a mandate: a worktree
someone created with plain `git worktree add`, under any name and path, stays
first-class in every other lifecycle step, and the helper adopts an existing one
rather than re-seeding over its values.

`seed` is **flat — two keys and no third**, and Setup reconciles it as a
declaration, never as a procedure:

```json
"seed": {
  "paths": [".env", "config/local.json"],
  "variables": { "VITE_DEV_PORT": 5173, "BACKEND_PORT": 3001 }
}
```

- `paths`: repository-relative files copied verbatim to the same relative path
  in a newly created worktree. Ask the consumer which local files a fresh
  checkout needs; never derive them by scanning, and never propose a path that
  escapes the repository.
- `variables`: named positive integer bases. The helper offsets each by the
  worktree's own slot and writes them to `.dev-ports`, which is also what
  teardown quiesces.

Activating a new profile writes the scaffold empty —
`"seed": { "paths": [], "variables": {} }` — so the consumer can see where their
own values go; never fill it in by inference or by scanning the repository.

Reconcile **no** step kinds, ordering knobs, per-entry flags, or commands —
`seed` has none, and a profile still carrying an older kit's `setupSteps` keeps
it as inert consumer data. Never read, parse, patch, or echo a declared file's
contents: the kit moves bytes, and a declared file may hold secrets. An existing
`seed` is consumer-owned and stays byte-identical on adoption or rerun.

## Profile glob dialect

Every consumer-profile glob in this kit — the Workflow Advisories keys
`baseline.sourceGlobs`, the `preRefactor`/`stopChecks` surface globs — is
matched by the one shared dialect in `scripts/profile_globs.py`. There is no
second matcher and no per-capability variant:

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

The check names every pattern whose match set narrows or widens against the
legacy matcher and prints the concrete witness path that proves the difference.
Exit code 1 means at least one pattern needs review. Report the named patterns
and let the consumer rewrite them; never migrate a pattern automatically. The
check reads the profile and never edits it. No Worktree Lifecycle decision
reads a glob, so a pattern here can widen only what an advisory selects, never
what teardown removes.

The shipped read-only inventory is
`python3 scripts/worktree-lifecycle/cleanup.py sweep`. The profile powers its
branch issue extraction; the scratch each row reports comes from the same
stateless classification teardown itself uses, never from a profile pattern.
