<!-- setup-workflow: state=filled; mode=github-projects-v2 -->
# Board sync — GitHub Projects field IDs

The workflow board is [Agent Workflow Kit](https://github.com/users/iKon85/projects/3). Board-managed skills address it through the profile below and `scripts/board-sync.py`.

<!-- board-sync:profile -->
```json
{
  "repo": "iKon85/agent-workflow-kit",
  "project": {
    "number": 3,
    "owner": "iKon85",
    "nodeId": "PVT_kwHOAuH31M4BdM5V"
  },
  "fields": {
    "status": {
      "id": "PVTSSF_lAHOAuH31M4BdM5VzhXwFOk",
      "options": {
        "Idea": "357a9b54",
        "Triaged": "463d3f21",
        "Spec": "1cd0343b",
        "In Progress": "35e6c509",
        "Review": "51f16b28",
        "Done": "491150b6"
      },
      "roles": {
        "idea": "Idea",
        "triaged": "Triaged",
        "spec": "Spec",
        "inProgress": "In Progress",
        "review": "Review",
        "done": "Done"
      }
    },
    "wave": "PVTF_lAHOAuH31M4BdM5VzhXwFWg",
    "cluster": "PVTF_lAHOAuH31M4BdM5VzhXwFWk",
    "specPath": "PVTF_lAHOAuH31M4BdM5VzhXwFWo",
    "planPath": "PVTF_lAHOAuH31M4BdM5VzhXwFWs",
    "phase": {
      "id": "PVTSSF_lAHOAuH31M4BdM5VzhXwFWw",
      "options": {
        "P1": "9c8c93e0",
        "P2": "cf741bec",
        "P3": "8a69a61e"
      }
    }
  },
  "labels": {
    "readyForAgent": "ready-for-agent",
    "typePrefix": "type:",
    "clusterType": "type:cluster",
    "waveStub": "wave-stub",
    "programType": "type:program"
  },
  "branchPrefixes": ["feat", "fix", "chore", "docs"],
  "prMarkers": {
    "partOf": "Part of",
    "retroMarker": "**Retro:**",
    "retroValues": ["ran", "skipped"]
  },
  "headings": {
    "vorBau": "Clarify Before Build"
  },
  "titles": {
    "wavePrefix": "Welle"
  },
  "wrapup": {
    "remoteBranchSweep": false
  }
}
```

The Program route uses phases `P1`, `P2`, and `P3`. Saved board views remain a GitHub UI concern; the machine profile above is the workflow SSOT.

