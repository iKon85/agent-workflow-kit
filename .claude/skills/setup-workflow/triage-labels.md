# Triage Labels

The skills speak in terms of five canonical triage roles, but only two are ever applied as issue labels. This file maps those two roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| --------------------------- | --------------------- | ----------------------------------------- |
| `needs-info`                 | `needs-info`           | Waiting on reporter for more information |
| `ready-for-agent`            | `ready-for-agent`      | Fully specified, ready for an AFK agent  |

**Board status is authoritative** for the remaining three canonical roles — they are never applied as labels:

- `needs-triage` — the tracker's initial/backlog status covers this.
- `ready-for-human` — most AFK-agent workflows don't split human-work out as a label; if yours does, add it back as a third row.
- `wontfix` — close the issue instead of labelling it.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from the table above if it's one of the two active roles; for any other role, use the tracker's status field or close the issue instead of adding a label.

Edit the right-hand column, or re-add a row, to match whatever vocabulary you actually use.
