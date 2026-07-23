# to-issues is the single planning facade

Status: accepted (2026-07-22, issue #197)

The planning workflow exposes two mechanisms after `to-prd`: Feature PRDs are
decomposed by `to-issues`, while Program PRDs are unfolded by a separately
invoked `to-waves` skill which later calls `to-issues` for each wave. This makes
the user identify an internal planning altitude even though the PRD already
carries an explicit, durable identity that can select the correct mechanism.

We decided that `to-issues` is the single user-facing Planning facade:

1. A Feature PRD selects the existing atomic/promote mechanism.
2. A Program PRD selects the existing program-graph engine currently owned by
   `to-waves`, including its complete preview, validation, publication,
   per-wave maturation, and execute-ready audits.
3. Dispatch uses only explicit PRD identity (`prd: program` or its canonical
   program type), never size heuristics or model judgment.
4. The selected mode is reported visibly before mutation. Program mode retains
   its full preview approval gate.
5. `to-waves` remains an independently testable internal mechanism and may keep
   a compatibility entrypoint, but routers and normal documentation always send
   the user from `to-prd` to `to-issues`.

## Considered options

- **Keep two public next commands:** rejected because it leaks internal
  decomposition mechanics and makes users repeat an altitude decision already
  encoded in the PRD.
- **Infer the mode from plan size or prose:** rejected because hidden heuristics
  make the same command unpredictable and can publish the wrong board shape.
- **Merge all program code physically into `to-issues`:** rejected because the
  program graph is a coherent deep module with valuable separate tests; only
  its public routing belongs behind the facade.

## Consequences

- The normal user path is always `grill → to-prd → to-issues`.
- Feature and Program behavior remain distinguishable in audit output without
  requiring the user to select their implementation skill.
- Router, overview, skill prose, mirrors, and contract tests must agree on the
  one-entry contract.
