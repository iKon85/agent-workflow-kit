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

`main` is protected by the `main protection` repository ruleset: a pull request
is required (0 required approvals — a solo maintainer cannot self-approve), the
CI job `test` must be green with the branch up to date (strict policy), and
force-push, deletion and bypass actors are all off. There is therefore no direct
push to `main`, and `gh pr merge --admin` no longer bypasses the check. The
required context is the job name `test`, not the workflow name `CI`. This is
free because the repo is public — protected branches on a private repo would
need GitHub Pro. `/local-ci` stays the explicit pre-PR gate; the ruleset is the
server-side backstop, not a replacement.

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
project layer (`docs/agents/*`, board profile, `CLAUDE.md`, `AGENTS.md`) is
written once and never overwritten by ordinary reconciliation. The only
allowed update-time project-layer writes are explicit, schema-driven,
idempotent migrations that preserve existing evidence, are previewed and
destination-race checked, and activate or roll back with the verified update
candidate. Every change to shipped files must preserve this contract and the
manifest mechanism.

**Release — merge integrates; an annotated version tag publishes.** Version
bump in the kit metadata + release-notes section in `README.md` land in the
release PR. Merging that PR to `main` integrates the prepared release but cannot
start publication. A matching annotated `v<version>` tag on the canonical
`main` commit is the sole normal publication intent and triggers
`.github/workflows/release.yml`. The workflow rejects a missing, lightweight,
mismatching, or non-main tag before it runs artifact/test gates or the
`scripts/release-state.mjs` idempotent reconciler.

Prepare a release with `npm run release:prepare -- --version <x.y.z>` (bump +
regenerated manifest + release-note delta, then guard + suite + `npm pack
--dry-run`); never hand-run `npm publish` — the workflow owns publishing.
`reconcileRelease` is idempotent, so a re-run repairs a partial release instead
of duplicating one.

**One human gate: the Semver.** The user confirms the exact version used to
prepare metadata; an explicit AFK end-to-end mandate covering release
preparation may instead accept the tool's deterministic recommendation. Either
way, **that confirmed Semver authorizes the whole release — metadata, merge,
tag and publish.** After merge the agent verifies the version on canonical
`main`, creates and pushes the annotated tag, and monitors to `released`,
without asking again; a narrower build-only request never becomes this
authority. Tagging stays the irreversible public action — the protection is the
gates that run regardless of who is watching (guard, staleness, suite, pack,
plus the workflow's own tag/version/ancestry validation), not a prompt (#257).

**An integrated version never stacks under the next one.** `release:guard`
blocks a PR that bumps the version while the base version still carries no
matching annotated tag: that release is `awaiting-tag` and would otherwise
disappear under the newer bump, its release-notes section claiming an artifact
that never existed (#243). Tag and publish the pending version first. Only a
repository with no matching tag at all is exempt — that is a first release, not
a stack.

**A red release run does not mean nothing was published** — the post-publish
readback can lose a race with npm propagation and fail *after* a successful
publish, leaving npm ahead of the GitHub release (#205). Always check
`npm view @ikon85/agent-workflow-kit version` and `gh release view v<x.y.z>`
before reacting; `npm run release:status` reads the registry cache-bypassing so
a stale packument cannot report a live release as unpublished (#243). Manual
dispatch is recovery only: it requires one explicit existing tag and runs the
same reconciler. Never recover by bumping the version.

## Design maxim

This is a meta-system, not an app: no test says the workflow behaved correctly,
so the standing temptation is to legislate what cannot be measured (#343).
Before adding a rule, guard or gate:

- **One observation is not a mechanism.** Once, known trigger → a note or one
  recovery line. Repeatedly, this repo → project layer. Repeatedly or
  structurally, across projects → shipped, and mechanical (lint, guard,
  command) with something that can fail it.
- **Principle over case.** A rule that enumerates the case teaches the case;
  the principle it instances transfers. If the principle won't name itself, the
  finding isn't understood yet.
- **Judgment is what a rule has to beat.** An over-specified rule narrows the
  space the agent would otherwise reason through. It earns its override with a
  repeated real failure, never a conceivable one.
- **Place by when it is read.** Always-on `CLAUDE.md` carries only what must
  hold before anything loads; detail belongs in the skill that loads when it
  matters; repo-specific detail in `docs/agents/*`.
- **Price the journey, not the rule.** Count the gates already standing on it.
- **Cause before survival.** Machinery that keeps a wrong input working
  conserves it.

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
- **Worktree binds to implementation.** A worktree isolates a *build*, so it
  belongs to the session that builds. A different issue/slice than the current
  branch → create it under `.worktrees/<slug>` early (before recon reads),
  after checking the branch carries no foreign open PR
  (`gh pr list --head <branch>`). Plan/grill sessions create **none**: they run
  in the main checkout, their `PLAN.md` and review log stay gitignored on disk,
  and their durable output (`CONTEXT.md`, ADRs, research notes) lands through
  `/wrapup`'s Content route as ordinary work. The implementing session creates
  the worktree when the build starts.

### Diagnosis & verification

- **External errors are anomalies.** 400/500/timeout from `gh`/GraphQL/npm —
  investigate; my code is at fault until empirically refuted.
- **Tag diagnosis artefacts: 🔬 hypothesis / ✓ verified.** Untagged = 🔬 →
  re-verify before acting on it. ✓ only with inline evidence (`file:line`,
  command + output, SHA) and a verify date; a bare "verified" is a hypothesis.
- **An empty grep/git result is no proof.** Anchor paths from the repo root,
  grep the import line not just the bare symbol, try ≥1 pattern variant before
  claiming absence.
- **A negative measurement is no proof until the harness has produced a
  positive.** Before recording "the capability is absent", show the same
  apparatus returning a positive on a case known to have it — otherwise the
  measurement may have varied the thing under test while holding a control that
  never had the capability at all. Record the positive control next to the
  negative. (#296: every early probe ran against a model with no effort axis,
  so "effort is not readable" was about to be written into an ADR; a control run
  on an effort-capable model returned the value immediately.)
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
- **Existing plan, PRD, or ready issue:** use `to-issues`, the single Planning facade. Explicit Feature identity selects tracer-bullet decomposition; explicit Program identity selects the internal graph path and its complete preview before any write.
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
  bodies via temp file + `--body-file`, then read back once. Write the temp file
  wherever, but **run `gh` from the repo** — `gh` resolves the target repository
  from the working directory and dies with `not a git repository` in `/tmp`.
  Working out of the temp directory is the natural way to do this and fails
  every call; pass `-R <owner>/<repo>` if the cwd cannot be the repo.
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
release through GitHub Actions. Live distribution:
https://www.npmjs.com/package/@ikon85/agent-workflow-kit and
https://github.com/iKon85/agent-workflow-kit/releases.

**Deploy trigger:** pushing a matching annotated `v<version>` tag on the
canonical `main` commit. Merging a prepared version integrates it only and
leaves it `awaiting-tag`; it cannot publish. The tag-triggered workflow validates
tag identity, package version, main ancestry, artifact integrity, and tests,
then publishes to npm (`--access public --provenance`) and creates or reconciles
the matching GitHub release. Manual dispatch requires an explicit existing tag
and is recovery only. A red run does not prove nothing was published (#205) —
check `npm view` and `gh release view` before reacting. `release:guard` blocks a
bump stacked on a still-untagged previous release (#243): tag the pending
version, never bury it.

**One human gate: the Semver.** The confirmed Semver authorizes the whole
release — metadata, merge, tag and publish. After merge the agent verifies the
version on canonical `main`, tags, and monitors to `released` without asking
again; a narrower build-only request never becomes this authority. Tagging
stays irreversible, and the protection is the gates that run regardless of who
is watching, not a prompt (#257). Full flow: `CLAUDE.md` §Consumer contract →
Release.

## Token hygiene

Memory is for durable infra/domain gotchas only — process/workflow lessons go
into this file, a convention doc, or a skill, not one-file-per-lesson.
