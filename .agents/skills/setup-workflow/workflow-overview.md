# Workflow

Take the smallest route that produces a clear next action; each skill carries
its own mechanics.

- **Plan:** unclear terms → `grill-with-docs` → `to-prd`; ready plan, PRD, or
  issue → `to-issues` (the single Planning facade — Feature identity selects
  tracer-bullet decomposition, Program identity the internal graph path and its
  complete preview before any write); backlog → `board-to-waves`; huge and
  foggy → `wayfinder`; reports you did not file → `triage`.
- **Gate:** binary fact → `verify-spike`; bounded option choice →
  `decision-gate`; design question needing a runnable answer → `prototype`.
- **Build:** any change → `implement` (one behaviour, RED→GREEN→refactor; a
  tiny fix comes straight here, no entry question); file-disjoint wave anchor →
  `orchestrate-wave`; bug or regression → `diagnose`; finished slice →
  `wrapup`.
- **Maintain:** project-local census → `census-update`; consumer-owned memories
  → `memory-lifecycle`; kit release → `kit-release`; consumer package release →
  `project-release`; kit upgrade → `kit-update`; a skill reporting missing
  project context → `setup-workflow` (fill only the missing stub).
- **User-invoked:** `ask-matt` names the skill that fits a situation;
  `scale-check` routes a new build whose size is unclear.
