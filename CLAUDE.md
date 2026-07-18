# CLAUDE.md

Maintainer conventions for developing the kit itself. `AGENTS.md` mirrors this
file for Codex sessions. Consumer-facing docs live in `README.md` and `docs/`.

## What this repo is

The **source SSOT** of `agent-workflow-kit` — the public repo where the kit's
skills, helper scripts, and installer CLI are developed. Historically the kit
was built inside the private `testreporter` repo (`tools/agent-workflow-kit/`)
and synced here; **Program #40** flips that: development happens here,
testreporter becomes a consumer. Until #40 / Welle 1 lands, the maintainer
build, test suites, lints, and release steps still live in testreporter — after
cutover they move here and testreporter must never re-grow a canonical
maintainer pipeline (`ssotOwnership` guard, see #40).

This repo is also a **consumer of its own kit** (dogfooding): the skills in
`.claude/skills/` are both the shipped product and the workflow we develop with.

Layout:

- `.claude/skills/` — skill source (Claude surface) · `.agents/skills/` — Codex
  mirror, kept in sync by `codex-adapter-sync`.
- `src/` — the npx installer CLI (`init` / `update` / `diff` / `uninstall`).
- `scripts/` — shipped helper scripts (board-sync, guards, hooks' cores) plus
  their tests.
- `docs/` — GitHub Pages site (methodology) and `docs/agents/` — this repo's
  own project layer (board profile, issue tracker, triage labels, domain docs).

## Development

Node ≥ 20. `npm test` runs the Node test suite and the Python script tests.
Python scripts target system `python3`, stdlib only — no pip dependencies. New
dependencies (Node or Python) need explicit approval before install.

Git hooks: run `git config core.hooksPath .githooks` once per clone (worktrees
inherit it). pre-commit runs the fast skill/manifest lints (~3s); pre-push runs
the full `npm test`. The explicit pre-PR gate stays `/local-ci` — the hooks are
the backstop, not a replacement. Never bypass with `--no-verify`.

## Skill authoring

- **English-first.** Every published skill's prose is English; the only
  exceptions are quoted user-input trigger phrases and audited cross-skill
  contract literals (mechanically enforced by the language census in the
  maintainer suite). Write new skills in English from the start.
- **Claude-first + same-PR mirror.** New or changed dual-surface skills are
  built in `.claude/skills/` first; the `.agents/skills/` mirror is updated in
  the **same PR** via `codex-adapter-sync` — never after merge. Never author a
  skill only on the Codex side.
- **Claude-only skills** (deliberately no `.agents` mirror): `write-a-skill`,
  `git-guardrails-claude-code`, `setup-pre-commit`, and the four `-codex`
  cross-model skills. A Codex-surface skill must never reference or escalate to
  a Claude-only target.
- **No hardcoded board values.** Skills and scripts read labels, headings,
  field IDs, status names, and PR markers from the board profile
  (`docs/agents/board-sync.md`), never inline literals — the portability lint
  in the maintainer suite blocks violations.
- **Provenance.** Vendored skills (Matt Pocock, Chase AI) are fork-and-own:
  keep `PROVENANCE.md` and each skill's `THIRD-PARTY-NOTICES.md` accurate when
  re-syncing or adapting; new own-work skills get listed under Own work.

## Consumer contract — never break

`init` records a sha256 manifest of every installed file; `update` is a
three-way reconcile against it: untouched files fast-forward, consumer-edited
files are backed up and diffed, **never silently overwritten**; the consumer's
project layer (`docs/agents/*`, board profile, `CLAUDE.md`) is written once and
never touched by `update`. Every change to shipped files must preserve this
contract and the manifest mechanism.

**Release:** version bump in the kit metadata + release-notes section in
`README.md` land in the release PR; the matching GitHub tag/release is
published **after merge as a separate step**. The npm Trusted-Publishing
pipeline and `$kit-release` arrive with Welle 1 (#41, locked in #40) — until
then, no ad-hoc npm publishes.

## Hard rules

### Workflow

- **Plan-first for multi-file work.** Numbered file list, approval before
  edits. Exception — a pre-planned issue slice with complete What + AC is
  already approved: execute directly, but **execute = red→green test-first**,
  never test-after. The exception skips only the plan gate, not the
  test-first loop.
- **Completeness is counted, not remembered.** Never claim a cross-cutting
  rollout (pattern or concept touching ≥3 places) is "complete" from memory —
  re-derive the denominator fresh (grep / manifest) and report `X of Y`. For
  skill-surface claims, derive from the skill manifest and lints, not a
  recalled list.
- **Kit-wide consistency.** A convention change (frontmatter shape, profile
  key, template heading) applies to **all** shipped skills/scripts in the same
  PR — no touched-only partial rollouts. Census the whole class.

### Git

- **Parallel subagents share the git index — default serialize.** Pathspec
  disjointness is no protection. Parallel work only with a `git worktree` per
  agent.
- **Worktree per session.** A different issue/slice than the current branch →
  create a worktree under `.worktrees/<slug>` early (before recon reads).
  Plan/grill sessions create the worktree **before** writing `PLAN.md`
  (gitignored, on-disk only); the implementing session reuses the same
  worktree. Check the branch carries no foreign open PR first
  (`gh pr list --head <branch>`).

### Diagnosis & verification

- **External errors are anomalies.** 400/500/timeout from `gh`/GraphQL/npm —
  investigate; my code is at fault until empirically refuted.
- **Tag diagnosis artefacts: 🔬 hypothesis / ✓ verified.** Untagged = 🔬 →
  re-verify before acting on it. ✓ only with inline evidence (`file:line`,
  command + output, SHA) and a verify date; a bare "verified" is a hypothesis.
- **An empty grep/git result is no proof.** Anchor paths from the repo root,
  grep the import line not just the bare symbol, try ≥1 pattern variant before
  claiming absence.
- **Verify external platform capabilities before plan-lock.** A plan resting on
  a GitHub plan-tier / Projects / API / npm capability is checked empirically
  (`gh api`, official docs) before the decision is locked — never assumed.

## Workflow

Use this section as the entry-point map for agent-assisted work. The individual
skills carry the detailed mechanics; this overview helps choose the right
starting point.

**If the task names a playbook skill** (`/orchestrate-wave`, `/tdd`,
`/diagnose`, `/grill-with-docs`, …), **load it via the Skill tool first — never
rebuild it from memory.** This holds even when the task partially overrides the
skill: the remaining lore (verify, landing, gates) stays binding — override ≠
skip.

**Delegation** is Claude's own per-task judgment (doctrine incl. model × effort
table lives in the user-global `~/.claude/CLAUDE.md` §Task-Routing). Repo
specifics: broad read-only recon → delegate to an Explore/investigator agent
with a terse report back; no spawn for single-value lookups or pre-edit recon.
**After any delegation: `Read` every edit target in the main thread yourself**
— subagent reads and Bash inspection do not satisfy the edit-read gate.

## Entry Points

- **Unsure which skill fits?** Ask `ask-matt` — a router over every skill in this list, with a recommended starting point and why.
- **A new build whose size is unclear** (a new app, a big cross-cutting feature, an unclear where-to-start): run `scale-check` — a short plain-language dialog that routes it to a program, a feature, a single slice, or a bug, and hands back a paste-ready start prompt.
- **New capability or unclear change:** start with `grill-with-docs` when the domain language or decisions need sharpening, then publish the agreed shape with `to-prd`.
- **A slice hinges on an unresolved fact or trade-off before it can be built:** clear it first — a binary yes/no question against real code/runtime/platform with `verify-spike`, a bounded "which option" choice with `decision-gate`.
- **Existing plan, PRD, or ready issue:** use `to-issues` to split it into independently buildable tracer-bullet slices.
- **A Program-PRD with a wave plan:** use `to-waves` to unfold it into named wave stubs + slice leaves on the board, after a chat preview gate that shows the whole plan before any write.
- **A backlog of open issues needs clustering into themed waves:** use `board-to-waves`.
- **A whole wave anchor (file-disjoint slices, specs already locked) to build, verify and land end-to-end — often AFK:** use `orchestrate-wave` — it dispatches implementers per slice, integrates serially, verifies centrally, and lands. (A single slice just goes to `implement`.)
- **Bugs or requests piling up that you didn't create:** use `triage` to move them into agent-ready issues.
- **Bug or regression:** use `diagnose` to reproduce, minimize, hypothesize, instrument, fix, and regression-test.
- **A design question needs a runnable answer (state, business logic, a UI you have to see):** spike it with `prototype`, then fold what you learned back in.
- **Multi-session build from a PRD or issue:** use `implement` to drive the build end-to-end, one red-green slice at a time.
- **Implementation slice:** use `implement` for one behavior at a time: RED, GREEN, then refactor.
- **Finished slice:** use `wrapup` to prepare the branch, PR, and cleanup steps your repo expects.
- **A huge, foggy effort, too big for one session:** use `wayfinder` — it charts it as a shared map of investigation tickets, resolving one per session.

## Routing Rule

Prefer the smallest workflow that produces a clear next action. A tiny fix can
go straight to `implement`; a cross-cutting feature should become a PRD and then
slices before implementation. When a skill reports missing project context, run
`setup-workflow` again and fill only the missing stub.

## Depth Ladder

- **Light:** direct `implement` for a small, well-understood change.
- **Medium:** `to-issues` for a ready artefact that needs slicing.
- **Deep:** `grill-with-docs` followed by `to-prd` and `to-issues` when terminology, contracts, rollout order, or ownership are still uncertain.
- **Gate:** insert `verify-spike` or `decision-gate` before any depth level when a slice hinges on an unresolved fact or trade-off.

## Backlog workflow (GitHub Projects v2)

Operative view: [Agent Workflow Kit board](https://github.com/users/iKon85/projects/3).
Field IDs and label/marker vocabulary are SSOT in the **board profile**
(`docs/agents/board-sync.md`); all board writes (create, status/wave/cluster
fields, sub-issue links, promote) go through `scripts/board-sync.py` — never
bare `gh issue create` + `gh project item-*`.

- **Session ritual.** Start: `gh issue list --state open --assignee @me` +
  `git status` + a two-line standing; the active issue is anchored by the
  branch. End: every finding becomes a `gh` issue; the next session's start
  prompt anchors on an **issue number**, not free text.
- **Branch/PR.** `feat|fix|chore|docs/<#>-<slug>`. Leaf-issue PR body:
  `closes #<#>`. Slice PR against a wave/cluster anchor: `Part of #<anchor>`,
  **never** `closes` (merge would close the anchor early). Multi-paragraph
  bodies via temp file + `--body-file`, then read back once.
- **Anchor reconcile on every slice event** (PR create **and** merge):
  `python3 scripts/board-sync.py anchor-sync <anchor#>` — `--dry-run` first,
  review the diff, then write.
- **Issue-checklist reconcile before "done".** Before reporting "all ACs
  done", ticking checkboxes, setting `closes`, or closing an issue: reconcile
  the full issue body against the actual state; list remaining items
  explicitly and leave the issue open.
- **Cross-slice writeback.** (a) A plan decision that touches a sibling
  slice's contract is written into **that** sibling's body immediately.
  (b) A build-time toppled assumption carried by an unbuilt sibling goes into
  the worktree's gitignored `ANNAHMEN.md` (wrapup propagates it). (c) "Phase
  comes in a later slice" → a tracking issue in the **same** PR — a code
  comment is not a board item.
- **Retro:** optional, but offer `/retro` before creating the PR (not after
  merge); if run, findings go into a Meta section of the PR body.

## Agent skills

### Issue tracker
GitHub Issues plus the repository's managed board. See `docs/agents/issue-tracker.md`.

### Triage labels
Board status is primary; only information-waiting and AFK-readiness use labels. See `docs/agents/triage-labels.md`.

### Domain docs
Single-context, with lazy root context and ADRs. See `docs/agents/domain.md`.

### Code review
Two-axis review (Standards × Spec). Project layer: `docs/agents/code-review.md`.

## Prod

Published as the `@ikon85/agent-workflow-kit` npm package and matching GitHub
tag/release through GitHub Actions. Live distribution:
https://www.npmjs.com/package/@ikon85/agent-workflow-kit and
https://github.com/iKon85/agent-workflow-kit/releases.

## Token hygiene

Memory is for durable infra/domain gotchas only — process/workflow lessons go
into this file, a convention doc, or a skill, not one-file-per-lesson.
