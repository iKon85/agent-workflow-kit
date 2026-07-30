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

- **English-first.** Published skill prose is English; only quoted user-input
  trigger phrases and audited cross-skill contract literals may differ — the
  language census enforces it.
- **Claude-first + same-PR mirror.** Build dual-surface skills in
  `.claude/skills/` first; `codex-adapter-sync` updates the `.agents/skills/`
  mirror in the **same PR** — never Codex-side only, never after merge.
- **Claude-only skills** (deliberately no `.agents` mirror): `write-a-skill`,
  `git-guardrails-claude-code`, `setup-pre-commit`, and the four `-codex`
  cross-model skills. A Codex-surface skill must never reference or escalate to
  a Claude-only target.
- **No hardcoded board values.** Skills and scripts read labels, headings,
  field IDs, status names, and PR markers from the board profile
  (`docs/agents/board-sync.md`), never inline literals — the portability lint
  blocks violations.
- **Provenance.** Vendored skills (Matt Pocock, Chase AI) are fork-and-own:
  keep `PROVENANCE.md` and each skill's `THIRD-PARTY-NOTICES.md` accurate when
  re-syncing or adapting; new own-work skills get listed under Own work.

## Consumer contract — never break

`init` records a sha256 manifest of every installed file; `update` is a
three-way reconcile against it that **always activates the full new version**.
An untouched file fast-forwards. A consumer-edited `origin=kit` file that the
ledger declares no ownership for is overwritten — with a non-clobbering backup
and a diff, and named in the end-of-update summary, so **nothing is lost and
nothing is silent**. The silent in-place fork and its conflict-blocking state
are gone: **ownership is what scopes the overwrite.** A ledger-declared consumer
state (`project-extension`, `contribution-bridge`, `explicit-fork` via `own`) is
never overwritten, and the summary *offers* those routes for every backed-up
path without ever assigning one. The consumer's project layer (`docs/agents/*`,
board profile, `CLAUDE.md`, `AGENTS.md`) is written once and never overwritten
by ordinary reconciliation. The only allowed update-time project-layer writes
are explicit, schema-driven, idempotent migrations that preserve existing
evidence, are previewed and destination-race checked, and activate or roll back
with the verified update candidate. Every change to shipped files must preserve
this contract and the manifest mechanism.

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

## Behavioral core

Adapted from forrestchang's Karpathy-derived behavioral guidelines (MIT — see
`PROVENANCE.md`), merged with this repo's own doctrine. It biases toward caution
over speed: **for trivial tasks, use judgment.**

**Think before coding.** Don't assume, don't hide confusion, surface trade-offs.
State the assumptions; name competing readings of the request instead of
silently picking one; say so when a simpler route exists. Unclear → stop and
name what is unclear.

**Simplicity first.** The minimum that solves the problem, nothing speculative —
no unasked feature, no abstraction for a single use, no configurability nobody
requested, no error handling for impossible states. *Would a senior engineer
call this overcomplicated?* If yes, cut it.

**Surgical changes.** Touch only what you must; clean up only your own mess.
Don't improve adjacent code, comments or formatting, don't refactor what isn't
broken, match the existing style. Unrelated dead code is mentioned, not deleted;
orphans your change created are removed. Every changed line traces to the
request.

**Goal-driven execution.** Turn the task into a verifiable goal ("add
validation" → "write the tests for invalid input, then make them pass") and loop
until it is met; strong success criteria are what let a session run without
asking after every step.

### Verify-first — two classes

**Class 1 — an assertion about state is read before it is claimed.** Routes from
config, API shapes from code or spec, paths from the filesystem, versions and
platform capabilities from official docs before a plan locks on them, project
state from git/GitHub; a subagent's report is evidence, not the read. The claim
carries its evidence inline (`file:line`, command + output, SHA) — without it,
it is a hypothesis. An empty grep or git result proves nothing: anchor from the
repo root, vary the pattern before claiming absence, and let a negative
measurement wait until the same harness returns a positive on a known-positive
case (#296). Completeness is class 1 too — re-derive the denominator fresh
(grep / manifest) and report `X of Y`, never from memory. External errors
(400/500/timeout from `gh`, GraphQL, npm) are anomalies: my code is at fault
until empirically refuted.

**Class 2 — re-verifying my own completed action is off by default.** A named
exception carries an incident number and is purpose-built: the release readback
(#205), where npm propagation can leave the registry ahead of the GitHub
release. Reading back what I just wrote, or re-checking a command that reported
success, is ceremony until an incident says otherwise.

### Adding machinery

No test says this workflow behaved correctly, so the standing temptation is to
legislate what cannot be measured (#343).

- **Add only on observed failure.** A mechanism names the incident that demands
  it, or it is not built. Once → a note; repeatedly, this repo → project layer;
  repeatedly or structurally, across projects → shipped and mechanical, with
  something that can fail it.
- **One floor per failure class.** Where git, GitHub, or an idempotent re-run
  already catches the failure, a second floor is ceremony — count the gates
  already standing. Machinery that keeps a wrong input working conserves the
  cause.
- **Principle over case.** A rule that enumerates the case teaches the case; the
  principle it instances transfers, and judgment is what a rule has to beat.
  Always-on `CLAUDE.md` carries only what must hold before anything loads;
  detail belongs in the skill that loads when it matters, repo-specific detail
  in `docs/agents/*`.

## Hard rules

### Workflow

- **Plan-first for multi-file work.** Numbered file list, approval before
  edits. Exception — a pre-planned issue slice with complete What + AC is
  already approved: execute directly, but **execute = red→green test-first**,
  never test-after. The exception skips only the plan gate, not the
  test-first loop.
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
  `/make-landable`'s confirmed file claim as ordinary work. The implementing
  session creates the worktree when the build starts.

## Workflow

**If the task names a playbook skill** (`/orchestrate-wave`, `/tdd`,
`/diagnose`, `/grill-with-docs`, …), **load it via the Skill tool first — never
rebuild it from memory.** This holds even when the task partially overrides the
skill: the remaining lore (verify, landing, gates) stays binding — override ≠
skip.

**Delegation** is Claude's own per-task judgment, but **model and effort are
configuration, not doctrine**: where a Routing profile exists it decides them
(Model roster and Standard routes → Routing policy → Route decision), and it
decides them whether or not the hand-maintained model × effort table is still
present in the user-global `~/.claude/CLAUDE.md` §Task-Routing. That section
keeps only the judgment that is not data — when delegation pays for itself, the
two-strikes escalation rule, one worktree per parallel writing agent. Retiring
the table is a previewed, backed-up, explicitly accepted migration:
`node scripts/doctrine-migration/index.mjs` (add `--apply --accept` to write);
it refuses while no Routing profile can decide, so deferring it is safe. Repo
specifics: broad read-only recon → delegate to an Explore/investigator agent
with a terse report back; no spawn for single-value lookups or pre-edit recon.
**After any delegation: `Read` every edit target in the main thread yourself**
— subagent reads and Bash inspection do not satisfy the edit-read gate.

## Route map

Smallest route with a clear next action. Unclear terms → `grill-with-docs` →
`to-prd`; ready artefact → `to-issues`; backlog → `board-to-waves`; foreign
reports → `triage`; huge and foggy → `wayfinder`; bug → `diagnose`; open
fact/option/design → `verify-spike`/`decision-gate`/`prototype`; file-disjoint
wave → `orchestrate-wave`; any build, tiny fixes self-routed → `implement`
(RED→GREEN); built → `make-landable`; accepted → `land`; missing project
context → `setup-workflow`.

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
  bodies via temp file + `--body-file`. Write the temp file wherever, but **run
  `gh` from the repo** — `gh` resolves the target repository from the working
  directory and dies with `not a git repository` in `/tmp`.
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
  the worktree's gitignored `ANNAHMEN.md` (`land` propagates it). (c) "Phase
  comes in a later slice" → a tracking issue in the **same** PR — a code
  comment is not a board item.
- **Retro:** voluntary — `/retro` is available whenever a session earned one,
  and nothing on the landing path asks for it, waits on it, or records it. If
  run before the PR, findings go into a Meta section of the PR body.

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
