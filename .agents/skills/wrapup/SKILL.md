---
name: wrapup
disable-model-invocation: true
description: >-
  Use ONLY when the user directly types $wrapup or /wrapup. Session-end "land & clean" for a
  finished feature/fix worktree — merges the open PR,
  kills the worktree dev server, removes the worktree + local branch, and
  fast-forwards the main checkout so main is current again, then sweeps
  merged-branch leftovers (local + stale remote whose PR is merged). If the
  slice isn't landed yet, it first makes it landable (Step 0): commits a dirty
  tree (after an .env/secret check), pushes, and opens the PR — reusing one if
  it already exists. Second route (no worktree, no slice): durable content dirty
  in the main checkout lands via one confirmed, hash-verified file claim on an
  issue-less branch — bystanders untouched, no teardown. User-triggered
  only (never auto-invoke, never hook). Aborts hard only on: the worktree flow
  on the main checkout or a protected branch, a detached or unborn HEAD, a
  detected .env/secret, a rejected push, a conflicting PR, terminal red checks,
  or checks still pending after the bounded wait budget.
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill wrapup --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# wrapup — land PR & tear down worktree

Trigger: user makes a direct `$wrapup` or `/wrapup` invocation (optionally with a PR number). **Manual only** — `disable-model-invocation: true`, no hook, no auto-invoke.

## ⚠ Spec context

The user's direct `$wrapup` or `/wrapup` input IS the explicit landing authorization for that run.
It authorizes the normal merge flow whether Prod readiness is ready or degraded;
it never authorizes the agent to invent or configure a deploy target. Never call
this skill from a hook or another skill. Natural-language requests, indirect skill
chaining, and autonomous invocation do not authorize it. There is no second merge confirmation; the pre-flight hard stops are non-negotiable.

## Execution model — script does mechanics, the agent does judgment

All enumerable git/gh plumbing lives in **`scripts/wrapup-land.py`** (`preflight` / `commit` / `land`, JSON report on stdout, exit 1 = STOP with reason in the JSON). It replaces the former Sonnet phase-2 subagent — measured over 120 runs the subagent burned a median 23 model turns on steps with zero judgment content (→ mechanized 2026-07).

The agent keeps: retro gate, secret review, commit message, PR body text, drift-fallback candidates, sibling propagation, anchor close, final report — plus **diagnosis whenever the script STOPs**. On any STOP: fix the named cause, re-run (the script is idempotent). **Force NOTHING** — no `--force`, no `-D`, no `--no-verify`.

## Flow

### 1 · Pre-flight
Run **in the worktree**:
```bash
python3 scripts/wrapup-land.py preflight
```
Hard stop (the only pure preconditions): the main checkout, a protected branch, a detached HEAD, or an unborn branch — the script exits 1 and names which. Any other born, attached worktree qualifies, whatever its name or location. The report carries everything the later steps need: dirty files, `.env` hits, secret-grep hits, issue + parent (leaf vs. anchor slice), existing PR + whether its body has a `**Retro:**` line, parsed `ANNAHMEN.md` drift lines, profile values (`retro_values`, `vor_bau`, remote-sweep switch).

Then run:

```bash
node scripts/readiness.mjs check --skill wrapup --json
```

`prodTarget: ready` activates only `deployReport` below. `pending` or `missing`
omits that block, emits exactly one concise note — `Prod readiness is pending or missing; deploy reporting omitted.` — and landing continues normally.
`invalid` means malformed or divergent Prod evidence: STOP and report the
conflicting instruction surfaces; never choose a target on the user's behalf.

### 2 · Retro gate (blocking, optional retro-exit — before anything is committed)
One reminder, not a merge confirmation:
> "Already ran a retro? **(a)** yes / continue → landing now. **(b)** you want one first → the retro starts now; afterwards, invoke `$wrapup` or `/wrapup` again — repo-file patches then travel in this PR."

(b) → **invoke the `retro` skill immediately in this run.** Retro is
model-invocable and non-deploying, and every mutation still has its own approval
gate. After retro finishes, **land nothing in this run**. Require a **fresh
explicit `$wrapup` or `/wrapup` invocation** because retro may have changed the exact diff
that the next merge authorization covers.

General chaining rule: automatically chain only into a **model-invocable**,
**non-deploying** workflow. If the named target is user-only, deploys, or
depends on an external action, **return control to the user** and **state the
reason**. A forward chain never carries wrapup's merge/deploy authorization
into another run.

The answer materializes as the mandatory `**Retro:**` PR-body line in step 4 — that's recording, not a second question. Why the gate lives here: in a foreign project this is the only portable retro touchpoint; a project-local "offer retro before PR" convention usually answers it already.

### 3 · Commit (only if the tree is dirty)
Judgment first, then the guarded commit:
- **Secret review:** judge the preflight `secret_hits` — a variable *named* `token` isn't a secret; a real key → resolve first, never commit. `.env` files are a mechanical hard block inside the script.
- **Commit message:** conventional, `<type>(<scope>): <summary> (#<issue>)` — type from the branch prefix, summary from the actual diff, issue from the branch.
```bash
python3 scripts/wrapup-land.py commit -m "<message>"   # --allow-matches only after judging every hit a false positive
```
STOP on hook failure: many `Cannot find module`/TS2307 across **unrelated** files in a node/pnpm repo = stale worktree `node_modules` → `pnpm install --frozen-lockfile`, re-run. Real errors in slice files = legitimate stop. **Never `--no-verify`.**

### 4 · Author the PR body (agent-written, script-checked)
Write title + body to a temp file (inline bodies with backticks crash bash):
- Leaf issue → `closes #<n>`, **never inside backticks** (GitHub ignores the keyword there). Wave/cluster slice → `Part of #<anchor>`, **never `closes`** (would close the anchor early).
- **Mandatory `**Retro:**` line** — exactly one of the two `retro_values` from the preflight report (closed set, copy verbatim; `pr-body-check.py` rejects anything else): retro ran → `**Retro:** <value0> — findings under ## Retro / Meta-Findings`; skipped → `**Retro:** <value1> — <reason>`. "Nothing to retro" is the second value + reason, not a third form. Applies to every PR body, including ad-hoc `gh pr create` mid-session.
- **Assumption drift:** the build-time log `ANNAHMEN.md` is explicitly captured content — its well-formed lines become `annahme-drift` markers **mechanically, no confirmation gate** (`land` merges them into the body; decision 2026-07-06, replaced the old propose+confirm for log entries). Two cases stay with the agent:
  - **Malformed line** (no `#<n>` target) → clarify with the user (fix the target or discard deliberately), never drop silently; `--skip-malformed-drift` only for a deliberately discarded rest.
  - **No log / empty log** → fallback, retro-style: walk the slice's deliberately made or reversed assumptions yourself and present **named candidates** (`- #<n>?: <assumption> → might carry <issue>`); user confirms → write the markers into the body by hand. Zero candidates → say so explicitly ("no drift found — checked: <what>"). The log is the floor, not the ceiling — drift noticed while landing goes in the same way.

### 5 · Land
Run **from the main tree** (the script refuses inside the worktree — an in-worktree shell would survive teardown and the process kill):
```bash
python3 scripts/wrapup-land.py land --branch "<branch>" --title "<title>" --body-file /tmp/wrapup-pr-body.md
```
One call covers: push → PR create/reuse (+ drift markers merged into the body) → `pr-body-check.py` gate (exit 1 = STOP, exit 2 = fail-open warning) → merge gate (pending/null-conclusion checks poll for up to 20 minutes with progress on stderr; terminal red / `CONFLICTING` / timeout = STOP; known zero-step billing or runner failures are named `infrastructure failure`; an already-`MERGED` PR resumes at teardown) → **merge** (`--merge` + `--delete-branch`, verified `MERGED`) → dev-server kill (`.dev-ports` listeners only, own shell ancestry excluded) → teardown classification + scratch removal → worktree remove (no `--force`; refusal = STOP, check surviving processes first) → integration-branch `--ff-only` pull + branch retirement by authority → issue-close verify (auto-close misses are closed manually) → local merged-branch sweep (`-d` only — squash/rebase-merged branches stay a manual call by design) → remote merged-PR sweep (opt-in `wrapup.remoteBranchSweep` in the board profile; PR-status-authoritative via `ls-remote`; deleted remote branches are restorable from the PR page) → anchor-sync (dry-run diff in the report) + anchor completeness check + `execute-ready-check --mode audit` → **upward propagation:** if the anchor's native parent is a Program-PRD, `program-sync` refreshes its Wellenplan (Status + Issue cells) and checks off mechanically completed Phasen-Gates — the slice event is visible at the program level, not only in the wave (`program_sync` block in the report; skipped when the parent isn't a program) → **census freshness** (Step 5f, see below).

STOP → diagnose in the main conversation, fix, re-run `land`. Re-running is the
only recovery route there is: every step re-reads present state (is the remote
already at this commit? does the PR exist? is it merged? is the worktree still
there?) and skips what is already done, so an interrupted landing resumes
exactly where it stopped. The report's `skipped` list names what it found done.

Teardown always runs, and running `/wrapup` in a worktree *is* its
authorization — including a worktree an external tool created under a foreign
name and path, and a branch that carries no issue number. Teardown authority is
the repository's current state, nothing else: a tracked change or an unmerged
path blocks, an untracked non-ignored file blocks with a bounded report (count
plus top directories, never a path dump), and an ignored entry is deletable
scratch. One hardcoded exception: an `.env*` file is deletable only when it is
byte-identical to the main checkout's copy at the same path — otherwise the
refusal names the exact file. Make something deletable by ignoring it; there is
no pattern list to configure.

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

Step 5f gives the census freshness verdict a session-end home. It reads
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

### 6 · Post-merge (agent)
- **Sibling propagation:** for each `drift_markers` entry in the land report, append the note to the target issue's `vor_bau` section + re-stamp its `plan_revision`. Log-based markers → **write directly, then show what was written where** (mandatory report — visibility moved from a pre-gate into the report, decision 2026-07-06); fallback candidates the user hasn't confirmed yet → confirm first. Program context widens the target set to unbuilt wave-stubs/leaves and the Program-PRD itself — same append-only mechanism. **Exception:** appends to the Program-PRD or unbuilt wave-stubs do **not** re-stamp `plan_revision` — that stays reserved for structural wave-plan edits via the `to-waves` escalation path; a mere drift note must not stale-block published stubs.
- **Anchor close:** report says `anchor_complete: true` → `gh issue close <anchor> -c "Wave complete — all slices merged via PR #<pr>."` and verify board status Done. The guard keeps anchors away from every auto-close — this verified close is the only close path; without it the anchor stays silently open after the last slice. **Then re-run the upward propagation**: the land-time `program-sync` ran BEFORE this close, so on a wave-completing slice the Wellenplan still shows 🔄 and the Phasen-Gate stays unchecked — after the board shows Done, run `python3 scripts/board-sync.py program-sync <program-prd#>` once more (the report's `program_sync.program` names it; skip when the report says the parent is not a program). Board auto-rules can lag the close (Close→Done race) — verify Done first, that's what the token reads.
- **Report**, concise, from the land JSON: PR merged · issue close (auto/manual) · worktree removed · branch deleted · sweep counts local/remote · anchor synced + complete/pending · program propagation (`program_sync`: Wellenplan refreshed / gates checked / skipped) · propagation writes (what → where) · census finding when the report carries one (verdict + evaluated checkout + recovery route + tracking issue; silent otherwise) · `main` at `<sha>`.

<!-- readiness:block deployReport -->
- **Deploy-aware report:** read the coherent `## Prod` block; before merging,
  state the configured deploy trigger and expected outcome. After merge, report
  the configured target and its actual known state. Do not claim a deployment
  is running or live unless the configured trigger and observed evidence prove
  it; keep unknown timing explicit.
<!-- readiness:end -->

## Content route — durable content without a worktree

**Explicit invocation only, never a fallback from the flow above.** Use it when `$wrapup` or `/wrapup` runs in the **main checkout on a protected branch** and the session produced durable content — a decision record, a glossary update, a research note — with no worktree and no slice. A session that has a worktree always takes the flow above. Authorization is unchanged: the user's direct invocation, nothing else.

### C1 · Infer (read-only)
```bash
python3 scripts/wrapup-land.py content-claim
```
Reports every dirty path that could be durable content, each with the blob hash it carries **right now**, plus `unclaimable` — deletions, renames, symlinks, `.env*` — named instead of hidden. Ignored paths are scratch and never appear. A dirty tree too large to reason about stops with a bounded summary (count plus top directories), never a path dump.

### C2 · Claim (the one gate — agent judgment)
Show the candidates and let the **user confirm an explicit file list**. Inference proposes; the claim decides. Write exactly the confirmed records — `path` and `oid` copied verbatim — to a claim file:
```json
{"claimed": [{"path": "docs/decisions/lifecycle.md", "oid": "<from content-claim>"}]}
```

### C3 · Land
```bash
python3 scripts/wrapup-land.py content-commit --claim-file /tmp/wrapup-claim.json \
  -m "<commit message>" --type "<branch type>" --slug "<slug>" [--anchor <n>] [--body-file <body>]
```
The branch name comes from the profile's content branch template (issue-less by construction — a planning session has no issue number); the type is one of the profile's own branch prefixes. One call covers: re-read every claimed path (a path whose content moved since the claim is **dropped and named** in the report, the rest still lands; every claimed path gone → STOP) → `.env*` hard block plus the ordinary secret scan on exactly the diff to be committed → stage the claim into a private index and verify the resulting tree by name **and** object id → collision-check the branch locally **and** on the remote → commit → return the main checkout to the protected branch.

Everything not in the claim is a bystander and is never read, staged, or written — including changes the user had already staged. The route has no wholesale staging step to widen, so the ordinary dirty-tree commit cannot be reached from here at all. It never closes an anchor: `--anchor` renders the board profile's `prMarkers.partOf` reference, and a `--body-file` that declares a close keyword is refused. There is no teardown half — no worktree to remove, no branch to retire.

Then land it like any other branch: `land --branch <branch> --title … --body-file …` finds no worktree and tears nothing down.

STOPs name their cause and force nothing: a claimed `.env*` or ignored path, a claim whose every path drifted, a secret in the claimed content, a branch that already exists locally or on the remote, and a **blocked return switch** — a conflicting checkout leaves the main checkout on the content branch and says so; the content is safe in the commit, and nothing is stashed or forced.

## Out of scope
- Live-verify / DoD: must happen **before** `$wrapup` or `/wrapup` — this skill lands, it does not verify.
- Other worktrees / their servers stay untouched.
