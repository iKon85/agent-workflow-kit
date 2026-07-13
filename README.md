# agent-workflow-kit

**A complete shipping loop for coding agents — plan → execute → land → learn.**

## Maintainer build

The public repository is the source of truth. A fresh clone needs Node 20 or
newer, Python 3, and no Python packages:

```sh
npm install --ignore-scripts
npm test
npm run kit:build
npm run kit:staleness
npm pack --dry-run
```

`kit:build` assembles `dist-kit/` only from files in this checkout and writes a
sha256 manifest. `kit:staleness` compares that fresh manifest with the checked-in
install manifest. The frozen `v0.9.0` manifest remains under `test/fixtures/` as
the historical golden baseline; current builds intentionally include later SSOT
changes.

Maintainers prepare releases with `/kit-release`. It derives the shipped delta
from a fresh manifest, recommends Semver, applies only the confirmed target,
regenerates the checked-in manifest, and runs the full test and pack gates.
Landing remains owned by `/wrapup`; publishing the matching npm package and
GitHub release happens only through the configured post-merge release flow.

These are the skills, helper scripts, and conventions one team actually uses to
take work from a vague idea to a merged, verified PR with [Claude Code] and
[Codex]. One `npx` command drops them into any repo; `/setup-workflow` wires
them to your tracker and board. Edit anything — updates never clobber your changes.

[Claude Code]: https://claude.com/claude-code
[Codex]: https://developers.openai.com/codex/cli

## Quickstart

```sh
# from the root of the repo you want to add the workflow to
npx github:iKon85/agent-workflow-kit init
```

1. **`init`** copies the skills + helper scripts in, and seeds empty
   project-layer stubs. It never overwrites a file you already have.
2. **Run `/setup-workflow`** once (in Claude Code / Codex). A guided, idempotent
   skill that detects your issue tracker, writes your label + domain + deploy
   config, and — for a GitHub Projects board — discovers the field IDs into a
   board profile. See [Configuration](#configuration).
3. **Start working.** Trigger skills by name (`/grill-with-docs`, `/tdd`,
   `/wrapup`, …) — the workflow below explains when each one earns its keep.
   Unsure which one fits? Run **`/ask-matt`** — it routes you to the right skill.

## The workflow it installs

The skills aren't a grab-bag — they're four phases of one loop, entered through a
single funnel no matter where your work starts. Each phase below names the failure
mode it removes and the skills that remove it.

![The workflow loop: idea / plan / backlog / raw-issue all funnel through an optional grill into one uniform PRD, which to-issues decomposes into an atomic issue or a wave anchor; a gate clears any unknown, then Execute → Land → Learn, which compounds back into the next idea. Two further streams enter outside the funnel — a bug/anomaly through diagnose, and a code-fighting-the-structure change through zoom-out — both joining at Execute; a one-time repo-setup lane (setup-workflow, git-guardrails, setup-pre-commit) sits off the loop and installs the pre-commit/pre-push gate that Land relies on.](docs/workflow.png)

<!--
  The image above is a pre-rendered PNG, not a live Mermaid block, on purpose:
  GitHub's Mermaid renderer clips long node labels, and an <img>-embedded SVG
  can't render Mermaid's foreignObject node text (shows blank). A rasterised PNG
  renders identically everywhere.
  Source of truth: tools/agent-workflow-kit/assets/workflow.mmd
  Regenerate after editing the source:
    npx -y @mermaid-js/mermaid-cli \
      -i tools/agent-workflow-kit/assets/workflow.mmd \
      -o tools/agent-workflow-kit/assets/workflow.png \
      -t dark -b '#0d1117' -s 3
  build-kit.mjs copies assets/workflow.png -> dist-kit/docs/workflow.png.
-->


### 1. Plan — turn a vague idea into shaped, tracked work

> *Agents dive into code before the problem is sharp, then build the wrong thing
> well.* The plan phase makes you earn a clear spec first.

**One funnel, many doors, one shape.** There's no single front door. You enter
wherever your work actually starts — a vague idea, a plan you already wrote, a PRD
pasted from another tool, a raw issue, or a whole backlog — and every door funnels
into the *same shaped artefact*: a Draft-PRD that, once sliced, becomes either one
atomic issue or a wave anchor with child slices. What counts downstream is the
**shape of the artefact, never where it came from** — so each step can be entered
cold and *extracts or synthesizes* what's missing instead of assuming an earlier
step ran. The routing key is just *"is there an issue yet?"*: a loose artefact
(no issue) enters at `to-prd`; an existing issue or file-bundle enters at
`to-issues` directly.

- **Grill as deep as the work deserves — it's optional.** `grill-me` /
  `grill-with-docs` interrogate the intent (and your domain docs) until the real
  requirement surfaces, instead of latching onto the first framing. Skip it for a
  mechanical change, run a light grill for a normal feature, add `+codex` (below)
  for something high-stakes. Your call, per piece of work.
- **`to-prd`** turns whatever you bring — idea, plan, external spec — into a short
  Draft-PRD issue, *extracting* the template sections from what already exists. A
  required section it genuinely can't derive becomes an honest **Open points**
  block, never a silent "looks complete" placeholder.
- **`to-issues`** slices the PRD into tracer-bullet verticals and picks the shape:
  **1 slice → one atomic issue** the PR closes; **≥2 slices → a wave anchor** with
  linked child slices. It re-derives readiness from the artefact itself, so it works
  just as well started straight on a raw issue or file-bundle — any unresolved
  *Open points* travel through as a build-blocking gate (the profile's
  configurable `vorBau` heading, see [Configuration](#configuration)) that never
  vanishes silently.
- **`board-to-waves`** clusters an existing backlog into themed campaigns when you
  need to *find* the next wave rather than start fresh.
- **`triage`** keeps the inbox sane with a consistent label vocabulary.
- **`spec-self-critique`** red-teams your own spec before you commit to building it.
- **`verify-spike` / `decision-gate` — gate-before-build.** When `to-issues` cuts a
  slice that hinges on an unknown it tags the slice instead of guessing: a single
  yes/no fact against the real lib/runtime/DB runs as a **`verify-spike`** (throwaway
  read-only harness, verdict + proof sunk to the issue); a bounded "which option"
  trade-off or a research gap runs as a **`decision-gate`** (read-only weigh-up,
  options × criteria table, reasoned pick sunk to an ADR/issue). The gate is its own
  slice, sequenced *before* the build slice it blocks — clarify the one open point
  cheaply instead of re-grilling the whole feature; genuinely hard-to-reverse calls
  still escalate up to `+codex`.
- **`domain-modeling` / `codebase-design` — shared design vocabulary.** When a slice
  is about *shaping* rather than shipping — pinning down the ubiquitous language and
  ADRs (`domain-modeling`) or designing a deep module behind a clean seam
  (`codebase-design`) — these give the grill and the design work a precise, consistent
  vocabulary instead of ad-hoc terms.
- **`wayfinder` — when the idea is too big for one session.** Charts a foggy,
  multi-session effort as a shared **map** issue with investigation tickets on
  your tracker (native blocking renders the frontier visually), resolved one
  per session until the way to the destination is clear — planning, not doing.
- **`research`** delegates primary-source reading legwork to a background
  agent; the findings land as a cited Markdown note in the repo.

You approve the slice breakdown before anything is published — the funnel never
publishes behind your back.

### 2. Execute — build it right, not just fast

> *"Make the tests pass" drifts into untested, sprawling, hard-to-review change.*
> The execute phase keeps the diff disciplined.

- **`tdd`** — a strict red → green → refactor loop; the test is written first
  and must fail for the right reason.
- **`prototype`** — spike a throwaway when the path is genuinely unclear, so the
  real implementation is informed.
- **`implement`** — drive a PRD or a set of issues to done: `tdd` at the agreed
  seams, typecheck + single-file tests throughout, the full suite once at the end,
  then a `code-review` pass before it lands.

**Two more skills are doors of their own, not funnel steps.** You reach for them
when the work *starts* broken or tangled rather than from a fresh idea, so they
enter outside the plan funnel and feed straight into Execute:

- **`diagnose`** — a disciplined root-cause hunt for bugs (reproduce → isolate →
  fix → prove), not a guess-and-patch. Entered from a bug or anomaly, never the PRD
  funnel; the fix it lands flows on into Execute.
- **`zoom-out` / `improve-codebase-architecture`** — step back from the diff to
  the structure when a change is fighting the codebase. A recon stream that either
  becomes a planned slice (back through `to-issues`) or guides a refactor in place.

### 3. Land — ship without surprises

> *The risky part is the merge: half-checked PRs, broken hooks, context lost at
> handoff.* The land phase puts mechanical gates in front of the commit.

- **`wrapup`** — the land-and-clean closeout: make the branch landable, enforce
  the PR body contract, merge the PR, reconcile the board, sweep merged branches,
  and surface anything still open. It does not replace live verification; verify
  the user outcome before landing.
- **The pre-commit / pre-push gate fires automatically** — TypeScript, lint, and
  contract guards block a broken commit or push. You don't run a skill here; the
  gate was installed once at setup (`git-guardrails` / `setup-pre-commit`, both
  Claude only, see Configuration) and now guards every Land.
- **`resolving-merge-conflicts`** — a disciplined loop for an in-progress
  merge/rebase conflict: understand each side's intent from history/PRs, preserve
  both where possible, always resolve (never `--abort`), then re-run the checks.
- **Helper scripts** — `pr-body-check.py`, `execute-ready-check.py`, and
  `board-sync.py` keep the PR and the issue tracker honest (see Configuration).

### 4. Learn — compound the lessons instead of repeating them

> *The same mistake recurs because nothing captured it.* The learn phase turns
> friction into config.

- **`retro`** — an in-session post-mortem that proposes concrete changes to your
  rules, skills, or hooks, each with per-patch approval.
- **`write-a-skill`** (Claude only) — turn a move you keep repeating into a
  reusable skill.

### Optional: cross-model review (via Codex)

An independent second model is a cheap way to catch what one model rationalizes.
**`grill-me-codex` / `grill-with-docs-codex`** run the grill through Codex,
**`codex-review`** gets a second-opinion plan review, and **`codex-build`**
flips the roles for an optional Act 3 (Codex implements the frozen spec in a
bounded workspace-write sandbox, Claude verifies the diff and proof). All four
are Claude only (invoked from Claude Code, which shells out to the Codex CLI)
and need the Codex CLI installed.

### The altitude model

The four phases above are what you *do*. Underneath them sits a shape for
*what you're doing it to* — a plan travels through four altitudes, and each
hands a well-defined object to the level below:

| Altitude | What it is | Artefact |
|---|---|---|
| **Program** | The whole undertaking, described once with a wave plan attached. | one PRD issue |
| **Phase** | An acceptance bracket around a handful of waves. Optional. | a board field |
| **Wave** | The working unit: one outcome, a few slices, one gate — exactly the wave you already build with the flow above. | one anchor issue |
| **Slice** | One build session, one pull request, one visible result. | one sub-issue |

Two roads lead to the same wave. **Top-down:** `scale-check` names the size in
a few plain questions; a big undertaking gets grilled once into a Program PRD
with a wave plan, and `to-waves` unfolds it into named waves after you approve
a full preview in chat — zero board writes until you say yes. **Bottom-up:**
`board-to-waves` clusters loose issues into a wave candidate, which earns a
real number only when you promote it. Either road lands in the *identical*
wave anchor plus slice sub-issues, built through the same `tdd` → `wrapup` →
`retro` spine as every other wave.

When the slices are file-disjoint and their specs are locked, **`orchestrate-wave`**
lands the whole anchor end-to-end — often AFK: it dispatches an implementer per
slice into its own worktree, integrates serially, verifies centrally, and lands
the wave. It's the execute-and-land node of the wave ladder (`scale-check` →
`to-waves` / `board-to-waves` → `orchestrate-wave`); a single slice still just
goes to `tdd`.

![The Program-to-Phase-to-Wave-to-Slice altitude ladder, and the two routes — a planned top-down Program route and a grown bottom-up board route — that both fund the same Wave-and-Slices build spine.](docs/methodology.svg)

The full walkthrough — every entry point, the build-layer skills, and the six
mechanics that keep a multi-wave plan honest (gates, drift propagation, the
revision loop, `program-sync`, and counted completeness) — lives on one page:
**[read the methodology →](https://ikon85.github.io/agent-workflow-kit/methodology.html)**
(also shipped as `docs/methodology.html` in your install, so it works offline too).

## Configuration

The skills ship the *how*; your repo supplies the *what*. `init` only lays down
empty stubs — **`/setup-workflow` fills them**. It's a guided, idempotent skill
(not a script): it explores your repo, confirms with you section by section, and
writes:

| It writes | So that |
|---|---|
| `docs/agents/issue-tracker.md` | `to-issues` / `triage` know whether to call `gh`, `glab`, or follow your flow |
| `docs/agents/triage-labels.md` | triage uses *your* label vocabulary |
| `docs/agents/domain.md` | the domain skills find your `CONTEXT.md` / ADR layout |
| `docs/agents/board-sync.md` | the board scripts get your GitHub Projects field IDs (the **board profile**) |
| `## Agent skills` + `## Prod` in `CLAUDE.md` / `AGENTS.md` | the agent knows your skills and deploy target |

Each generated file carries a `setup-workflow` sentinel on its first line, so a
re-run only fills what's missing and **never overwrites content you've filled in**.

Two more one-time skills harden the repo when you adopt the kit — both **Claude
only**: **`git-guardrails`** installs the secret / branch / broken-build
guardrails, and **`setup-pre-commit`** wires the pre-commit gate. Run them once
— afterwards the gate fires automatically on every commit and push (see the
Land phase above).

### The board profile

The board helper scripts carry **no hard-coded IDs**. They read everything
board-specific from a single fenced `json` block in `docs/agents/board-sync.md`,
marked `<!-- board-sync:profile -->`:

```json
{
  "repo": "<owner>/<repo>",
  "project": { "number": 1, "owner": "<owner>", "nodeId": "<project-node-id>" },
  "fields": {
    "status": {
      "id": "<status-field-id>",
      "options": { "Spec": "<option-id>", "In Progress": "<option-id>", "Done": "<option-id>" },
      "roles": { "spec": "Spec", "inProgress": "In Progress", "done": "Done" }
    },
    "wave": "<wave-field-id>",
    "cluster": "<cluster-field-id>",
    "specPath": "<field-id>",
    "planPath": "<field-id>"
  },
  "labels": {
    "readyForAgent": "ready-for-agent",
    "typePrefix": "type:",
    "clusterType": "type:cluster",
    "waveStub": "wave-stub"
  },
  "branchPrefixes": ["feat", "fix", "chore", "docs"],
  "prMarkers": { "partOf": "Part of", "retroMarker": "**Retro:**", "retroValues": ["ran", "skipped"] },
  "headings": { "vorBau": "Clarify Before Build" }
}
```

`/setup-workflow` discovers these values for you from `gh project field-list`;
you rarely touch this by hand. Point a script at an alternate profile with the
`BOARD_SYNC_PROFILE` environment variable. Labels, branch prefixes, and headings
are *yours* to rename — the scripts read whatever the profile says.

Status stage names are yours too: scripts and skills address stages by semantic
**role** (`fields.status.roles`: `idea/triaged/spec/inProgress/review/done` →
your option names, e.g. `board-sync.py add --status-role spec`), so a board in
any language works — map each role once, rename an option with one profile edit.

### What's yours vs. the kit's

`init` records a sha256 of every file it installs. That's the line between the
two: **edit any skill or script freely** — `update` detects your edits and backs
them up rather than clobbering them. Your **project layer** (`docs/agents/*`, the
board profile, `CLAUDE.md`) is created once and never touched by `update`.

## Updating & removing

```sh
npx github:iKon85/agent-workflow-kit diff        # preview an update (dry run, writes nothing)
npx github:iKon85/agent-workflow-kit update      # apply it
npx github:iKon85/agent-workflow-kit uninstall   # remove kit-installed files
```

`update` is a three-way reconcile against the hashes `init` recorded:

- a file you **didn't** touch fast-forwards to the new version;
- a file you **did** edit is kept — the incoming version is backed up with a
  timestamp and a diff is printed, never silently overwritten;
- a file removed upstream is offered for deletion (a hook still referenced by your
  `settings.json` is kept regardless);
- new skills are added.

`uninstall` removes what the kit installed and retains anything you edited or
still reference. Flags: `--force` (overwrite pre-existing files on `init`),
`--yes` / `-y` (non-interactive).

## Release notes

### 0.10.0

- added: `.agents/skills/kit-release/SKILL.md`
- added: `.claude/skills/kit-release/SKILL.md`
- added: `scripts/kit-release.mjs`
- added: `scripts/release-delta-guard.mjs`
- changed: `.agents/skills/setup-workflow/workflow-overview.md`
- changed: `.claude/skills/setup-workflow/workflow-overview.md`

### 0.9.0

- Re-syncs the vendored Chase AI `-codex` skills to upstream HEAD (fe37a70):
  every `codex exec`/`resume` round now echoes the active model before Round 1
  and runs under a 10-minute overall ceiling in addition to the existing 90s
  liveness probe.
- New vendored skill: **`codex-build`** (optional Act 3 — Codex implements a
  frozen spec, Claude verifies the diff and proof). Locally adapted: upstream's
  `--yolo` full-access sandbox is replaced by a bounded workspace-write sandbox
  with a declared allowed-write set enforced after every round.
- Aligns Act 1 of `grill-me-codex` / `grill-with-docs-codex` with the v1.1.0
  grill skills (facts-vs-decisions rule + confirmation gate).
- Bumps the kit metadata to `0.9.0`. After this PR is merged, publish the
  matching GitHub release/tag as a separate release step.

### 0.8.0

- Re-syncs the vendored Matt Pocock skills to upstream **v1.1.0** (fork-and-own:
  selective merge; local folder names kept for the upstream-renamed skills —
  `to-prd` = upstream `to-spec`, `to-issues` = upstream `to-tickets`).
- Two new vendored skills: **`wayfinder`** (chart a huge, foggy effort as a
  shared map of investigation tickets on your tracker, resolved one per session)
  and **`research`** (delegate primary-source reading to a background agent;
  findings land as a cited Markdown note in the repo).
- Backports the upstream wins: the negation failure mode in `write-a-skill`,
  the facts-vs-decisions rule + confirmation gate in `grill-me` /
  `grill-with-docs`, and a wide-refactor (expand–contract) section in
  `to-issues`.
- `setup-workflow`'s issue-tracker templates gain **Wayfinding operations**
  sections (map/ticket/blocking/frontier per tracker) that `wayfinder` consults.
- Bumps the kit metadata to `0.8.0`. After this PR is merged, publish the
  matching GitHub release/tag as a separate release step.

### 0.7.0

- Rounds out the execute/land/learn line with five new skills —
  `orchestrate-wave` (AFK wave landing), `local-ci` (pre-PR local gate),
  `git-worktree-recover`, `audit-skills` (anti-drift learn step), and
  `security-audit` (two-model audit + runbook template) — plus the
  `skill-drift-hint.py` SessionStart hook.
- English-normalizes the wave-anchor template and hardens
  `execute-ready-check.py` heading detection. (Full notes: GitHub release v0.7.0.)

### 0.6.2

- Profile-driven board-status **roles**: `fields.status.roles` maps semantic
  stages to your board's own option names (any language); `board-sync.py`
  gains `--status-role`; the status field is matched by ID.
  (Full notes: GitHub release v0.6.2.)

### 0.6.1

- Routing-doctrine sync for the published skills (`wrapup`,
  `codex-adapter-sync`, wave-anchor model placeholders) — mechanical plumbing
  routes to the cheap tier, judgment stays on the main thread.
  (Full notes: GitHub release v0.6.1.)

### 0.6.0

- Adds the **Program route**, a top-down altitude above the existing feature
  funnel for greenfield / multi-wave work: `scale-check` (a plain-language
  router — 3–6 questions to a Program / Feature / Direct-Slice / Bug verdict)
  and `to-waves` (unfolds a Program-PRD's Wellenplan into named wave stubs +
  slice leaves after a chat preview gate — graph-validated, counted, batch-
  stamped Wave/Phase fields, idempotent/crash-recoverable re-run, and an adopt
  path for issues a prior bottom-up grooming pass already created).
- Ships `board-sync.py validate-graph`, a pure, zero-write Program-Graph
  preflight (cycles, cross-wave backward refs, gate-slice structural-suspicion
  warnings, capacity, phase-option, and revision-coherence checks, plus two
  counted completeness axes — scope coverage and the rollup chain) and
  `program-sync`, which regenerates a Program-PRD's Wellenplan status column
  from the board (its own grammar, alongside the existing `anchor-sync`).
- Adds `stamp-batch` (alias-batched GraphQL field writes for N items' Wave/
  Phase fields in one request, chunked, with a per-alias failure report and a
  repair command), `field-value` (reads a project field's current value —
  the `promote` mismatch-guard's read side), and a Program-PRD refusal on
  `promote` (a Program-PRD is never a promotion target).
- `execute-ready-check.py` now classifies by an explicit node kind (program /
  wave-stub / anchor / leaf) instead of a single children+parent heuristic, so
  a Wave-Anchor parented by a Program-PRD is no longer misjudged.
- `to-prd`, `to-issues`, and `board-to-waves` gain the matching Program-route
  deltas: a third `mode=program` PRD shape, a `wave-stub`-label discriminator
  so a not-yet-promoted wave stub is a valid Hard-Stop exception, and a
  `board-to-waves` splitter that escalates an oversized candidate to the
  Program route instead of spraying it into feature-sized stubs.
- Adds the optional `fields.phase` / `labels.programType` board-profile keys
  (`fields.phase` mirrors `fields.status`'s `{id, options}` shape; a profile
  without either key keeps loading unchanged) and documents the Phase-field
  creation command plus two saved Views (`Program`, `Active Wave`) as one-time
  manual setup steps `/setup-workflow` cannot provision by itself.
- Ships the kit's methodology documentation: a self-contained
  `docs/methodology.html` walkthrough of the full altitude model (Program →
  Phase → Wave → Slice) and both routes, plus a README methodology chapter
  with a hand-designed static SVG diagram.
- Bumps the kit metadata to `0.6.0`. After this PR is merged, publish the
  matching GitHub release/tag as a separate release step.

### 0.5.0

- Normalizes every published skill body to English across Claude and Codex
  surfaces, while keeping only audited contract literals and quoted user-input
  examples in their original language.
- Adds a mechanical language census for the maintainer source repo, proving
  **30 of 30** `publish:true` skills scan clean and documenting the small
  allowlist for deliberate literals.
- Switches `setup-workflow`'s fresh-install defaults and the README board-profile
  example to English (`Clarify Before Build`, `ran` / `skipped`) without
  rewriting a consumer's already-filled project profile.
- Hardens skill frontmatter and descriptions: NOT clauses stay inside the
  rendered description budget, plain YAML ` #` truncation is guarded, and the
  `board-to-waves` / `to-prd` descriptions are fully parseable.
- Carries the post-audit authoring fixes that affect shipped skills, including a
  portable `retro` memory path, clearer `verify-spike` / `decision-gate`
  fallback rules, and tighter `widget-conventions` / `spec-self-critique`
  boundaries.
- Bumps the kit metadata to `0.5.0`. After this PR is merged, publish the
  matching GitHub release/tag as a separate release step.

### 0.4.0

- Adds the model-invoked `code-review` skill (two-axis Standards×Spec review,
  Fowler smell baseline, merge-base preflight) on both surfaces; the `ask-matt`
  router and `implement` now point at real published ware.
- Codex-surface skills no longer escalate to Claude-only `-codex` targets, and
  the router marks Claude-only skills explicitly, so a Codex consumer is never
  routed to an unreachable skill.
- New guards: same-surface skill-reference existence, project-private mirror
  structure-parity, a hardcoded-profile-value scan, and a build-staging vs
  published-repo staleness check (`kit:staleness`).
- Hardened scripts: `board-sync.py` create surfaces the issue number + a repair
  command on partial failure; `anchor-sync` fails loud on a header mismatch
  instead of duplicating rows; the CLI writes its manifest atomically.
- Profile-driven prose: PR/issue markers and template headings reference the
  board-profile keys instead of hardcoded literals, so a consumer's renamed
  values pass their own checks; the seed and this README's profile example match.
- Onboarding: the seeded workflow overview lists every entry point including the
  `ask-matt` router and the gate skills; Claude-only skills and hooks are marked.
- Bumps the kit metadata to `0.4.0`. After this PR is merged, publish the
  matching GitHub release/tag as a separate release step.

### 0.3.5

- Adds the `to-issues` member-reconcile rule for promoting `board-to-waves`
  stubs that already carry native Member sub-issues, so old members are reused
  or explicitly unlinked/closed instead of creating duplicate slice children.
- Ships `board-sync.py unlink`, a parent-checked and idempotent helper for
  removing superseded sub-issue links without touching foreign parents.
- Tightens promoted-anchor labels by stripping `ready-for-agent` alongside
  `wave-stub`, so an Anker is not accidentally treated as a buildable leaf.
- Bumps the kit metadata to `0.3.5`. After this PR is merged, publish the
  matching GitHub release/tag as a separate release step.

### 0.3.4

- Ships `board-sync.py anchor-sync` plus the `anchor_table.py` helper, so wave
  anchors can regenerate Slices-table Status/Branch cells from the board instead
  of relying on hand-ticked rows.
- Updates `wrapup` and the wave-anchor template to use the new anchor-sync flow,
  including dry-run review, stable plan-column preservation, and appended rows for
  mid-wave split sub-issues.
- Extends `setup-workflow` to seed a generic `## Workflow` overview in
  `CLAUDE.md` / `AGENTS.md` when the consumer repo does not already have one.
- Tightens planning guidance: grill skills now point to a code-derived impact
  census when a project provides one, and `retro` uses agent-neutral wording for
  Claude/Codex surfaces while raising the memory-sweep trigger to 65 active files.
- Bumps the kit metadata to `0.3.4`. After this PR is merged, publish the
  matching GitHub release/tag as a separate release step.

### 0.3.3

- Adds a counted-completeness planning guard to `grill-me`,
  `grill-with-docs`, and their Codex review variants. Cross-cutting changes now
  get classified before plan lock as either a grep-able pattern rollout or a
  concept rollout that needs a code-derived surface matrix.
- Makes "complete everywhere" claims evidence-based: plans should carry a fresh
  census, guard test, or `X of Y` surface count instead of relying on memory.
  This is aimed at avoiding partial migrations that only look complete from the
  happy-path slice.
- Bumps the kit metadata to `0.3.3`. After this PR is merged, publish the
  matching GitHub release/tag as a separate release step.

### 0.3.2

- Publishes the latest workflow guidance for `retro`, `to-issues`, and
  `grill-with-docs-codex`: generalize retro patches to the underlying class,
  prove absence-before-build before cutting new build slices, require gate
  discipline, and track deferred phases in multi-phase plans.
- Quotes YAML-sensitive Codex skill descriptions so Codex frontmatter validation
  accepts descriptions with commas, colons, arrows, and quoted trigger phrases.
- Bumps the kit metadata to `0.3.2`. After this PR is merged, publish the
  matching GitHub release/tag as a separate release step.

### 0.3.1

- Uses run-scoped Codex temp output paths for cross-model review skills, so
  parallel grill/review sessions do not collide on shared `/tmp` files.
- Raises the `retro` memory-sweep trigger to 60 active files to avoid false
  positives on healthy, content-checked memory sets.
- Bumps the kit metadata to `0.3.1`. After this PR is merged, publish the
  matching GitHub release/tag as a separate release step.

## What's in the box

**41 skills** (Router: ask-matt — "which skill/flow fits?" · Plan: grill-me,
grill-with-docs, to-prd, to-issues, board-to-waves, triage, spec-self-critique,
verify-spike, decision-gate, scale-check, to-waves, wayfinder, research · Execute: tdd, prototype, implement, orchestrate-wave ·
Design/diagnose/refactor streams: diagnose, zoom-out,
improve-codebase-architecture, codebase-design, domain-modeling, security-audit · Land: wrapup,
resolving-merge-conflicts, code-review, local-ci, git-worktree-recover, kit-release · Learn: retro, audit-skills, write-a-skill · Setup:
setup-workflow, git-guardrails, setup-pre-commit · Codex cross-model: grill-me-codex,
grill-with-docs-codex, codex-review, codex-build),
installed for both surfaces — `.claude/skills`
(Claude Code) and `.agents/skills` (Codex) — plus `codex-adapter-sync`
(Codex-only: keeps the `.agents/skills` mirror in sync with the `.claude/skills`
source for dual-surface repos). **Claude only** (no `.agents/skills` mirror —
skip these on a Codex-first repo): `write-a-skill`, `git-guardrails-claude-code`,
`setup-pre-commit`, `grill-me-codex`, `grill-with-docs-codex`, `codex-review`,
`codex-build`.

**Helper scripts** — `board_config.py` (profile loader), `board-sync.py`,
`execute-ready-check.py`, `pr-body-check.py`, the handoff drift-guard, the
skill-drift-hint and board-status hooks (Claude only — wired via
`.claude/settings.json`, no Codex mirror), the opt-in LoC-offender gate, and the
wave-anchor + security-audit-runbook templates.

This kit deliberately ships without a test suite (a leaner `npx` payload) — the
scripts and skills are tested in the maintainer's private source repo they're
generated from. Customizing a guard? Add your own tests against the copy in
your repo.

## Requirements

- **Node ≥ 20** to run the installer.
- **Claude Code** or **Codex** to run the skills.
- **GitHub `gh` CLI** for the board scripts (optional — skip if you don't use a
  GitHub Projects board).
- **Codex CLI** for the `-codex` review skills (optional).

## Credits

- Many skills are adapted from **Matt Pocock's skills**
  (https://github.com/mattpocock/skills), MIT — each carries a
  `THIRD-PARTY-NOTICES.md` with its upstream path.
- The `grill-*-codex` / `codex-review` / `codex-build` cross-model skills are by
  **Chase AI** (https://github.com/chaseai-yt/grill-me-codex), MIT.
- `retro`, `wrapup`, `spec-self-critique`, `board-to-waves`, `verify-spike`,
  `decision-gate`, `codex-adapter-sync`, `code-review`, `orchestrate-wave` are original work.

Full origin + license of every skill is in [PROVENANCE.md](PROVENANCE.md).

## License

MIT — see [LICENSE](LICENSE).

## A note on language

Every published skill's prose is English — a mechanical
census (`scripts/test_skill_language_census.py`) proves it: all publish:true
skills scan clean, with an explicit, auditable allowlist for the handful of
deliberate exceptions — quoted user-input trigger phrases, a bilingual PRD
example block, and a few cross-skill contract literals (board status values,
heading names) that other skills or the board tooling consume verbatim.

These conventions grew up in a German-speaking project, so the mechanics
still default to a project-adoptable language stance: seed defaults (e.g.
`setup-workflow`'s scaffolded convention files) are English, and a project
layer or filled-in convention file may be in whatever language that
project's team works in — the skills themselves don't hardcode a language,
they read from the project layer. Project-private skills (not shipped in
this kit) may stay in their home project's language; that's out of scope
for the kit's own English-first bar.

New publish-candidate skills are English-first: write new skill prose in
English from the start (see `write-a-skill`), even if the authoring
project's own working language is something else — matching the state this
census now proves for every existing published skill.
