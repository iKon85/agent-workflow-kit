---
name: land
disable-model-invocation: true
description: >-
  Use ONLY when the user directly types $land or /land. Post-acceptance "land & clean" for
  the branch $make-landable prepared — pushes it, creates or reuses the PR with the authored
  body, gates that body, waits out the checks, merges, then kills the worktree dev server,
  removes the worktree + local branch, and fast-forwards the main checkout so main is
  current again, then sweeps merged-branch leftovers (local + stale remote whose PR is
  merged), reconciles the wave anchor and the program plan upward, propagates assumption
  drift into sibling issues, and reports the census freshness verdict. A branch with no
  worktree — a durable-content branch — lands the same way and has nothing to tear down.
  User-triggered only (never auto-invoke, never hook). Aborts hard only on: a detached or
  unborn HEAD, a rejected push, a conflicting PR, terminal red checks, or checks still
  pending after the bounded wait budget.
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill land --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# land — merge the PR & tear down the worktree

Trigger: user makes a direct `$land` or `/land` invocation (optionally with a PR number). **Manual only** — `disable-model-invocation: true`, no hook, no auto-invoke.

One route, one outcome: **the work is merged, the worktree is gone, and the board says so.** It expects the branch `$make-landable` left behind — committed, gated, with its PR body authored. A branch that is not landable yet goes back there first; this skill does not commit for you.

## ⚠ Spec context

The user's direct `$land` or `/land` input IS the explicit landing authorization for that run.
It authorizes the normal merge flow — the merge is the deploy — whether Prod readiness is ready or degraded;
it never authorizes the agent to invent or configure a deploy target. Never call
this skill from a hook or another skill. Natural-language requests, indirect skill
chaining, and autonomous invocation do not authorize it. There is no second merge confirmation; a forward chain never carries this run's merge/teardown authorization into another run, and the pre-flight hard stops are non-negotiable.

## Execution model — script does mechanics, the agent does judgment

All enumerable git/gh plumbing lives in **`scripts/wrapup-land.py`** (`land`, JSON report on stdout, exit 1 = STOP with reason in the JSON). It replaces the former Sonnet phase-2 subagent — measured over 120 runs the subagent burned a median 23 model turns on steps with zero judgment content (→ mechanized 2026-07).

The agent keeps: sibling propagation, anchor close, final report — plus **diagnosis whenever the script STOPs**. On any STOP: fix the named cause, re-run (the script is idempotent). **Force NOTHING** — no `--force`, no `-D`, no `--no-verify`.

## Flow

### 1 · Pre-flight
```bash
node scripts/readiness.mjs check --skill land --json
```

`prodTarget: ready` activates only `deployReport` below. `pending` or `missing`
omits that block, emits exactly one concise note — `Prod readiness is pending or missing; deploy reporting omitted.` — and landing continues normally.
`invalid` means malformed or divergent Prod evidence: STOP and report the
conflicting instruction surfaces; never choose a target on the user's behalf.

### 2 · Land
Run **from the main tree** (the script refuses inside the worktree — an in-worktree shell would survive teardown and the process kill):
```bash
python3 scripts/wrapup-land.py land --branch "<branch>" --title "<title>" --body-file /tmp/landing-pr-body.md
```
One call covers: push → PR create/reuse (+ drift markers merged into the body) → `pr-body-check.py` gate (exit 1 = STOP, exit 2 = fail-open warning) → merge gate (pending/null-conclusion checks poll for up to 20 minutes with progress on stderr; terminal red / `CONFLICTING` / timeout = STOP; known zero-step billing or runner failures are named `infrastructure failure`; an already-`MERGED` PR resumes at teardown) → **merge** (`--merge` + `--delete-branch`, verified `MERGED`) → dev-server kill (`.dev-ports` listeners only, own shell ancestry excluded) → teardown classification + scratch removal → worktree remove (no `--force`; refusal = STOP, check surviving processes first) → integration-branch `--ff-only` pull + branch retirement by authority → issue-close verify (auto-close misses are closed manually) → local merged-branch sweep (`-d` only — squash/rebase-merged branches stay a manual call by design) → remote merged-PR sweep (opt-in `wrapup.remoteBranchSweep` in the board profile; PR-status-authoritative via `ls-remote`; deleted remote branches are restorable from the PR page) → anchor-sync (dry-run diff in the report) + anchor completeness check + `execute-ready-check --mode audit` → **upward propagation:** if the anchor's native parent is a Program-PRD, `program-sync` refreshes its Wellenplan (Status + Issue cells) and checks off mechanically completed Phasen-Gates — the slice event is visible at the program level, not only in the wave (`program_sync` block in the report; skipped when the parent isn't a program) → **census freshness** (the last step, see below).

STOP → diagnose in the main conversation, fix, re-run `land`. Re-running is the
only recovery route there is: every step re-reads present state (is the remote
already at this commit? does the PR exist? is it merged? is the worktree still
there?) and skips what is already done, so an interrupted landing resumes
exactly where it stopped. The report's `skipped` list names what it found done.

Teardown runs on the target resolved before the merge, and running `/land` in
a worktree *is* its authorization — including a worktree an external tool
created under a foreign name and path, and a branch that carries no issue
number. Two targets yield nothing to tear down and are reported, not refused:
no worktree holds the branch — the ordinary shape of a durable-content branch — and the tree holding it is the main checkout,
which `/land` never tears down. Everything a refusal would reject is decided
there, while nothing has been removed yet. Teardown authority is
the repository's current state, nothing else: a tracked change or an unmerged
path blocks, an untracked non-ignored file blocks with a bounded report (count
plus top directories, never a path dump), and an ignored entry is deletable
scratch. One exception with two arms: an `.env*` file the profile's `seed.paths`
declares is deletable **by that declaration** and the report names the deletion;
an undeclared one is deletable only when it is byte-identical to the main
checkout's copy at the same path — otherwise the refusal names the exact file.
An ignored symlink is unlinked, never followed,
and only while its target stays inside the worktree: an absolute, escaping,
dangling, or since-changed target keeps the worktree and names the link. Make
something deletable by ignoring it, or — for a `.env*` your worktree owns — by
declaring it in the seed; there is no pattern list to configure.

Branch retirement is authorized, never assumed. A branch that is an ancestor of
the **freshly fetched** integration branch is deleted with `-d`; a fetch that
fails stops instead of trusting a stale ancestry check. Otherwise the platform's
own record decides: exactly one pull request matching the full tuple — this
repository on both sides (no fork heads), this head ref, the configured base
ref, merged — whose head SHA still equals the branch tip re-read immediately
before the deletion, authorizes the force delete. Zero matches, several matches,
an open PR on the same head, a tip that moved in between, or no platform access
at all keep the branch and report why (`branch_authority` in the report; a
degraded run says so instead of implying the platform agreed). A reused head ref
resolves to several pull requests, so the head SHA carries the uniqueness, not
the ref — `land --pr <n>` names the pull request to check when that record is
ambiguous. `--pr` selects which pull request is validated; it never skips the
validation.

Two refusals name a state landing cannot repair for you: a **detached HEAD**
(attach a branch in that worktree first) and an **unborn branch** (make the
first commit first).

The census-freshness step gives that verdict a session-end home. It reads
`drift-guard.py --census-status` **for the main checkout** — the tree the next
session starts from — because a census describes the tree it was scanned in: a
refresh committed inside a worktree is visible in that one working tree only, so
a worktree-green verdict must never stand in for a stale main checkout. `current`
and `no_census` leave no trace at all; only `refresh_required` speaks, as a
`census` block in the report that names the verdict, its reasons, the **evaluated
checkout**, and the recovery route — run `$census-update` there and land the
refresh as a dedicated pull request of its own, never a census file mirrored
between checkouts. It is a finding, never a gate: topology drift is repo-wide and
usually not caused by the PR at hand, so the landing completes regardless, and a
census step that cannot answer degrades to one warning. Opt in with
`wrapup.censusTrackingIssue` in the board profile to also open one
marker-identified tracking issue — a later session updates that same issue
instead of minting a duplicate, and an ambiguous or unreachable lookup writes
nothing and says why.

The dev-server kill is `.dev-ports`-scoped and never signals on doubt: only a
listener on a port this worktree declares, whose working directory is inside
it, is signalled — pinned by `pidfd` so a recycled PID cannot be hit. Anything
else on those ports is a STOP naming the process, not a kill.

### 3 · Post-merge (agent)
- **Sibling propagation:** for each `drift_markers` entry in the land report, append the note to the target issue's `vor_bau` section + re-stamp its `plan_revision`. Log-based markers → **write directly, then show what was written where** (mandatory report — visibility moved from a pre-gate into the report, decision 2026-07-06); fallback candidates the user hasn't confirmed yet → confirm first. Program context widens the target set to unbuilt wave-stubs/leaves and the Program-PRD itself — same append-only mechanism. **Exception:** appends to the Program-PRD or unbuilt wave-stubs do **not** re-stamp `plan_revision` — that stays reserved for structural wave-plan edits via the `to-waves` escalation path; a mere drift note must not stale-block published stubs.
- **Anchor close:** report says `anchor_complete: true` → `gh issue close <anchor> -c "Wave complete — all slices merged via PR #<pr>."` and verify board status Done. The guard keeps anchors away from every auto-close — this verified close is the only close path; without it the anchor stays silently open after the last slice. **Then re-run the upward propagation**: the land-time `program-sync` ran BEFORE this close, so on a wave-completing slice the Wellenplan still shows 🔄 and the Phasen-Gate stays unchecked — after the board shows Done, run `python3 scripts/board-sync.py program-sync <program-prd#>` once more (the report's `program_sync.program` names it; skip when the report says the parent is not a program). Board auto-rules can lag the close (Close→Done race) — verify Done first, that's what the token reads.
- **Handoff report**, concise, from the land JSON: PR merged · issue close (auto/manual) · worktree removed · branch deleted · sweep counts local/remote · anchor synced + complete/pending · program propagation (`program_sync`: Wellenplan refreshed / gates checked / skipped) · propagation writes (what → where) · census finding when the report carries one (verdict + evaluated checkout + recovery route + tracking issue; silent otherwise) · what is still open · `main` at `<sha>`.

<!-- readiness:block deployReport -->
- **Deploy-aware report:** read the coherent `## Prod` block; before merging,
  state the configured deploy trigger and expected outcome. After merge, report
  the configured target and its actual known state. Do not claim a deployment
  is running or live unless the configured trigger and observed evidence prove
  it; keep unknown timing explicit.
<!-- readiness:end -->

## Out of scope
- Local CI, the commit, the PR body text: `$make-landable` owns them and runs before this skill.
- Live-verify / DoD: must happen **before** `$land` or `/land` — this skill lands, it does not verify.
- Other worktrees / their servers stay untouched.
