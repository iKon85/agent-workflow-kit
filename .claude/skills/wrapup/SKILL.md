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
  it already exists. User-triggered only (never auto-invoke, never hook). Aborts
  hard only on: not in a feature worktree, a detected .env/secret, a rejected
  push, a conflicting PR, terminal red checks, or checks still pending after
  the bounded wait budget.
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
Hard stop (the only pure precondition): not in a feature worktree / on `main` — the script exits 1. The report carries everything the later steps need: dirty files, `.env` hits, secret-grep hits, issue + parent (leaf vs. anchor slice), existing PR + whether its body has a `**Retro:**` line, parsed `ANNAHMEN.md` drift lines, profile values (`retro_values`, `vor_bau`, remote-sweep switch).

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
One call covers: push → PR create/reuse (+ drift markers merged into the body) → `pr-body-check.py` gate (exit 1 = STOP, exit 2 = fail-open warning) → merge gate (pending/null-conclusion checks poll for up to 20 minutes with progress on stderr; terminal red / `CONFLICTING` / timeout = STOP; known zero-step billing or runner failures are named `infrastructure failure`; an already-`MERGED` PR resumes at teardown) → **merge** (`--merge` + `--delete-branch`, verified `MERGED`) → dev-server kill (`.dev-ports` ports + cwd-under-worktree walk, own shell ancestry excluded) → worktree remove (no `--force`; refusal = STOP, check surviving processes first) → main `--ff-only` pull + `branch -d` → issue-close verify (auto-close misses are closed manually) → local merged-branch sweep (`-d` only — squash/rebase-merged branches stay a manual call by design) → remote merged-PR sweep (opt-in `wrapup.remoteBranchSweep` in the board profile; PR-status-authoritative via `ls-remote`; deleted remote branches are restorable from the PR page) → anchor-sync (dry-run diff in the report) + anchor completeness check + `execute-ready-check --mode audit` → **upward propagation:** if the anchor's native parent is a Program-PRD, `program-sync` refreshes its Wellenplan (Status + Issue cells) and checks off mechanically completed Phasen-Gates — the slice event is visible at the program level, not only in the wave (`program_sync` block in the report; skipped when the parent isn't a program).

STOP → diagnose in the main conversation, fix, re-run `land` (an already-merged PR resumes at teardown).

Before merge, the committed worktree policy only nominates exact landing
evidence. After merge, cleanup reloads `docs/agents/workflow-capabilities.json`
from canonical `origin/main`; only the identical merged, attempt-bound scratch
and generator policy authorizes each evidence path and deletion. A mismatch is
a hard STOP that preserves every file—never bypass it with the unmerged branch
profile.

Landing provenance has one explicit relinquish route. If the STOP names an
unfinished or drifted landing attempt and the ambiguous files cannot be restored
to their frozen identities, run:

```bash
python3 scripts/wrapup-land.py land --branch "<branch>" --abandon-unfinished-attempt
```

This archives the started or frozen attempt receipt only. It deletes and claims
no files, works even when the older creation baseline is missing, and returns
before push, PR, or merge. The next `land` conservatively protects every current
matching path; classify or move those blockers first. Do not use relinquish for
an exact unchanged frozen attempt: a normal retry validates that evidence and
resumes deterministically.

An attempt journaled under the superseded v1 contract is **legacy, not
corruption**. The STOP says so explicitly and names the same
`--abandon-unfinished-attempt` archive route; archival stays valid for a v1 and
a v2 receipt even without a creation baseline or a local main profile, and no
generated or consumer file is deleted or claimed on that route.

### 6 · Post-merge (agent)
- **Sibling propagation:** for each `drift_markers` entry in the land report, append the note to the target issue's `vor_bau` section + re-stamp its `plan_revision`. Log-based markers → **write directly, then show what was written where** (mandatory report — visibility moved from a pre-gate into the report, decision 2026-07-06); fallback candidates the user hasn't confirmed yet → confirm first. Program context widens the target set to unbuilt wave-stubs/leaves and the Program-PRD itself — same append-only mechanism. **Exception:** appends to the Program-PRD or unbuilt wave-stubs do **not** re-stamp `plan_revision` — that stays reserved for structural wave-plan edits via the `to-waves` escalation path; a mere drift note must not stale-block published stubs.
- **Anchor close:** report says `anchor_complete: true` → `gh issue close <anchor> -c "Wave complete — all slices merged via PR #<pr>."` and verify board status Done. The guard keeps anchors away from every auto-close — this verified close is the only close path; without it the anchor stays silently open after the last slice. **Then re-run the upward propagation**: the land-time `program-sync` ran BEFORE this close, so on a wave-completing slice the Wellenplan still shows 🔄 and the Phasen-Gate stays unchecked — after the board shows Done, run `python3 scripts/board-sync.py program-sync <program-prd#>` once more (the report's `program_sync.program` names it; skip when the report says the parent is not a program). Board auto-rules can lag the close (Close→Done race) — verify Done first, that's what the token reads.
- **Report**, concise, from the land JSON: PR merged · issue close (auto/manual) · worktree removed · branch deleted · sweep counts local/remote · anchor synced + complete/pending · program propagation (`program_sync`: Wellenplan refreshed / gates checked / skipped) · propagation writes (what → where) · `main` at `<sha>`.

<!-- readiness:block deployReport -->
- **Deploy-aware report:** read the coherent `## Prod` block; before merging,
  state the configured deploy trigger and expected outcome. After merge, report
  the configured target and its actual known state. Do not claim a deployment
  is running or live unless the configured trigger and observed evidence prove
  it; keep unknown timing explicit.
<!-- readiness:end -->

## Out of scope
- Live-verify / DoD: must happen **before** `$wrapup` or `/wrapup` — this skill lands, it does not verify.
- Other worktrees / their servers stay untouched.
