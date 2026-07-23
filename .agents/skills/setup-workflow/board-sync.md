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
| Phase | single-select | optional | groups waves into phases for the Program route (`to-issues` Program mode / internal graph validation) — only needed if this project uses it |

## Machine profile (SSOT) — `scripts/board_config.py` reads this

`/setup-workflow` fills the board-identity values (node id, field IDs, status options) from `gh project field-list`. The convention values (labels, branch prefixes, PR markers, headings) ship pre-filled to match the bundled skills — edit them only if you adapt those conventions. The IDs live **only** in this block (the table above is documentation), so the two cannot drift.

The optional `wrapup` block is a wrapup-only switch, not a board field: `wrapup.remoteBranchSweep` (default `false`) gates `wrapup` Step 5d's remote-branch sweep — `false`/missing (the shipped default) means Step 5d only reports the count of stale merged-PR remotes it found; `true` lets it actually `git push origin --delete` them. Flip it to `true` once you trust the sweep in your repo.

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
      "options": { "<stage>": "<option-id>" },
      "roles": {
        "idea": "Idea",
        "triaged": "Triaged",
        "spec": "Spec",
        "inProgress": "In Progress",
        "review": "Review",
        "done": "Done"
      }
    },
    "wave": "<fill / omit>",
    "cluster": "<fill / omit>",
    "specPath": "<fill / omit>",
    "planPath": "<fill / omit>",
    "phase": {
      "id": "<fill / omit whole block>",
      "options": { "<phase-name>": "<option-id>" }
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
    "wavePrefix": "Wave"
  },
  "wrapup": {
    "remoteBranchSweep": false
  }
}
```

### Status roles (`fields.status.roles`)

The scripts and skills never hardcode status option NAMES — they address stages
by semantic **role** (`idea` / `triaged` / `spec` / `inProgress` / `review` /
`done`) and resolve the name via this map (e.g. `board-sync.py add
--status-role spec`, the SessionStart auto-transition, the wave/anchor status
icons). The seeded values above are the **recommended English defaults**: name
your board's Status options exactly like that and nothing needs editing. A
board in another language (or with different stage names) maps each role to
its own option name once — e.g. `"inProgress": "En cours"` — and everything
follows; renaming an option later is one edit here. A role you don't have
(e.g. no `idea` stage) may simply be omitted. A profile **without** the whole
`roles` map keeps loading: the auto-transition hook and status icons degrade
with a visible hint, and `--status-role` commands fail with the exact snippet
to add.

### Wave titles (`titles.wavePrefix`)

The word that opens a wave anchor's title: `<prefix> <N> — <topic>` (e.g.
`Wave 7 — Auth hardening`). `board-sync.py promote` writes it and strips an
existing one idempotently on re-promote. A profile **without** the key keeps
the historical default `"Welle"`, so boards created before this key keep
their titles unchanged; set it once to match your board's language.

## If the IDs are not yet filled (stub)

1. Create a GitHub-Projects (v2) board for this owner and add the fields above (at minimum a `Status` single-select with your stage options — the recommended stage names are `Idea, Triaged, Spec, In Progress, Review, Done`, matching the seeded `roles` defaults).
2. Ensure `gh` has the scopes: `gh auth refresh -s project,read:project`.
3. Re-run `/setup-workflow` — it discovers the board (`gh project field-list`) and fills the IDs here automatically.

## Optional: the Program route (Phase field + saved Views)

Skip this section entirely unless this project actually plans to use the Program
route (`scale-check` → `to-issues` with explicit Program identity → internal
graph validation) — `fields.phase` / `labels.programType` are never
auto-discovered or auto-created (a Phase field's option set is plan-specific,
not something `/setup-workflow` can guess), and a profile without them keeps
loading unchanged.

1. **Create the Phase field:** `gh project field-create <number> --owner <owner> --name Phase --data-type SINGLE_SELECT --single-select-options "P1,P2,P3"` (name the options after this project's actual phases).
2. **Fill `fields.phase`** in the `<!-- board-sync:profile -->` block above with the same `{id, options}` shape as `fields.status` — read both back via `gh project field-list <number> --owner <owner> --format json`.
3. **Fill `labels.programType`** only if this project's Program-PRD type label should differ from the shipped literal default `type:program`.
4. **Create two saved Views** in the GitHub Projects UI by hand (not API-creatable):
   - **"Program"** — Group by: `Phase` · Sort by: `Wave` · Filter: `type:cluster OR wave-stub OR type:program`.
   - **"Active Wave"** — Filter: `Wave=<n>` (the current wave number) · Group by: `Status`.
