# Workflow

Use this section as the entry-point map for agent-assisted work. The individual skills carry the detailed mechanics; this overview helps choose the right starting point.

## Entry Points

- **Unsure which skill fits?** Ask `ask-matt` — a router over every skill in this list, with a recommended starting point and why.
- **A new build whose size is unclear** (a new app, a big cross-cutting feature, an unclear where-to-start): run `scale-check` — a short plain-language dialog that routes it to a program, a feature, a single slice, or a bug, and hands back a paste-ready start prompt.
- **New capability or unclear change:** start with `grill-with-docs` when the domain language or decisions need sharpening, then publish the agreed shape with `to-prd`.
- **A slice hinges on an unresolved fact or trade-off before it can be built:** clear it first — a binary yes/no question against real code/runtime/platform with `verify-spike`, a bounded "which option" choice with `decision-gate`.
- **Existing plan, PRD, or ready issue:** use `to-issues` to split it into independently buildable tracer-bullet slices.
- **A Program-PRD with a wave plan:** use `to-waves` to unfold it into named wave stubs + slice leaves on the board, after a chat preview gate that shows the whole plan before any write.
- **A backlog of open issues needs clustering into themed waves:** use `board-to-waves`.
- **A whole wave anchor (file-disjoint slices, specs already locked) to build, verify and land end-to-end — often AFK:** use `orchestrate-wave` — it dispatches implementers per slice, integrates serially, verifies centrally, and lands. (A single slice just goes to `tdd`.)
- **Bugs or requests piling up that you didn't create:** use `triage` to move them into agent-ready issues.
- **Bug or regression:** use `diagnose` to reproduce, minimize, hypothesize, instrument, fix, and regression-test.
- **A design question needs a runnable answer (state, business logic, a UI you have to see):** spike it with `prototype`, then fold what you learned back in.
- **Multi-session build from a PRD or issue:** use `implement` to drive `tdd` end-to-end, one red-green slice at a time.
- **Implementation slice:** use `tdd` for one behavior at a time: RED, GREEN, then refactor.
- **Finished slice:** use `wrapup` to prepare the branch, PR, and cleanup steps your repo expects.
- **Kit release:** use `kit-release` to derive the shipped delta, confirm Semver, regenerate the manifest, run all gates, and then hand landing to `wrapup`.
- **A huge, foggy effort, too big for one session:** use `wayfinder` — it charts it as a shared map of investigation tickets, resolving one per session.

## Routing Rule

Prefer the smallest workflow that produces a clear next action. A tiny fix can go straight to `tdd`; a cross-cutting feature should become a PRD and then slices before implementation. When a skill reports missing project context, run `setup-workflow` again and fill only the missing stub.

## Depth Ladder

- **Light:** direct `tdd` for a small, well-understood change.
- **Medium:** `to-issues` for a ready artefact that needs slicing.
- **Deep:** `grill-with-docs` followed by `to-prd` and `to-issues` when terminology, contracts, rollout order, or ownership are still uncertain.
- **Gate:** insert `verify-spike` or `decision-gate` before any depth level when a slice hinges on an unresolved fact or trade-off.
