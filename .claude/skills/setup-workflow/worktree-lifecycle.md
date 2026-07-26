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
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-worktree.py"`
- PreToolUse on Bash:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-worktree-cwd.py"` and
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/enforce-worktree-discipline.py"`

Preserve unrelated settings, hook groups, profile sections, and unknown keys.
Repeated reconciliation with the same choice is byte-identical.

## Scratch classification and sweep

Reconcile an explicit `scratchPatterns` array when enabling a new profile.
Derive its glob values from the consumer's ignored planning artefacts; an empty
array is valid. Existing values are consumer-owned and remain byte-identical on
adoption or rerun. Core never supplies filename defaults.

The shipped read-only inventory is
`python3 scripts/worktree-lifecycle/cleanup.py sweep`. The same profile powers
its branch issue extraction and scratch-only cleanup verdicts.
