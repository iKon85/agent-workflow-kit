# Workflow Advisories setup contract

Workflow Advisories is one opt-in capability backed by the consumer-owned
`docs/agents/workflow-capabilities.json` profile. Enabling it activates
non-blocking large-read, baseline, pre-refactor, and affected-surface Stop
adapters. Every threshold, glob, branch rule, command, timeout, and output
budget stays consumer-owned.

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
    "stopChecks": {"surfaces": [], "timeoutSeconds": 30, "outputBudget": 1000}
  }
}
```

Empty command surfaces are honest inactive defaults. Setup recommends concrete
project commands from the tools already present, then asks before activating.

## Hook ownership

- PreToolUse on Read:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/recon-size-hint.py"`
- PreToolUse on Edit/Write/MultiEdit:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/baseline-capture-hint.py"`
- UserPromptSubmit:
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/pre-refactor-sweep.py"`
- Stop:
  `"$CLAUDE_PROJECT_DIR/.claude/hooks/typecheck-on-stop.sh"`

All adapters are non-blocking. A failed or timed-out configured command remains
visibly failed in hook context; it is never reported as green.
