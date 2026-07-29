/**
 * Welle 31 · Slice 0 — the authored station model (#404; #380 §5).
 *
 * One entry per journey id in `substrate/journeys.json`, each holding that
 * journey's stations in walk order. A station is a promise-bearing checkpoint:
 * something the kit SAYS will happen there. The columns are #380 §5's, verbatim
 * and in order:
 *
 *   journey_id · station_id · promise (cited) · what it actually verifies ·
 *   binding hardness · phase · user decision · agent action ·
 *   authorization boundary · recovery relation
 *
 * `journey_id` comes from the key, the other nine from the tuple below. The
 * separation between "promise" and "what it actually verifies" is the whole
 * point of the column set: the promise is quoted from a shipped artifact, the
 * verification column says what the mechanism at that station can actually
 * observe. Slice 1 and Slice 2 compare the two — this slice only freezes them.
 *
 * `recovery relation` encodes #380 §5's rule that a recovery branch is a
 * station variant unless it has its own entry point:
 *   `none`                          — no recovery branch at this station
 *   `variant-of:<journey>#<station>` — a branch that reuses the same entry point
 *   `escalates-to:<journey>`         — a branch that has its own entry point,
 *                                      so it is a journey of its own
 *   `recovers:<journey>`             — a station inside a recovery journey,
 *                                      naming the journey being recovered
 *
 * Every promise citation must resolve: a repository path that exists, or an
 * issue number frozen in `docs/evidence/welle-31/issue-bodies.json`. The census
 * validator enforces that; a plausible but unresolvable citation is the failure
 * mode both censuses exist to make expensive.
 */

/** Tuple order after `station_id`, mirroring the #380 §5 column order. */
export const TUPLE_COLUMNS = [
  'stationId', 'promiseText', 'promiseCitation', 'verifies', 'bindingHardness',
  'phase', 'userDecision', 'agentAction', 'authorizationBoundary', 'recoveryRelation',
];

/** How hard the promise binds — what, if anything, can fail and stop the walk. */
export const BINDING_HARDNESS = [
  'mechanical', // a command, hook, test or guard in this repo can fail it
  'platform-enforced', // GitHub or npm enforces it outside this repository
  'documented', // written as a rule in a shipped artifact; nothing fails it
  'judgment', // left to the actor; no rule and no check
];

export const PHASES = ['intake', 'plan', 'build', 'verify', 'land', 'publish', 'close', 'recover'];

export const AUTHORIZATION_BOUNDARIES = [
  'agent-autonomous', // the agent may act without asking
  'standing-authorization', // a prior explicit human mandate covers this action
  'human-gate', // the human decides here, per an explicit rule
  'platform-gate', // GitHub/npm decides; neither actor can wave it through
  'consumer-owned', // the consumer's own repository decides
];

export const STATION_MODEL = {
  'idea-to-board-issue': [
    ['capture', 'Every finding becomes a `gh` issue at session end', 'CLAUDE.md', 'that an issue was opened, not that the idea was worth tracking', 'documented', 'intake', 'whether the idea is tracked at all', 'drafts a title and body from the session', 'agent-autonomous', 'none'],
    ['board-write', 'All board writes go through `scripts/board-sync.py`, never bare `gh issue create`', 'scripts/board-sync.py', 'that field ids and status names came from the board profile, not from an inline literal', 'mechanical', 'intake', 'none', 'runs the board-sync create path', 'agent-autonomous', 'escalates-to:recovery-board-status-drift'],
    ['classify', 'Board status is primary; only information-waiting and AFK-readiness use labels', 'docs/agents/triage-labels.md', 'that a Status value and a type label are set, not that they are the right ones', 'documented', 'intake', 'confirms the type of work', 'sets Status and the type label', 'agent-autonomous', 'none'],
  ],
  'inbound-triage-to-agent-ready': [
    ['sweep', 'Bugs or requests you did not create are moved into agent-ready issues', '.claude/skills/triage/SKILL.md', 'that the open inbound set was listed; not that every item was understood', 'documented', 'intake', 'which inbound items are in scope', 'reads the open unassigned issues', 'agent-autonomous', 'none'],
    ['readiness-label', 'Only information-waiting and AFK-readiness use labels', 'docs/agents/triage-labels.md', 'that a label was applied, not that the issue is executable', 'documented', 'intake', 'accepts or overrides the readiness verdict', 'applies the readiness label through board-sync', 'agent-autonomous', 'none'],
    ['execute-ready', 'An agent-ready issue carries a complete What + AC', 'scripts/execute-ready-check.py', 'that the required sections are present — presence, not sufficiency', 'mechanical', 'intake', 'none', 'runs the execute-ready check on the body', 'agent-autonomous', 'none'],
  ],
  'backlog-to-waves-clustering': [
    ['read-population', 'Reads all open issues before grouping', '.claude/skills/board-to-waves/SKILL.md', 'that the grouping saw the open set at that moment', 'documented', 'plan', 'none', 'lists every open issue', 'agent-autonomous', 'none'],
    ['cluster-proposal', 'Groups by the Gate+Booster+Splitter heuristic with size, risk and grill-needed per candidate', '.claude/skills/board-to-waves/SKILL.md', 'that a grouping was proposed — never that it is the best partition', 'judgment', 'plan', 'confirms or rejects the candidate clusters', 'proposes candidates with estimates', 'human-gate', 'none'],
    ['stub-only', 'STOPS at stubs: no PRD, no slicing, no sub-issue links, no promotion', '.claude/skills/board-to-waves/SKILL.md', 'that only stub issues were written; the stop itself is unchecked', 'documented', 'plan', 'approves creating the stubs', 'creates cluster stubs through board-sync', 'human-gate', 'none'],
  ],
  'prd-maturation': [
    ['shape-agreement', 'Publish the agreed shape as a PRD', '.claude/skills/to-prd/SKILL.md', 'that a PRD document exists, not that it matches what was agreed', 'documented', 'plan', 'confirms the agreed shape', 'drafts the PRD onto the anchor', 'human-gate', 'none'],
    ['self-critique', 'A 12-point structural self-critique runs before a human reads the spec', '.claude/skills/spec-self-critique/SKILL.md', 'that the checklist ran and the summary is visible', 'documented', 'plan', 'none', 'runs the checklist and fixes findings inline', 'agent-autonomous', 'none'],
    ['status-spec', 'Status values come from the board profile, never an inline literal', 'docs/agents/board-sync.md', 'that a Status field write succeeded', 'mechanical', 'plan', 'none', 'sets the spec Status through board-sync', 'agent-autonomous', 'escalates-to:recovery-board-status-drift'],
  ],
  'plan-to-executable-slices': [
    ['identity-declaration', 'Explicit Feature identity selects tracer-bullet decomposition; explicit Program identity selects the internal graph path', '.claude/skills/to-issues/SKILL.md', 'that an identity was declared before decomposition — not that it was the right one', 'documented', 'plan', 'declares Feature or Program identity', 'routes to the matching decomposition', 'human-gate', 'none'],
    ['complete-preview', 'A complete preview precedes any write', '.claude/skills/to-issues/SKILL.md', 'that a preview was rendered; not that the human read it', 'documented', 'plan', 'approves the previewed slice set', 'renders the full slice list', 'human-gate', 'none'],
    ['slice-bodies', 'Each slice is independently grabbable with What + AC', 'docs/conventions/spec-completeness.md', 'that the required sections exist in each body', 'mechanical', 'plan', 'none', 'writes the slice bodies', 'agent-autonomous', 'none'],
    ['anchor-link', 'Sub-issue links and promotion go through `scripts/board-sync.py`', 'scripts/board-sync.py', 'that the sub-issue link and Status write landed on the board', 'mechanical', 'plan', 'none', 'links the slices to the anchor and promotes them', 'agent-autonomous', 'escalates-to:recovery-anchor-closed-early'],
  ],
  'program-graph-decomposition': [
    ['facade-entry', '`to-issues` is the single public Planning facade; the graph engine is internal', 'docs/adr/0005-to-issues-is-the-planning-facade.md', 'that the entry was the facade — the engine has no invocable surface of its own (#322)', 'documented', 'plan', 'declares Program identity', 'delegates to the internal graph path', 'human-gate', 'none'],
    ['graph-parse', 'A Program plan is parsed into a dependency graph before any issue is written', 'scripts/program_graph_parse.py', 'that the plan text parsed — not that the dependencies are real', 'mechanical', 'plan', 'none', 'parses the plan into nodes and edges', 'agent-autonomous', 'none'],
    ['graph-validate', 'The graph is validated before publication', 'scripts/program_graph_validate.py', 'that the graph is acyclic and complete against its own schema', 'mechanical', 'verify', 'none', 'runs the graph validator', 'agent-autonomous', 'none'],
    ['graph-publish', 'Phases are published onto the board with the profile’s field ids', 'scripts/program_sync.py', 'that the phase writes landed', 'mechanical', 'plan', 'approves publication', 'syncs the graph to the board', 'human-gate', 'escalates-to:recovery-board-status-drift'],
  ],
  'cross-model-plan-hardening': [
    ['plan-freeze', 'Claude writes the locked plan to PLAN.md before the critic sees it', '.claude/skills/codex-review/SKILL.md', 'that a frozen plan file exists', 'documented', 'plan', 'locks the plan', 'writes PLAN.md', 'human-gate', 'none'],
    ['read-only-review', 'The second model reviews in a read-only sandbox', 'scripts/codex-exec.sh', 'that the critic process ran read-only — the sandbox flag, not the critique quality', 'mechanical', 'verify', 'none', 'invokes the critic in a read-only sandbox', 'agent-autonomous', 'escalates-to:recovery-guard-false-red-blocks-capability'],
    ['verdict-loop', 'Revise and re-submit to the SAME session until APPROVED or MAX_ROUNDS', '.claude/skills/grill-with-docs-codex/SKILL.md', 'that a verdict token came back; not that the objections were addressed', 'documented', 'verify', 'signs off after the verdict', 'revises and re-submits', 'human-gate', 'none'],
  ],
  'domain-grill-and-context-update': [
    ['one-question', 'Claude interviews one question at a time until every branch is resolved', '.claude/skills/grill-with-docs/SKILL.md', 'that questions were asked; not that the decision tree was exhausted', 'judgment', 'plan', 'answers each question', 'asks and recommends', 'human-gate', 'none'],
    ['challenge-against-docs', 'The plan is challenged against the project’s existing domain model and glossary', 'CONTEXT.md', 'that the glossary was read; not that a conflict would be noticed', 'documented', 'plan', 'settles contested terms', 'cross-references CONTEXT.md and ADRs', 'agent-autonomous', 'none'],
    ['inline-doc-update', 'CONTEXT.md and ADRs are updated inline as decisions crystallise', 'docs/agents/domain.md', 'that the files were written in-session', 'documented', 'plan', 'accepts each documented decision', 'writes the glossary and ADR entries', 'human-gate', 'none'],
  ],
  'spec-self-critique-before-review': [
    ['checklist-run', 'A 12-point structural checklist runs on the spec text itself', '.claude/skills/spec-self-critique/SKILL.md', 'that twelve checks were executed against the text', 'documented', 'verify', 'none', 'runs the checklist', 'agent-autonomous', 'none'],
    ['project-enrichment', 'Each check is enriched from the project layer when one is present', 'docs/agents/skills/spec-self-critique.md', 'that the project layer file was read if it exists', 'documented', 'verify', 'none', 'loads the project extension', 'agent-autonomous', 'none'],
    ['visible-summary', 'Issues are fixed inline and a visible summary is emitted', '.claude/skills/spec-self-critique/SKILL.md', 'that a summary was printed — not that every finding was fixed', 'documented', 'verify', 'reads the summary before reviewing', 'edits the spec and prints the summary', 'agent-autonomous', 'none'],
  ],
  'scale-check-route-a-new-build': [
    ['size-dialog', 'A short plain-language dialog routes a build of unclear size', '.claude/skills/scale-check/SKILL.md', 'that the dialog ran', 'documented', 'intake', 'answers the routing questions', 'asks the routing questions', 'human-gate', 'none'],
    ['route-verdict', 'Routes to a program, a feature, a single slice, or a bug', 'CLAUDE.md', 'that one of the four routes was named; nothing checks the fit', 'judgment', 'intake', 'accepts or overrides the route', 'names the route with a reason', 'human-gate', 'none'],
    ['start-prompt', 'Hands back a paste-ready start prompt', '.claude/skills/scale-check/SKILL.md', 'that a prompt string was produced', 'documented', 'intake', 'decides whether to start now', 'emits the start prompt', 'agent-autonomous', 'none'],
  ],
  'router-recommends-a-starting-point': [
    ['router-scan', 'A router over every skill in the entry-point list', '.claude/skills/ask-matt/SKILL.md', 'that the routed set is the entry-point list — not the full installed surface', 'documented', 'intake', 'states the task in their own words', 'matches the task against the skill list', 'agent-autonomous', 'none'],
    ['recommendation', 'Returns a recommended starting point and why', '.claude/skills/ask-matt/SKILL.md', 'that a skill name and a reason came back', 'documented', 'intake', 'accepts or ignores the recommendation', 'names one starting skill', 'human-gate', 'none'],
    ['handoff', 'Prefer the smallest workflow that produces a clear next action', 'CLAUDE.md', 'nothing mechanical — the depth ladder is prose', 'documented', 'intake', 'chooses the depth', 'hands over to the named skill', 'human-gate', 'none'],
  ],
  'wayfinder-chart-a-foggy-effort': [
    ['chart', 'A huge foggy effort is charted as a shared map of investigation tickets', '.claude/skills/wayfinder/SKILL.md', 'that a map artifact exists', 'documented', 'plan', 'confirms the map', 'drafts the investigation map', 'human-gate', 'none'],
    ['ticket-write', 'Each unknown becomes an investigation ticket on the tracker', 'scripts/board-sync.py', 'that the tickets were created through the board profile', 'mechanical', 'plan', 'approves the ticket set', 'creates the tickets', 'human-gate', 'none'],
    ['one-per-session', 'One investigation resolves per session', '.claude/skills/wayfinder/SKILL.md', 'nothing — the pacing rule is prose', 'documented', 'plan', 'picks the next ticket', 'resolves the picked ticket', 'human-gate', 'none'],
  ],
  'verify-a-fact-before-plan-lock': [
    ['question-binarisation', 'A single yes/no factual question, not a design question', '.claude/skills/verify-spike/SKILL.md', 'that the question was stated in binary form', 'documented', 'verify', 'states the question', 'restates it as a yes/no claim', 'human-gate', 'none'],
    ['harness-run', 'A minimal throwaway, read-only harness with output-proof', '.claude/skills/verify-spike/SKILL.md', 'that a command ran and produced output — read-only is asserted, not sandboxed', 'documented', 'verify', 'none', 'writes and runs the harness', 'agent-autonomous', 'none'],
    ['positive-control', 'A negative measurement is no proof until the harness has produced a positive', 'CLAUDE.md', 'that a control run exists next to the negative', 'documented', 'verify', 'none', 'runs the positive control and records both', 'agent-autonomous', 'none'],
    ['verdict-record', 'The proven verdict is recorded and the harness removed', '.claude/skills/verify-spike/SKILL.md', 'that a verdict line was written; removal is unchecked', 'documented', 'verify', 'accepts the verdict before plan-lock', 'records the verdict, deletes the harness', 'human-gate', 'none'],
  ],
  'resolve-a-bounded-tradeoff': [
    ['scope-check', 'Above a binary yes/no fact and below an ADR-worthy decision', '.claude/skills/decision-gate/SKILL.md', 'that the choice was placed on the ladder', 'documented', 'plan', 'confirms the altitude', 'places the question', 'human-gate', 'none'],
    ['tradeoff-table', 'Read-only investigation produces a documented weigh-up', '.claude/skills/decision-gate/SKILL.md', 'that a table with options and costs exists', 'documented', 'plan', 'none', 'investigates and tabulates', 'agent-autonomous', 'none'],
    ['sink-the-decision', 'The pick is sunk into an ADR, issue or comment', 'docs/agents/domain.md', 'that a durable record was written', 'documented', 'plan', 'makes the pick', 'writes the record', 'human-gate', 'none'],
  ],
  'research-a-question': [
    ['source-tier', 'Investigate against high-trust primary sources', '.claude/skills/research/SKILL.md', 'that sources were cited; tier is asserted by the agent', 'judgment', 'plan', 'names the question', 'gathers and cites sources', 'agent-autonomous', 'none'],
    ['capture', 'Findings are captured as a Markdown file in the repo', '.claude/skills/research/SKILL.md', 'that a file exists under the research directory', 'documented', 'plan', 'none', 'writes the research note', 'agent-autonomous', 'none'],
    ['landing', 'Durable planning output lands through wrapup’s Content route', '.claude/skills/wrapup/SKILL.md', 'that the note reached a branch and a PR', 'documented', 'land', 'approves landing', 'runs the Content route', 'human-gate', 'none'],
  ],
  'land-planning-output': [
    ['content-claim', 'Durable output lands through the Content route as ordinary work', '.claude/skills/wrapup/SKILL.md', 'that the claimed paths are durable, not scratch', 'mechanical', 'land', 'confirms what is durable', 'claims the content paths', 'agent-autonomous', 'none'],
    ['no-release-coupling', 'Landing an ADR must not require a release', '#343', 'that no shipped path was touched — the coupling is what #343 recorded as cost', 'documented', 'land', 'none', 'keeps the diff off shipped paths', 'agent-autonomous', 'none'],
    ['pr-body', 'Leaf-issue PR bodies carry `closes #<n>`; slice PRs carry `Part of #<anchor>`', 'scripts/pr-body-check.py', 'that the marker matches the profile vocabulary', 'mechanical', 'land', 'none', 'writes the PR body and checks it', 'agent-autonomous', 'escalates-to:recovery-anchor-closed-early'],
  ],
  'small-direct-path': [
    ['direct-entry', 'A tiny fix can go straight to `implement`', 'CLAUDE.md', 'nothing — the depth ladder is prose the actor applies', 'documented', 'intake', 'chooses the direct path', 'starts implementing', 'human-gate', 'none'],
    ['red-green', 'Execute = red→green test-first, never test-after', 'CLAUDE.md', 'that a failing test preceded the fix, if the actor ran one', 'documented', 'build', 'none', 'writes the failing test, then the fix', 'agent-autonomous', 'none'],
    ['land', 'Finished slice: use `wrapup` to prepare branch, PR and cleanup', '.claude/skills/wrapup/SKILL.md', 'that a PR exists and the branch is clean', 'mechanical', 'land', 'approves the PR', 'runs wrapup', 'human-gate', 'none'],
  ],
  'small-bug-fix-to-merged-and-released': [
    ['repro', 'A bug is reproduced before it is fixed', '.claude/skills/diagnose/SKILL.md', 'that a reproduction was recorded; not that it is minimal', 'documented', 'build', 'reports the bug', 'reproduces and minimises', 'agent-autonomous', 'none'],
    ['regression-test', 'A regression test proves the fix', '.claude/skills/tdd/SKILL.md', 'that a test exists and was red before the fix', 'mechanical', 'build', 'none', 'writes the regression test', 'agent-autonomous', 'none'],
    ['local-gate', '`/local-ci` stays the explicit pre-PR gate', '.claude/skills/local-ci/SKILL.md', 'that the suite, staleness and guards ran green locally', 'mechanical', 'verify', 'none', 'runs the local gate', 'agent-autonomous', 'variant-of:run-the-local-gate#gate-run'],
    ['required-check', 'The CI job `test` must be green with the branch up to date', '.github/workflows/ci.yml', 'that GitHub’s required context passed — the job name, not the workflow name', 'platform-enforced', 'land', 'merges the PR', 'waits for the check', 'platform-gate', 'none'],
    ['publish', 'A matching annotated tag on canonical main is the sole normal publication intent', '#257', 'that the tag exists, is annotated, matches the version and sits on main', 'platform-enforced', 'publish', 'confirms the Semver once', 'tags and monitors to released', 'standing-authorization', 'escalates-to:recovery-red-release-run-but-published'],
  ],
  'tdd-red-green-refactor': [
    ['red', 'A failing test comes first and is proven failing', '.claude/skills/tdd/SKILL.md', 'that the test ran and failed for the intended reason', 'mechanical', 'build', 'none', 'writes and runs the failing test', 'agent-autonomous', 'none'],
    ['green', 'The smallest change makes it pass', '.claude/skills/tdd/SKILL.md', 'that the suite is green — not that the change was minimal', 'mechanical', 'build', 'none', 'implements until green', 'agent-autonomous', 'none'],
    ['refactor', 'Refactor happens under a green suite', '.claude/skills/tdd/SKILL.md', 'that the suite stayed green across the refactor', 'mechanical', 'build', 'none', 'refactors and re-runs', 'agent-autonomous', 'none'],
  ],
  'bug-diagnosis-to-regression-test': [
    ['reproduce', 'Reproduce before hypothesising', '.claude/skills/diagnose/SKILL.md', 'that a reproduction command exists', 'documented', 'build', 'reports the symptom', 'reproduces the failure', 'agent-autonomous', 'none'],
    ['minimise-and-instrument', 'Minimise, hypothesise, instrument', '.claude/skills/diagnose/SKILL.md', 'that instrumentation output was read; not that the hypothesis was falsifiable', 'judgment', 'build', 'none', 'minimises and instruments', 'agent-autonomous', 'none'],
    ['cause-not-symptom', 'Fix the cause, not the symptom; a plaster is a named, tracked choice', 'CLAUDE.md', 'nothing mechanical — the distinction is the agent’s claim', 'documented', 'build', 'accepts a plaster only deliberately', 'names the root cause and fixes it', 'human-gate', 'none'],
    ['regression-test', 'The fix is locked by a regression test', '.claude/skills/tdd/SKILL.md', 'that the new test fails without the fix', 'mechanical', 'verify', 'none', 'adds the regression test', 'agent-autonomous', 'none'],
  ],
  'prototype-a-design': [
    ['branch-choice', 'Routes between a runnable terminal app and several UI variations', '.claude/skills/prototype/SKILL.md', 'that one branch was chosen', 'documented', 'plan', 'picks the branch', 'routes the prototype', 'human-gate', 'none'],
    ['build-throwaway', 'The prototype is throwaway, not a first slice', '.claude/skills/prototype/SKILL.md', 'nothing — throwaway-ness is a convention', 'documented', 'build', 'plays with the result', 'builds the prototype', 'agent-autonomous', 'none'],
    ['fold-back', 'What was learned is folded back in', '.claude/skills/prototype/SKILL.md', 'that a decision record or plan edit followed', 'judgment', 'close', 'decides what survives', 'writes the learning back', 'human-gate', 'none'],
  ],
  'delegate-build-to-codex': [
    ['spec-freeze', 'Claude stays the spec-writer; a frozen spec is handed over', '.claude/skills/codex-build/SKILL.md', 'that a spec file exists before the delegation', 'documented', 'plan', 'approves the frozen spec', 'writes the spec', 'human-gate', 'none'],
    ['bounded-sandbox', 'The build runs inside a bounded workspace-write sandbox with a declared allowed-write set', 'scripts/codex-exec.sh', 'that the sandbox flags were passed — not that the build honoured the write set', 'mechanical', 'build', 'none', 'invokes the sandboxed build', 'agent-autonomous', 'escalates-to:recovery-guard-false-red-blocks-capability'],
    ['diff-review', 'Claude reads the full diff like a contributor PR and runs the proof test', '.claude/skills/codex-build/SKILL.md', 'that the diff was read and the proof test ran', 'documented', 'verify', 'none', 'reviews the diff, runs the test', 'agent-autonomous', 'none'],
    ['human-approval', 'The human approves the diff before any commit', '.claude/skills/codex-build/SKILL.md', 'nothing mechanical — the gate is a prompt', 'documented', 'land', 'approves or rejects the diff', 'waits for approval', 'human-gate', 'none'],
  ],
  'two-axis-code-review': [
    ['merge-base-preflight', 'A three-dot merge-base preflight runs before either axis starts', '.claude/skills/code-review/SKILL.md', 'that the diff range is three-dot against the merge base', 'mechanical', 'verify', 'none', 'computes the review range', 'agent-autonomous', 'none'],
    ['standards-axis', 'Standards axis: this repo’s conventions plus a Fowler-smell baseline', 'docs/agents/code-review.md', 'that the project layer was loaded; findings themselves are judgment', 'judgment', 'verify', 'none', 'reviews against standards', 'agent-autonomous', 'none'],
    ['spec-axis', 'Spec axis: does the diff faithfully implement the originating issue', '.claude/skills/code-review/SKILL.md', 'that the originating issue was fetched and compared', 'documented', 'verify', 'none', 'reviews against the spec', 'agent-autonomous', 'none'],
    ['side-by-side', 'The two axes are reported side by side, never merged or re-ranked', '.claude/skills/code-review/SKILL.md', 'that two separate lists were emitted', 'documented', 'verify', 'reads both rankings', 'reports both', 'human-gate', 'none'],
  ],
  'design-a-deep-module': [
    ['seam-question', 'Shared vocabulary for designing deep modules', '.claude/skills/codebase-design/SKILL.md', 'that the vocabulary was applied to a named seam', 'documented', 'plan', 'names the module', 'frames the seam question', 'agent-autonomous', 'none'],
    ['deepening-pass', 'Find deepening opportunities: interface narrower than implementation', '.claude/skills/codebase-design/SKILL.md', 'nothing mechanical — depth is argued, not measured', 'judgment', 'plan', 'none', 'proposes the deepening', 'agent-autonomous', 'none'],
    ['seam-decision', 'The seam decision is recorded where the next session will read it', 'docs/agents/domain.md', 'that a durable record exists', 'documented', 'plan', 'accepts the seam', 'writes the decision', 'human-gate', 'none'],
  ],
  'improve-codebase-architecture': [
    ['inventory', 'The improvement starts from the existing structure, not a rewrite', '.claude/skills/improve-codebase-architecture/SKILL.md', 'that the current structure was read', 'documented', 'plan', 'names the pain', 'reads and maps the code', 'agent-autonomous', 'none'],
    ['behaviour-preserving', 'Refactor lands behind the existing tests', '.claude/skills/improve-codebase-architecture/SKILL.md', 'that the suite was green before and after', 'mechanical', 'build', 'none', 'refactors under the suite', 'agent-autonomous', 'none'],
    ['scope-fence', 'A finding out of scope is censused and tracked, not silently widened', 'CLAUDE.md', 'nothing mechanical — the fence is a rule', 'documented', 'build', 'decides on scope extension', 'reports the census', 'human-gate', 'none'],
  ],
  'security-audit-of-the-app': [
    ['two-model-pass', 'Two AI models audit the same code separately', '.claude/skills/security-audit/SKILL.md', 'that two independent passes ran', 'documented', 'verify', 'none', 'runs both passes', 'agent-autonomous', 'none'],
    ['gate-run', 'The audit gate runs over the declared scope', 'scripts/security/audit-gate.mjs', 'that the gate command exited zero', 'mechanical', 'verify', 'none', 'runs the audit gate', 'agent-autonomous', 'none'],
    ['harden-plan', 'The remediation plan is hardened before any fix lands', '.claude/skills/security-audit/SKILL.md', 'that a plan exists; hardening is judgment', 'judgment', 'plan', 'approves the remediation plan', 'merges and hardens the findings', 'human-gate', 'none'],
  ],
  'run-the-local-gate': [
    ['gate-run', '`/local-ci` is the explicit pre-PR gate', '.claude/skills/local-ci/SKILL.md', 'that the configured commands ran and their exit codes were read', 'mechanical', 'verify', 'none', 'runs the gate commands', 'agent-autonomous', 'none'],
    ['suite', '`npm test` runs the Node test suite and the Python script tests', 'package.json', 'that both suites exited zero', 'mechanical', 'verify', 'none', 'runs npm test', 'agent-autonomous', 'none'],
    ['staleness', 'The install manifest must match a fresh build', 'scripts/check-kit-staleness.mjs', 'that the built manifest equals the committed one', 'mechanical', 'verify', 'none', 'runs the staleness check', 'agent-autonomous', 'none'],
    ['gate-rerun', 'A red gate is fixed and the gate re-runs; never bypassed with `--no-verify`', 'docs/agents/skills/local-ci.md', 'that the re-run went green — the bypass ban is prose', 'documented', 'verify', 'none', 'fixes and re-runs', 'agent-autonomous', 'variant-of:run-the-local-gate#gate-run'],
    ['hook-backstop', 'pre-push runs the full suite as the backstop, not a replacement', '.githooks/pre-push', 'that the hook ran — only if `core.hooksPath` was wired in this clone', 'mechanical', 'verify', 'wires core.hooksPath once per clone', 'pushes and lets the hook run', 'agent-autonomous', 'none'],
  ],
  'slice-pr-landing': [
    ['branch-shape', 'Branches are `feat|fix|chore|docs/<#>-<slug>`', 'CLAUDE.md', 'that the branch name matches the pattern', 'documented', 'land', 'none', 'names the branch', 'agent-autonomous', 'none'],
    ['checklist-reconcile', 'Reconcile the full issue body against actual state before claiming done', 'CLAUDE.md', 'nothing mechanical — the reconcile is a discipline', 'documented', 'land', 'none', 'walks the issue body item by item', 'agent-autonomous', 'none'],
    ['pr-body', 'Slice PRs carry `Part of #<anchor>`, never `closes`', 'scripts/pr-body-check.py', 'that the body marker matches the profile vocabulary', 'mechanical', 'land', 'none', 'writes and checks the PR body', 'agent-autonomous', 'escalates-to:recovery-anchor-closed-early'],
    ['land', 'Wrapup prepares the branch, PR and cleanup steps the repo expects', 'scripts/wrapup-land.py', 'that the land steps ran; the human still merges', 'mechanical', 'land', 'merges the PR', 'runs the land script', 'human-gate', 'none'],
    ['worktree-cleanup', 'The worktree is torn down after its work landed', 'scripts/worktree-lifecycle/cleanup.py', 'that no tracked work is lost before removal', 'mechanical', 'close', 'none', 'runs teardown', 'agent-autonomous', 'escalates-to:recovery-teardown-blocked-by-symlinks'],
  ],
  'anchor-reconcile-on-slice-event': [
    ['dry-run', '`--dry-run` first, review the diff, then write', 'CLAUDE.md', 'that a preview was produced before the write', 'documented', 'land', 'reviews the diff', 'runs anchor-sync --dry-run', 'agent-autonomous', 'none'],
    ['reconcile', 'Anchor reconcile on every slice event — PR create and merge', 'scripts/anchor_table.py', 'that the rendered table matches the board at that moment', 'mechanical', 'land', 'none', 'runs anchor-sync', 'agent-autonomous', 'escalates-to:recovery-board-status-drift'],
    ['monotonicity', 'The anchor table never regresses a slice’s state', 'scripts/render-anchor.py', 'that the rendered rows are consistent with the board response', 'mechanical', 'land', 'none', 'renders and writes the table', 'agent-autonomous', 'none'],
  ],
  'goal-level-delegation-afk-sweep': [
    ['wave-claim', 'A wave is claimed before dispatch so two runs cannot orchestrate it at once', 'src/lib/waveClaim.mjs', 'that the claim was acquired — the lease, not the intent behind it', 'mechanical', 'plan', 'states the outcome', 'acquires the wave claim', 'standing-authorization', 'escalates-to:recovery-interrupted-afk-run'],
    ['dispatch', 'Dispatches implementers per slice; parallel writing agents get one worktree each', '.claude/skills/orchestrate-wave/SKILL.md', 'that each dispatch got its own worktree', 'documented', 'build', 'none', 'dispatches the slice implementers', 'standing-authorization', 'none'],
    ['serial-integration', 'Integration is serial; slices are file-disjoint', 'docs/agents/skills/orchestrate-wave.md', 'that integration ran one branch at a time', 'documented', 'land', 'none', 'integrates each slice in order', 'agent-autonomous', 'none'],
    ['central-verify', 'Verification is central, after integration, not per dispatch', '.claude/skills/orchestrate-wave/SKILL.md', 'that the suite ran once over the integrated result', 'mechanical', 'verify', 'none', 'runs the full gate centrally', 'agent-autonomous', 'none'],
    ['acceptance', 'One human acceptance at the end of the AFK run', '#343', 'nothing mechanical — the acceptance is a prompt at the end', 'documented', 'close', 'accepts the landed wave', 'reports the wave result', 'human-gate', 'none'],
  ],
  'session-ends': [
    ['durable-capture', 'Every finding becomes a `gh` issue at session end', 'CLAUDE.md', 'that issues were created; not that every finding was captured', 'documented', 'close', 'none', 'files the findings as issues', 'agent-autonomous', 'none'],
    ['handoff', 'The next session’s start prompt anchors on an issue number, not free text', 'CLAUDE.md', 'that a start prompt with an issue number was produced', 'documented', 'close', 'none', 'writes the handoff', 'agent-autonomous', 'none'],
    ['branch-and-pr', 'Branch, PR and worktree end in the state the repo expects', '.claude/skills/wrapup/SKILL.md', 'that the branch is pushed and a PR exists', 'mechanical', 'close', 'approves landing', 'runs wrapup', 'human-gate', 'none'],
    ['teardown', 'Session teardown requires provenance-bound ownership', 'docs/adr/0007-session-teardown-requires-provenance-bound-ownership.md', 'that every removed path was classified as owned by this session (#320)', 'mechanical', 'close', 'none', 'classifies and tears down', 'agent-autonomous', 'escalates-to:recovery-teardown-blocked-by-symlinks'],
  ],
  'retro-after-a-session': [
    ['offer', 'Offer `/retro` before creating the PR, not after merge', 'CLAUDE.md', 'nothing mechanical — the offer is a convention', 'documented', 'close', 'accepts or declines the retro', 'offers the retro', 'human-gate', 'none'],
    ['friction-analysis', 'Analyses session friction and proposes concrete config mutations', '.claude/skills/retro/SKILL.md', 'that proposals were produced; their value is judgment', 'judgment', 'close', 'approves each patch', 'proposes per-patch mutations', 'human-gate', 'none'],
    ['meta-section', 'Findings go into a Meta section of the PR body', 'docs/evidence/welle-31/aggregate-queries.json', 'that the marker line exists — the frozen aggregate shows the marker and the section diverge', 'mechanical', 'close', 'none', 'writes the Meta section', 'agent-autonomous', 'none'],
  ],
  'resolve-a-merge-conflict': [
    ['detect', 'Used when a git merge or rebase conflict is in progress', '.claude/skills/resolving-merge-conflicts/SKILL.md', 'that a conflict state exists in the repository', 'mechanical', 'recover', 'none', 'reads the conflict state', 'agent-autonomous', 'none'],
    ['both-intents', 'Both sides’ intent is preserved, not one side taken wholesale', '.claude/skills/resolving-merge-conflicts/SKILL.md', 'nothing mechanical — intent preservation is judgment', 'judgment', 'recover', 'arbitrates contested hunks', 'resolves hunk by hunk', 'human-gate', 'none'],
    ['complete', 'The merge is completed and the suite re-run', 'package.json', 'that the suite is green after resolution', 'mechanical', 'verify', 'none', 'completes the merge and runs the suite', 'agent-autonomous', 'none'],
  ],
  'author-or-improve-a-skill': [
    ['english-first', 'Every published skill’s prose is English', 'scripts/test_skill_language_census.py', 'that no non-English line survives without an audited marker', 'mechanical', 'build', 'none', 'writes the skill in English', 'agent-autonomous', 'none'],
    ['no-hardcoded-board-values', 'Skills read labels, headings and field ids from the board profile', 'scripts/test_skill_portability_lint.py', 'that no inline board literal is present', 'mechanical', 'build', 'none', 'reads values from the profile', 'agent-autonomous', 'none'],
    ['frontmatter', 'Frontmatter shape is uniform across the shipped surface', 'scripts/test_skill_frontmatter_lint.py', 'that the frontmatter parses and carries the required keys', 'mechanical', 'build', 'none', 'writes the frontmatter', 'agent-autonomous', 'none'],
    ['mirror-same-pr', 'The `.agents/` mirror is updated in the SAME PR, never after merge', 'CLAUDE.md', 'that the mirror matches — the same-PR timing is prose', 'mechanical', 'build', 'none', 'runs the mirror sync', 'agent-autonomous', 'none'],
  ],
  'audit-the-skill-surface': [
    ['denominator', 'Skill-surface claims derive from the manifest and lints, not a recalled list', '.claude/skills/skill-manifest.json', 'that the denominator came from the manifest', 'mechanical', 'verify', 'none', 'derives the surface from the manifest', 'agent-autonomous', 'none'],
    ['drift-per-skill', 'Drift is named per skill against its recorded sources', '.claude/skills/audit-skills/SKILL.md', 'that each skill was compared against its SOURCES record', 'documented', 'verify', 'none', 'compares each skill', 'agent-autonomous', 'none'],
    ['drift-hint', 'A drift hint surfaces the divergence in-session', '.claude/hooks/skill-drift-hint.py', 'that the hook fired — it advises, it does not block', 'mechanical', 'verify', 'reads the advisory', 'emits the hint', 'agent-autonomous', 'none'],
  ],
  'sync-the-codex-mirror': [
    ['sync-run', 'The Codex mirror is regenerated from the Claude surface', '.agents/skills/codex-adapter-sync/SKILL.md', 'that the adapter ran over the changed skills', 'documented', 'build', 'none', 'runs the adapter sync', 'agent-autonomous', 'none'],
    ['contract-test', 'The mirror contract is enforced by a test, not by memory', 'scripts/test_codex_adapter_sync_contract.py', 'that mirror and primary agree on the audited contract points', 'mechanical', 'verify', 'none', 'runs the contract test', 'agent-autonomous', 'none'],
    ['no-claude-only-escalation', 'A Codex-surface skill never references or escalates to a Claude-only target', 'scripts/test_skill_surface_refs.py', 'that no cross-surface reference points at a Claude-only skill', 'mechanical', 'verify', 'none', 'runs the surface-reference lint', 'agent-autonomous', 'none'],
  ],
  'kit-build-and-staleness-check': [
    ['build', 'The install manifest is generated, never hand-edited', 'scripts/build-kit.mjs', 'that the build wrote a manifest from the current sources', 'mechanical', 'build', 'none', 'runs the kit build', 'agent-autonomous', 'none'],
    ['staleness', 'The committed manifest must match a fresh build', 'scripts/check-kit-staleness.mjs', 'that committed and freshly built manifests are identical', 'mechanical', 'verify', 'none', 'runs the staleness check', 'agent-autonomous', 'none'],
    ['gate-membership', 'The staleness check is part of the pre-PR gate', 'docs/agents/skills/local-ci.md', 'that the gate profile lists the command', 'documented', 'verify', 'none', 'runs it inside the gate', 'agent-autonomous', 'variant-of:run-the-local-gate#gate-run'],
  ],
  'release-the-kit': [
    ['semver-gate', 'One human gate: the confirmed Semver authorizes metadata, merge, tag and publish', '#257', 'that a version string was confirmed once — the authority scope is prose', 'documented', 'plan', 'confirms the exact Semver', 'prepares metadata with it', 'human-gate', 'none'],
    ['prepare', 'Prepare with `release:prepare`; never hand-run `npm publish`', 'scripts/kit-release.mjs', 'that bump, manifest and release-note delta were generated together', 'mechanical', 'build', 'none', 'runs the prepare command', 'standing-authorization', 'none'],
    ['delta-guard', 'A bump stacked on a still-untagged release is blocked', 'scripts/release-delta-guard.mjs', 'that the base version carries a matching annotated tag', 'mechanical', 'verify', 'none', 'runs the release guard', 'agent-autonomous', 'escalates-to:recovery-awaiting-tag-stacked-bump'],
    ['merge-integrates', 'Merging integrates the prepared release but cannot publish', 'docs/adr/0004-release-intent-is-a-version-tag.md', 'that publication needs a separate tag event', 'platform-enforced', 'land', 'merges the release PR', 'merges and verifies the version on main', 'standing-authorization', 'none'],
    ['tag', 'A matching annotated `v<version>` tag on canonical main is the sole publication intent', '.github/workflows/release.yml', 'that the tag is annotated, matches the version and is an ancestor of main', 'platform-enforced', 'publish', 'none — the confirmed Semver already authorized it', 'creates and pushes the annotated tag', 'standing-authorization', 'none'],
    ['parity', 'A red run does not prove nothing was published', '#205', 'that npm and the GitHub release agree — checked, not inferred from the run colour', 'mechanical', 'publish', 'none', 'reads npm and the release, reconciles', 'agent-autonomous', 'escalates-to:recovery-red-release-run-but-published'],
  ],
  'ci-required-check-on-a-pull-request': [
    ['pr-required', 'A pull request is required; there is no direct push to main', 'CLAUDE.md', 'that the ruleset rejects a direct push', 'platform-enforced', 'land', 'opens the PR', 'pushes the branch and opens the PR', 'platform-gate', 'none'],
    ['job-test', 'The required context is the job name `test`, not the workflow name', '.github/workflows/ci.yml', 'that the named job passed on the merge commit', 'platform-enforced', 'verify', 'none', 'waits for the job', 'platform-gate', 'none'],
    ['strict-up-to-date', 'The branch must be up to date with the base (strict policy)', 'CLAUDE.md', 'that the head is current with base at merge time', 'platform-enforced', 'land', 'merges once green', 'updates the branch', 'platform-gate', 'none'],
  ],
  'tag-triggered-publish': [
    ['tag-validation', 'The workflow rejects a missing, lightweight, mismatching or non-main tag before any gate runs', '.github/workflows/release.yml', 'tag object type, tag/version equality and main ancestry', 'platform-enforced', 'publish', 'none', 'none — the platform validates', 'platform-gate', 'none'],
    ['artifact-gates', 'Artifact integrity and tests run before publication', '.github/workflows/release.yml', 'that the packed artifact and the suite passed in CI', 'platform-enforced', 'verify', 'none', 'none — the workflow runs them', 'platform-gate', 'none'],
    ['reconcile', '`reconcileRelease` is idempotent: a re-run repairs a partial release', 'scripts/release-state.mjs', 'that npm version and GitHub release converge to the tagged version', 'mechanical', 'publish', 'none', 'none — the workflow reconciles', 'platform-gate', 'escalates-to:recovery-red-release-run-but-published'],
    ['manual-dispatch', 'Manual dispatch is recovery only and requires one explicit existing tag', '.github/workflows/release.yml', 'that a tag input was supplied and exists', 'platform-enforced', 'recover', 'triggers the dispatch deliberately', 'supplies the existing tag', 'human-gate', 'escalates-to:recovery-red-release-run-but-published'],
  ],
  'pages-site-publish': [
    ['build-pages', 'The methodology site publishes from main', '.github/workflows/pages.yml', 'that the workflow ran on a main push', 'platform-enforced', 'publish', 'none', 'none — the platform builds', 'platform-gate', 'none'],
    ['deploy', 'Deployment succeeds or retries within the workflow’s attempts', '.github/workflows/pages.yml', 'that the deploy step reported success', 'platform-enforced', 'publish', 'none', 'none', 'platform-gate', 'none'],
    ['content-source', 'The published content is the docs site, not the project layer', 'docs/index.html', 'that the deployed path set is the site directory', 'platform-enforced', 'publish', 'none', 'none', 'platform-gate', 'none'],
  ],
  'consumer-first-init': [
    ['install', '`init` installs the kit into the consumer repository', 'src/commands/init.mjs', 'that the declared bundle was copied', 'mechanical', 'intake', 'runs the installer', 'none — the consumer runs it', 'consumer-owned', 'none'],
    ['manifest', '`init` records a sha256 manifest of every installed file', 'src/lib/manifest.mjs', 'that a digest was recorded per installed file', 'mechanical', 'intake', 'none', 'none', 'consumer-owned', 'none'],
    ['project-layer-stubs', 'The project layer is written once and never overwritten by ordinary reconciliation', 'src/lib/bundle.mjs', 'that stub targets were written only when absent', 'mechanical', 'intake', 'none', 'none', 'consumer-owned', 'none'],
    ['first-orientation', 'README names the install command and the first steps', 'README.md', 'nothing mechanical — orientation is documentation', 'documented', 'intake', 'reads and decides what to do next', 'none', 'consumer-owned', 'none'],
  ],
  'consumer-setup-workflow-project-layer': [
    ['stub-fill', 'Run `setup-workflow` and fill only the missing stub', '.claude/skills/setup-workflow/SKILL.md', 'that the named stub file now has content', 'documented', 'intake', 'supplies the project facts', 'writes the project layer file', 'consumer-owned', 'none'],
    ['readiness', 'A skill reports missing project context rather than guessing', 'scripts/readiness.mjs', 'that every required capability resolves against the project layer', 'mechanical', 'verify', 'none', 'runs the readiness check', 'consumer-owned', 'none'],
    ['capability-declaration', 'Required and optional capabilities are declared in the manifest', '.claude/skills/skill-manifest.json', 'that each skill’s declared capabilities exist', 'mechanical', 'verify', 'none', 'reads the declarations', 'consumer-owned', 'none'],
  ],
  'consumer-first-own-workflow': [
    ['entry-choice', 'Unsure which skill fits? the router names a starting point', '.claude/skills/ask-matt/SKILL.md', 'that a starting skill was named', 'documented', 'intake', 'describes their own task', 'routes to a skill', 'consumer-owned', 'none'],
    ['first-slice', 'Prefer the smallest workflow that produces a clear next action', 'CLAUDE.md', 'nothing mechanical — the depth ladder is prose in the consumer’s own copy', 'documented', 'plan', 'chooses the depth', 'plans the first slice', 'consumer-owned', 'none'],
    ['first-land', 'Finished slice: wrapup prepares the branch, PR and cleanup the repo expects', '.claude/skills/wrapup/SKILL.md', 'that the consumer’s own repo conventions were read from their project layer', 'documented', 'land', 'merges their own PR', 'runs wrapup against the consumer profile', 'consumer-owned', 'none'],
    ['gap-visible', 'The consumer-as-actor journey is the one the seed list omits', '#380', 'that the journey exists in this derived set — the omission was the finding', 'documented', 'close', 'none', 'none', 'consumer-owned', 'none'],
  ],
  'consumer-update-over-local-edits': [
    ['three-way', '`update` is a three-way reconcile against the recorded manifest', 'src/lib/updateReconcile.mjs', 'that each file was compared against its recorded digest', 'mechanical', 'intake', 'runs the update', 'none', 'consumer-owned', 'none'],
    ['fast-forward', 'Untouched files fast-forward', 'src/lib/updateDecisions.mjs', 'that a file matching its recorded digest was replaced without asking', 'mechanical', 'build', 'none', 'none', 'consumer-owned', 'none'],
    ['never-silently-overwrite', 'Consumer-edited files are backed up and diffed, never silently overwritten', 'docs/adr/0001-consumer-divergence-policy.md', 'that a divergent file produced a backup and a diff', 'mechanical', 'build', 'decides per conflict', 'none', 'consumer-owned', 'escalates-to:recovery-update-conflicts-with-local-edits'],
    ['project-layer-untouched', 'The project layer is never overwritten by ordinary reconciliation', 'src/lib/ownershipClassifier.mjs', 'that project-layer paths were excluded from the ordinary write set', 'mechanical', 'build', 'none', 'none', 'consumer-owned', 'none'],
    ['transactional-activation', 'The update activates or rolls back as a whole', 'src/lib/verifyUpdateCandidateTransaction.mjs', 'that the candidate was verified before activation', 'mechanical', 'verify', 'none', 'none', 'consumer-owned', 'none'],
  ],
  'consumer-diff-inspection': [
    ['read-only', '`diff` reports what an update would change and writes nothing', 'src/commands/diff.mjs', 'that no write occurred during the inspection', 'mechanical', 'verify', 'runs the diff', 'none', 'consumer-owned', 'none'],
    ['per-file-origin', 'Divergence is reported per file against its recorded origin', 'src/lib/ownedDiff.mjs', 'that each file was classified kit-origin or consumer-owned', 'mechanical', 'verify', 'none', 'none', 'consumer-owned', 'none'],
    ['decision-input', 'The report is the input to the consumer’s update decision', '.claude/skills/kit-update/SKILL.md', 'nothing — reading it is the consumer’s choice', 'documented', 'verify', 'decides whether to update', 'none', 'consumer-owned', 'none'],
  ],
  'consumer-uninstall': [
    ['kit-origin-removal', '`uninstall` removes kit-origin files', 'src/commands/uninstall.mjs', 'that only files recorded in the manifest were removed', 'mechanical', 'close', 'runs the uninstall', 'none', 'consumer-owned', 'none'],
    ['consumer-files-kept', 'Consumer-owned files are kept', 'docs/adr/0003-kit-core-and-project-extension-lifecycle.md', 'that project-layer paths survived the removal', 'mechanical', 'close', 'none', 'none', 'consumer-owned', 'none'],
    ['manifest-teardown', 'The manifest is removed with the installation it describes', 'src/lib/manifest.mjs', 'that no orphaned manifest remains', 'mechanical', 'close', 'none', 'none', 'consumer-owned', 'none'],
  ],
  'consumer-routing-profile-decision': [
    ['questions', 'The routing profile is answered, not inferred', 'src/lib/routingProfile.mjs', 'that answers were supplied or the profile was declined', 'mechanical', 'intake', 'answers or declines', 'none', 'consumer-owned', 'none'],
    ['knowledge-vs-policy', 'Routing knowledge access and policy are separate', 'docs/adr/0006-routing-knowledge-access-and-policy-are-separate.md', 'that a policy decision never silently fetched knowledge', 'documented', 'plan', 'none', 'none', 'consumer-owned', 'none'],
    ['stored-profile', 'A stored profile decides model and effort where it exists', 'src/lib/routingProfileStorage.mjs', 'that a profile file was written or explicitly absent', 'mechanical', 'intake', 'none', 'none', 'consumer-owned', 'none'],
  ],
  'consumer-ownership-override': [
    ['own', 'A consumer can take ownership of an installed file', 'src/commands/own.mjs', 'that the recorded origin flipped', 'mechanical', 'build', 'takes or returns ownership', 'none', 'consumer-owned', 'none'],
    ['origin-effect', 'Ownership changes what update may do to the file', 'src/lib/ownershipClassifier.mjs', 'that the classifier reads the override', 'mechanical', 'build', 'none', 'none', 'consumer-owned', 'none'],
    ['divergence-policy', 'Divergence is a declared policy, not an accident', 'docs/adr/0001-consumer-divergence-policy.md', 'nothing mechanical — the policy is the record', 'documented', 'build', 'none', 'none', 'consumer-owned', 'none'],
  ],
  'consumer-contribution-bridge': [
    ['prepare', 'A local change can be prepared as a contribution back to the kit', 'src/lib/contributionBridge.mjs', 'that a contribution artifact was produced', 'mechanical', 'build', 'decides to contribute', 'none', 'consumer-owned', 'none'],
    ['routing', 'The contribution is routed to the right kit surface', 'src/lib/contributionRouting.mjs', 'that the target surface was resolved from the file origin', 'mechanical', 'build', 'none', 'none', 'consumer-owned', 'none'],
    ['handover', 'The kit repository still reviews it as an ordinary pull request', 'CLAUDE.md', 'nothing here — the review happens in the kit repo', 'documented', 'land', 'opens the PR upstream', 'none', 'consumer-owned', 'none'],
  ],
  'consumer-automated-update-pr': [
    ['branch-upsert', 'A stable Kit-verified branch is upserted rather than duplicated', 'scripts/kit-update-pr.mjs', 'that the same branch name is reused across runs', 'mechanical', 'build', 'none', 'runs the update-PR script', 'consumer-owned', 'none'],
    ['pr-upsert', 'The pull request is upserted, not stacked', 'scripts/kit-update-pr.mjs', 'that at most one open update PR exists', 'mechanical', 'land', 'none', 'upserts the PR', 'consumer-owned', 'none'],
    ['consumer-merges', 'The consumer decides whether to merge', 'docs/adr/0003-kit-core-and-project-extension-lifecycle.md', 'nothing mechanical — the merge is the consumer’s', 'documented', 'land', 'merges or closes', 'none', 'consumer-owned', 'none'],
  ],
  'consumer-kit-update-skill': [
    ['preview', 'Preview before applying; nothing is written during the preview', '.claude/skills/kit-update/SKILL.md', 'that the preview ran read-only', 'documented', 'verify', 'reads the preview', 'renders the preview', 'consumer-owned', 'none'],
    ['parity', 'The release is parity-verified before it is applied', 'scripts/release-parity.mjs', 'that npm, tag and release agree on the version', 'mechanical', 'verify', 'none', 'runs the parity check', 'consumer-owned', 'none'],
    ['transactional-apply', 'Apply transactionally; never auto-resolve conflicts', '.claude/skills/kit-update/SKILL.md', 'that the apply either completed or rolled back', 'mechanical', 'build', 'resolves conflicts themselves', 'applies the verified candidate', 'consumer-owned', 'escalates-to:recovery-update-conflicts-with-local-edits'],
  ],
  'consumer-project-release': [
    ['profile-scan', 'One coherent version change across the profiled packages', 'scripts/project-release.mjs', 'that the profiled package set was read from the consumer’s config', 'mechanical', 'plan', 'names the version', 'computes the change set', 'consumer-owned', 'none'],
    ['preview-only', 'No commits, tags, pushes, publishes or merges', 'src/lib/release-preview.mjs', 'that the run produced a preview and no git or registry write', 'mechanical', 'verify', 'none', 'renders the preview', 'consumer-owned', 'none'],
    ['no-duplicate-logic', 'The consumer’s release logic is not duplicated by the kit', '.claude/skills/project-release/SKILL.md', 'nothing mechanical — the boundary is a design rule', 'documented', 'plan', 'runs their own release', 'stops at the preview', 'consumer-owned', 'none'],
  ],
  'consumer-setup-pre-commit': [
    ['hooks-path', 'A native hook via `core.hooksPath`, no Husky and no Node dependency', '.claude/skills/setup-pre-commit/SKILL.md', 'that the git config points at the repository’s hook directory', 'mechanical', 'build', 'approves the hook', 'writes the hook and sets the config', 'consumer-owned', 'none'],
    ['project-checks', 'The hook runs the project’s own checks, not the kit’s', 'scripts/test_skill_precommit_template.py', 'that the template contains only project-declared commands', 'mechanical', 'build', 'names the checks', 'renders the template', 'consumer-owned', 'none'],
    ['never-bypass', 'Never bypass with `--no-verify`', 'CLAUDE.md', 'nothing mechanical — bypass is always available to the committer', 'documented', 'verify', 'chooses not to bypass', 'none', 'consumer-owned', 'none'],
  ],
  'consumer-census-establish': [
    ['scan', 'Scan facts in the current repository rather than asking', 'scripts/census/scan.mjs', 'that the scan produced counted facts', 'mechanical', 'intake', 'none', 'runs the scan', 'consumer-owned', 'none'],
    ['guide-ambiguous', 'Guide only ambiguous decisions', '.claude/skills/census-update/SKILL.md', 'that the questions asked were the unresolved ones', 'documented', 'plan', 'resolves the ambiguous cases', 'asks only where the scan is silent', 'consumer-owned', 'none'],
    ['transactional-activate', 'Activate a verified candidate transactionally', 'scripts/census/transaction.mjs', 'that activation was atomic and reversible', 'mechanical', 'verify', 'none', 'activates the candidate', 'consumer-owned', 'none'],
  ],
  'consumer-memory-lifecycle': [
    ['preview', 'Preview and apply without crossing configured roots', 'scripts/memory-lifecycle/index.mjs', 'that every target path stayed inside a configured root', 'mechanical', 'verify', 'none', 'previews the placement', 'consumer-owned', 'none'],
    ['evidence-preserved', 'Never overwrite active, archived or recovery evidence', '.claude/skills/memory-lifecycle/SKILL.md', 'that existing evidence files were preserved', 'mechanical', 'build', 'approves the recovery', 'applies the lifecycle step', 'consumer-owned', 'none'],
    ['placement', 'Memory is for durable gotchas; process lessons belong elsewhere', 'CLAUDE.md', 'nothing mechanical — placement is a rule the actor applies', 'documented', 'close', 'decides what to keep', 'reports the placement', 'consumer-owned', 'none'],
  ],
  'session-start-context-injection': [
    ['branch-context', 'The session opens with the branch and its issue context', '.claude/hooks/branch-context.py', 'that the hook produced output; not that the agent used it', 'mechanical', 'intake', 'none', 'reads the injected context', 'agent-autonomous', 'none'],
    ['board-status', 'Board status is synced into the session’s opening context', '.claude/hooks/sync-board-status.py', 'that the board was queried at session start', 'mechanical', 'intake', 'none', 'reads the status', 'agent-autonomous', 'escalates-to:recovery-board-status-drift'],
    ['drift-hints', 'Skill, convention and LoC drift surface as hints, not blocks', '.claude/hooks/convention-drift-hint.py', 'that the advisory was printed — nothing enforces reading it', 'mechanical', 'intake', 'none', 'reads the hints', 'agent-autonomous', 'none'],
  ],
  'guarded-tool-call-block': [
    ['secret-block', 'Secrets are never printed by a read tool', '.claude/hooks/block-secrets.py', 'that the matched command was blocked; coverage is the pattern set', 'mechanical', 'build', 'none', 'retries without the secret path', 'agent-autonomous', 'none'],
    ['worktree-enforcement', 'Writing work happens inside its own worktree', '.claude/hooks/enforce-worktree.py', 'that the cwd is inside the expected worktree', 'mechanical', 'build', 'none', 'moves into the worktree', 'agent-autonomous', 'escalates-to:recovery-wrong-branch-commit'],
    ['guard-core', 'Guard decisions come from one shared core, not per-hook logic', 'scripts/safety-guardrails/core.py', 'that the hooks share the same predicate implementation', 'mechanical', 'build', 'none', 'none', 'agent-autonomous', 'none'],
    ['named-recovery', 'A block names its recovery rather than only refusing', '.claude/hooks/drift-guard.py', 'that a message was emitted; whether it names a route is per-hook', 'documented', 'recover', 'none', 'follows the named recovery', 'agent-autonomous', 'escalates-to:recovery-guard-false-red-blocks-capability'],
  ],
  'prompt-and-stop-time-advisory': [
    ['prompt-time', 'Prompt-time advisories inform without blocking', '.claude/hooks/pre-refactor-sweep.py', 'that the advisory was printed', 'mechanical', 'intake', 'none', 'reads the advisory', 'agent-autonomous', 'none'],
    ['stop-time', 'Stop-time checks run after the turn, never in the way of it', '.claude/hooks/typecheck-on-stop.py', 'that the check ran at stop; its result is advisory', 'mechanical', 'close', 'none', 'reads the result', 'agent-autonomous', 'none'],
    ['advisory-core', 'Advisories are declared as capabilities, not hardcoded per project', 'scripts/workflow-advisories/capabilities.json', 'that the advisory set came from the declaration', 'mechanical', 'intake', 'none', 'none', 'agent-autonomous', 'none'],
  ],
  'worktree-create-and-bind': [
    ['pre-check', 'Check the branch carries no foreign open PR before creating the worktree', 'CLAUDE.md', 'nothing mechanical at creation time — the check is a rule', 'documented', 'plan', 'none', 'queries the open PRs for the branch', 'agent-autonomous', 'none'],
    ['create', 'A worktree isolates a build and belongs to the session that builds', 'scripts/worktree-lifecycle/setup.py', 'that the worktree and branch exist at the expected path', 'mechanical', 'plan', 'none', 'creates the worktree', 'agent-autonomous', 'none'],
    ['bind-cwd', 'Every file operation runs inside the worktree', '.claude/hooks/enforce-worktree-cwd.py', 'that the working directory is under the worktree root', 'mechanical', 'build', 'none', 'works from the worktree', 'agent-autonomous', 'escalates-to:recovery-wrong-branch-commit'],
    ['ignore-seed', 'Session-scratch artifacts stay gitignored inside the worktree', 'scripts/worktree-lifecycle/ignore_seed.py', 'that the ignore seed was written', 'mechanical', 'plan', 'none', 'seeds the ignore file', 'agent-autonomous', 'none'],
  ],
  'worktree-teardown': [
    ['classify', 'Teardown authority is stateless repository classification', 'docs/adr/0009-teardown-authority-is-stateless-repository-classification.md', 'that every path was classified before removal', 'mechanical', 'close', 'none', 'classifies the worktree contents', 'agent-autonomous', 'none'],
    ['no-loss', 'No tracked work is lost by teardown', 'scripts/worktree-lifecycle/cleanup.py', 'that unmerged or untracked work blocks removal', 'mechanical', 'close', 'confirms removal', 'runs teardown', 'human-gate', 'escalates-to:recovery-teardown-blocked-by-symlinks'],
    ['provenance-bound', 'Ownership is provenance-bound, not path-guessed', '#320', 'that removal only touched what this session created', 'mechanical', 'close', 'none', 'removes the owned worktree', 'agent-autonomous', 'none'],
  ],
  'recovery-red-release-run-but-published': [
    ['detect', 'A red release run does not prove nothing was published', '#205', 'that the run colour was not taken as the verdict', 'documented', 'recover', 'notices the red run', 'reads npm and the GitHub release', 'agent-autonomous', 'recovers:release-the-kit'],
    ['read-registry', '`release:status` reads the registry cache-bypassing', 'scripts/release-state.mjs', 'that a stale packument cannot report a live release as unpublished', 'mechanical', 'recover', 'none', 'runs the status read', 'agent-autonomous', 'recovers:release-the-kit'],
    ['reconcile', 'The reconciler is idempotent: a re-run repairs a partial release', '.github/workflows/release.yml', 'that npm and the release converge without a new version', 'mechanical', 'recover', 'triggers the recovery dispatch', 'runs the reconciler with the existing tag', 'human-gate', 'recovers:release-the-kit'],
    ['never-bump', 'Never recover by bumping the version', 'CLAUDE.md', 'nothing mechanical — the ban is a rule the actor keeps', 'documented', 'recover', 'refuses the bump', 'reports the reconciled state', 'human-gate', 'recovers:release-the-kit'],
  ],
  'recovery-awaiting-tag-stacked-bump': [
    ['guard-red', 'The guard blocks a bump while the base version carries no matching annotated tag', 'scripts/release-delta-guard.mjs', 'that the base version has a matching annotated tag', 'mechanical', 'recover', 'none', 'reads the guard failure', 'agent-autonomous', 'recovers:release-the-kit'],
    ['tag-pending-first', 'Tag and publish the pending version first', '#243', 'that the pending version reached published state before the new bump', 'documented', 'recover', 'confirms the pending Semver', 'tags the pending version', 'human-gate', 'recovers:release-the-kit'],
    ['first-release-exemption', 'Only a repository with no matching tag at all is exempt', 'scripts/release-delta-guard.mjs', 'that the exemption applies to a first release, not to a stack', 'mechanical', 'recover', 'none', 're-runs the guard', 'agent-autonomous', 'recovers:release-the-kit'],
  ],
  'recovery-wrong-branch-commit': [
    ['reflog-find', 'Uses `git reflog` to find the misplaced commit', '.claude/skills/git-worktree-recover/SKILL.md', 'that the commit object was located', 'mechanical', 'recover', 'reports the mix-up', 'reads the reflog', 'agent-autonomous', 'recovers:worktree-create-and-bind'],
    ['move', 'Moves the commit to the right branch with `git branch -f`', '.claude/skills/git-worktree-recover/SKILL.md', 'that the intended branch now contains the commit', 'mechanical', 'recover', 'approves the branch move', 'moves the branch pointer', 'human-gate', 'recovers:worktree-create-and-bind'],
    ['clean-worktree', 'Sets up a clean worktree for the continuation', 'scripts/worktree-lifecycle/setup.py', 'that the session continues inside the correct worktree', 'mechanical', 'recover', 'none', 'creates and enters the worktree', 'agent-autonomous', 'recovers:worktree-create-and-bind'],
  ],
  'recovery-interrupted-afk-run': [
    ['claim-state', 'A wave claim records who is orchestrating the wave', 'src/lib/waveClaim.mjs', 'that the claim record was read, including a stale one', 'mechanical', 'recover', 'none', 'reads the claim', 'agent-autonomous', 'recovers:goal-level-delegation-afk-sweep'],
    ['reconcile-slices', 'The anchor slice table is reconciled on every slice event', 'scripts/board-sync.py', 'that the anchor reflects what actually landed before the interruption', 'mechanical', 'recover', 'none', 'runs anchor-sync', 'agent-autonomous', 'recovers:goal-level-delegation-afk-sweep'],
    ['resume-or-release', 'The run resumes or the claim is released deliberately', '.claude/skills/orchestrate-wave/SKILL.md', 'nothing mechanical — resumption is the orchestrator’s decision', 'documented', 'recover', 'decides resume or stop', 'resumes or releases the claim', 'human-gate', 'recovers:goal-level-delegation-afk-sweep'],
  ],
  'recovery-update-conflicts-with-local-edits': [
    ['detect-divergence', 'A file whose digest no longer matches its manifest entry is consumer-edited', 'src/lib/updateDecisions.mjs', 'that divergence was detected by digest, not by guesswork', 'mechanical', 'recover', 'none', 'none — the consumer runs update', 'consumer-owned', 'recovers:consumer-update-over-local-edits'],
    ['backup-and-diff', 'Consumer-edited files are backed up and diffed, never silently overwritten', 'docs/adr/0001-consumer-divergence-policy.md', 'that a backup exists and a diff was produced', 'mechanical', 'recover', 'reads the diff', 'none', 'consumer-owned', 'recovers:consumer-update-over-local-edits'],
    ['consumer-decides', 'Conflicts are never auto-resolved', '.claude/skills/kit-update/SKILL.md', 'nothing mechanical beyond the refusal to auto-merge', 'documented', 'recover', 'resolves each conflict', 'none', 'consumer-owned', 'recovers:consumer-update-over-local-edits'],
  ],
  'recovery-guard-false-red-blocks-capability': [
    ['false-red', 'External errors are anomalies: my code is at fault until empirically refuted', 'CLAUDE.md', 'that the red was investigated instead of routed around', 'documented', 'recover', 'reports the blocked capability', 'investigates the guard predicate', 'agent-autonomous', 'recovers:delegate-build-to-codex'],
    ['locate-cause', 'The real cause is named before the guard is touched', 'docs/evidence/2026-07-28-codex-exec-version-pin.md', 'that a concrete cause was recorded with evidence', 'documented', 'recover', 'none', 'reproduces and records the cause', 'agent-autonomous', 'recovers:delegate-build-to-codex'],
    ['correct-predicate', 'Machinery that keeps a wrong input working conserves it — fix the predicate', 'scripts/codex-exec.sh', 'that the corrected guard still fails on the real fault', 'mechanical', 'recover', 'approves the guard change', 'corrects the predicate and re-runs', 'human-gate', 'recovers:delegate-build-to-codex'],
  ],
  'recovery-teardown-blocked-by-symlinks': [
    ['identity-freeze-fails', 'Teardown freezes worktree identity before removing anything', 'scripts/worktree-lifecycle/cleanup.py', 'that the freeze ran — a symlink-heavy tree can defeat it', 'mechanical', 'recover', 'none', 'reads the teardown failure', 'agent-autonomous', 'recovers:worktree-teardown'],
    ['named-record', 'The failure is recorded in the consumer repository, frozen here digest-only', '#2305', 'that the record exists and is citable without republishing a private body', 'documented', 'recover', 'none', 'cites the frozen digest', 'agent-autonomous', 'recovers:worktree-teardown'],
    ['fallback-route', 'A fallback route completes teardown with no protection of its own', 'docs/adr/0009-teardown-authority-is-stateless-repository-classification.md', 'that teardown completed — the fallback verifies nothing about ownership', 'documented', 'recover', 'accepts the fallback', 'completes teardown manually', 'human-gate', 'recovers:worktree-teardown'],
  ],
  'recovery-anchor-closed-early': [
    ['detect-early-close', 'Slice PRs carry `Part of #<anchor>`, never `closes`', 'scripts/pr-body-check.py', 'that the marker is the profile’s, catching the close-verb before merge', 'mechanical', 'recover', 'none', 'reads the check output', 'agent-autonomous', 'recovers:anchor-reconcile-on-slice-event'],
    ['reopen', 'The anchor is reopened rather than re-created', '#341', 'that the same issue number carries the remaining slices', 'documented', 'recover', 'approves reopening', 'reopens the anchor', 'human-gate', 'recovers:anchor-reconcile-on-slice-event'],
    ['reconcile-table', 'The anchor slice table is reconciled after reopening', 'scripts/anchor_table.py', 'that the table matches the board after recovery', 'mechanical', 'recover', 'none', 'runs anchor-sync', 'agent-autonomous', 'recovers:anchor-reconcile-on-slice-event'],
  ],
  'recovery-board-status-drift': [
    ['detect-drift', 'Board status is primary, so drift is a defect and not a cosmetic', 'docs/agents/board-sync.md', 'that the board response was compared against the repository state', 'mechanical', 'recover', 'none', 'reads board and repository state', 'agent-autonomous', 'recovers:slice-pr-landing'],
    ['dry-run-diff', '`--dry-run` first, review the diff, then write', 'CLAUDE.md', 'that the correction was previewed before it was applied', 'documented', 'recover', 'reviews the diff', 'runs anchor-sync --dry-run', 'human-gate', 'recovers:slice-pr-landing'],
    ['write-back', 'All board writes go through `scripts/board-sync.py`', 'scripts/board-sync.py', 'that the corrected Status came from the profile vocabulary', 'mechanical', 'recover', 'none', 'writes the corrected status', 'agent-autonomous', 'recovers:slice-pr-landing'],
  ],
};
