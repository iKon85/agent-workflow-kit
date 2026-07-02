# agent-workflow-kit

**A complete shipping loop for coding agents — plan → execute → land → learn.**

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
  *Open points* travel through as a "clarify before building" gate that never
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
  gate was installed once at setup (`git-guardrails` / `setup-pre-commit`, see
  Configuration) and now guards every Land.
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
- **`write-a-skill`** — turn a move you keep repeating into a reusable skill.

### Optional: cross-model review (via Codex)

An independent second model is a cheap way to catch what one model rationalizes.
**`grill-me-codex` / `grill-with-docs-codex`** run the grill through Codex, and
**`codex-review`** gets a second-opinion code review. These need the Codex CLI.

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

Two more one-time skills harden the repo when you adopt the kit:
**`git-guardrails`** installs the secret / branch / broken-build guardrails, and
**`setup-pre-commit`** wires the pre-commit gate. Run them once — afterwards the
gate fires automatically on every commit and push (see the Land phase above).

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
      "options": { "Spec": "<option-id>", "In Progress": "<option-id>", "Done": "<option-id>" }
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
  "prMarkers": { "partOf": "Part of", "retroMarker": "**Retro:**", "retroValues": ["done", "skipped"] },
  "headings": { "vorBau": "To clarify before building" }
}
```

`/setup-workflow` discovers these values for you from `gh project field-list`;
you rarely touch this by hand. Point a script at an alternate profile with the
`BOARD_SYNC_PROFILE` environment variable. Labels, branch prefixes, and headings
are *yours* to rename — the scripts read whatever the profile says.

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

**29 skills** (Router: ask-matt — "which skill/flow fits?" · Plan: grill-me,
grill-with-docs, to-prd, to-issues, board-to-waves, triage, spec-self-critique,
verify-spike, decision-gate · Execute: tdd, prototype, implement ·
Design/diagnose/refactor streams: diagnose, zoom-out,
improve-codebase-architecture, codebase-design, domain-modeling · Land: wrapup,
resolving-merge-conflicts · Learn: retro, write-a-skill · Setup: setup-workflow,
git-guardrails, setup-pre-commit · Codex review: grill-me-codex, grill-with-docs-codex,
codex-review),
installed for both surfaces — `.claude/skills`
(Claude Code) and `.agents/skills` (Codex) — plus `codex-adapter-sync`
(Codex-only: keeps the `.agents/skills` mirror in sync with the `.claude/skills`
source for dual-surface repos).

**Helper scripts** — `board_config.py` (profile loader), `board-sync.py`,
`execute-ready-check.py`, `pr-body-check.py`, the handoff drift-guard and
board-status hooks, the opt-in LoC-offender gate, and a wave-anchor template.

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
- The `grill-*-codex` / `codex-review` cross-model review is by **Chase AI**
  (https://github.com/chaseai-yt/grill-me-codex), MIT.
- `retro`, `wrapup`, `spec-self-critique`, `board-to-waves`, `verify-spike`,
  `decision-gate`, `codex-adapter-sync` are original work.

Full origin + license of every skill is in [PROVENANCE.md](PROVENANCE.md).

## License

MIT — see [LICENSE](LICENSE).

## A note on language

Some skill prose is still German — these conventions grew up in a German-speaking
project. The mechanics are language-neutral (the project layer drives everything),
so the skills work as-is; an English pass over the prose is a planned follow-up.
