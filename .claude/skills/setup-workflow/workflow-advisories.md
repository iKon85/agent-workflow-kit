# Workflow Advisories setup contract

Workflow Advisories is one opt-in capability backed by the consumer-owned
`docs/agents/workflow-capabilities.json` profile. Enabling it activates seven
non-blocking rows: large-read, baseline, pre-refactor, affected-surface Stop,
convention freshness, migration-artifact reminder, and LoC forewarning. Every
threshold, glob, branch rule, source map, command, timeout, and output budget
stays consumer-owned.

## Choice matrix

| State | Setup action |
|---|---|
| `missing` | Ask `yes / later / no`; do not infer or write before the answer. |
| `yes` | Reconcile the enabled profile and exact kit-owned hook commands. |
| `later` | Record the retryable deferral; do not activate hooks. |
| `no` | Record the opt-out; do not activate hooks. |
| `existing` | Adopt the consumer profile byte-safely and preserve unknown keys. |
| `disable` | Remove only kit-owned hook wiring, then set `enabled: false`; retain profile values and unknown keys. |

```json workflow-advisories-setup-effects
[
  {"state":"missing","choice":null,"operations":[]},
  {"state":"yes","choice":"yes","operations":["record-choice","reconcile-profile-enabled","reconcile-hook-wiring"]},
  {"state":"later","choice":"later","operations":["record-choice"]},
  {"state":"no","choice":"no","operations":["record-choice"]},
  {"state":"existing","choice":"yes","operations":["adopt-existing"]},
  {"state":"disable","choice":"yes","operations":["remove-hook-wiring","update-profile-disabled"]}
]
```

## Profile shape

Reconcile only `workflowAdvisories`; preserve every sibling section and unknown
key. Consumer values are never normalized on adoption.

```json
{
  "workflowAdvisories": {
    "choice": "yes",
    "enabled": true,
    "largeRead": {"tools": ["Read"], "lineThreshold": 500, "outputBudget": 500},
    "baseline": {
      "sourceGlobs": ["src/**"],
      "branchRegex": "^(?:feat|fix)/",
      "manifestPath": ".agent/baseline.json",
      "stateDir": ".claude/logs/advisory-state",
      "outputBudget": 500
    },
    "preRefactor": {
      "promptMatchers": ["refactor"],
      "surfaces": [],
      "timeoutSeconds": 15,
      "outputBudget": 1000
    },
    "stopChecks": {"surfaces": [], "timeoutSeconds": 30, "outputBudget": 1000},
    "freshness": {"documents": [], "outputBudget": 1000},
    "migration": {
      "commandMatchers": [],
      "artifact": "",
      "refreshCommand": [],
      "outputBudget": 500
    },
    "locForewarn": {
      "branchRegex": "^(?:feat|fix)/(\\d+)-",
      "issueCommand": ["gh", "issue", "view", "{issue}", "--json", "body", "-q", ".body"],
      "timeoutSeconds": 5,
      "outputBudget": 500
    }
  }
}
```

Empty command surfaces are honest inactive defaults. Setup recommends concrete
project commands from the tools already present, then asks before activating.

## Profile glob dialect

`baseline.sourceGlobs`, `preRefactor.surfaces[].globs`, and
`stopChecks.surfaces[].globs` are matched by the one shared dialect in
`scripts/profile_globs.py`. They are the only consumer-profile globs the kit
reads: Worktree Lifecycle carries no pattern list, because the ignore mechanism
is the single deletion-policy surface (ADR 0009). There is no second matcher
and no per-capability variant:

- `*` matches any run of characters inside one path segment, never `/`.
- `?` matches exactly one character inside one path segment.
- `[seq]` and `[!seq]` are per-segment character classes; `/` is always a
  separator and never a class member.
- `**` as a complete segment matches zero or more segments, so a leading `**/`
  also matches the repository root and `dir/**` also matches `dir` itself.
- Matching is always case-sensitive, on every host filesystem.
- A pattern must match the whole repository-relative path.

Thus `src/**` covers `src/a/b.ts`, `**/*.ts` covers both `index.ts` and
`src/index.ts`, and `*.ts` covers only a root-level file.

A profile written for the older whole-string matcher can therefore change
meaning. When adopting an existing profile, or after any kit update, review it:

```bash
python3 scripts/profile_globs.py docs/agents/workflow-capabilities.json
```

The check names every pattern whose match set narrows or widens, prints the
concrete witness path that proves the difference, and separately flags patterns
that only matched case-insensitively on the previous matcher. Exit code 1 means
at least one pattern needs review. Report the named patterns and let the
consumer rewrite them; never migrate a pattern automatically. The check reads
the profile and never edits it.

## Hook ownership

- PreToolUse on Read:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/recon-size-hint.py"`
- PreToolUse on Edit/Write/MultiEdit:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/baseline-capture-hint.py"`
- UserPromptSubmit:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/pre-refactor-sweep.py"`
- Stop:
  `"$CLAUDE_PROJECT_DIR/.claude/hooks/typecheck-on-stop.sh"`
- SessionStart convention freshness:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/convention-drift-hint.py"`
- PostToolUse on Bash migration commands:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/migration-snapshot-reminder.py"`
- SessionStart LoC forewarning:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/loc-offender-forewarn.py"`

All adapters are non-blocking. A failed or timed-out configured command remains
visibly failed in hook context; it is never reported as green. Issue lookup
failures silence only the LoC forewarning: the existing pre-push gate remains
the enforcing authority and stays fail-closed.
