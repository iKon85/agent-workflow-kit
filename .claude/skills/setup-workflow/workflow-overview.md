# Workflow

Use this section as the entry-point map for agent-assisted work. The individual skills carry the detailed mechanics; this overview helps choose the right starting point.

## Entry Points

- **New capability or unclear change:** start with `grill-with-docs` when the domain language or decisions need sharpening, then publish the agreed shape with `to-prd`.
- **Existing plan, PRD, or ready issue:** use `to-issues` to split it into independently buildable tracer-bullet slices.
- **Bug or regression:** use `diagnose` to reproduce, minimize, hypothesize, instrument, fix, and regression-test.
- **Implementation slice:** use `tdd` for one behavior at a time: RED, GREEN, then refactor.
- **Finished slice:** use `wrapup` to prepare the branch, PR, and cleanup steps your repo expects.

## Routing Rule

Prefer the smallest workflow that produces a clear next action. A tiny fix can go straight to `tdd`; a cross-cutting feature should become a PRD and then slices before implementation. When a skill reports missing project context, run `setup-workflow` again and fill only the missing stub.

## Depth Ladder

- **Light:** direct `tdd` for a small, well-understood change.
- **Medium:** `to-issues` for a ready artefact that needs slicing.
- **Deep:** `grill-with-docs` followed by `to-prd` and `to-issues` when terminology, contracts, rollout order, or ownership are still uncertain.
