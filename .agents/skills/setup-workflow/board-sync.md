# Board sync — GitHub Projects field-IDs

How the board-managed workflow skills (`to-prd`, `to-issues`, `board-to-waves`, …) address this project's GitHub-Projects board. A board stores its fields under opaque GraphQL IDs that differ per board, so they are recorded here rather than hardcoded in any skill.

`/setup-workflow` writes this file in one of three states (see the sentinel on the first line):
- **`state=filled`** — the IDs below were discovered from your board.
- **`state=stub`** — no single board was found; fill the IDs by creating the board (below) and re-running `/setup-workflow`.
- **`state=not-applicable`** (`mode=none`) — this project does not use a GitHub-Projects board.

## Board profile — fields the workflow skills use

| Field | Type | Required | Used for |
|---|---|---|---|
| Status | single-select | yes | workflow stage (the skills move items through your stage options) |
| Wave | number | optional | grouping anchors into waves/campaigns |
| Cluster | text | optional | thematic cluster tag |
| Spec-Path | text | optional | link from an issue to its spec doc |
| Plan-Path | text | optional | link from an issue to its plan doc |

## Machine profile (SSOT) — `scripts/board_config.py` reads this

`/setup-workflow` fills the board-identity values (node id, field IDs, status options) from `gh project field-list`. The convention values (labels, branch prefixes, PR markers, headings) ship pre-filled to match the bundled skills — edit them only if you adapt those conventions. The IDs live **only** in this block (the table above is documentation), so the two cannot drift.

<!-- board-sync:profile -->
```json
{
  "repo": "<owner>/<repo>",
  "project": {
    "number": 0,
    "owner": "<owner>",
    "nodeId": "<fill via /setup-workflow>"
  },
  "fields": {
    "status": {
      "id": "<fill>",
      "options": { "<stage>": "<option-id>" }
    },
    "wave": "<fill / omit>",
    "cluster": "<fill / omit>",
    "specPath": "<fill / omit>",
    "planPath": "<fill / omit>"
  },
  "labels": {
    "readyForAgent": "ready-for-agent",
    "typePrefix": "type:",
    "clusterType": "type:cluster",
    "waveStub": "wave-stub"
  },
  "branchPrefixes": ["feat", "fix", "chore", "docs"],
  "prMarkers": {
    "partOf": "Part of",
    "retroMarker": "**Retro:**",
    "retroValues": ["gefahren", "übersprungen"]
  },
  "headings": {
    "vorBau": "Vor Bau zu klären"
  }
}
```

## If the IDs are not yet filled (stub)

1. Create a GitHub-Projects (v2) board for this owner and add the fields above (at minimum a `Status` single-select with your stage options).
2. Ensure `gh` has the scopes: `gh auth refresh -s project,read:project`.
3. Re-run `/setup-workflow` — it discovers the board (`gh project field-list`) and fills the IDs here automatically.
