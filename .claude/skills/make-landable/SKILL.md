---
name: make-landable
disable-model-invocation: true
description: >-
  Use ONLY when the user directly types $make-landable or /make-landable. Post-implement
  "make it landable" for a finished feature/fix worktree — runs the repo's local CI gate,
  judges the secret scan, commits the dirty tree, and authors the PR body with its
  close/part-of marker plus the build's assumption-drift markers, leaving a branch that
  $land pushes and merges unchanged. The same route covers a session with no worktree and
  no slice: durable content dirty in the main checkout — a decision record, a glossary
  update, a research note — is committed onto an issue-less branch through one confirmed,
  hash-verified file claim, bystanders untouched. It never pushes, never merges, never
  tears anything down. User-triggered only (never auto-invoke, never hook). Aborts hard
  only on: the worktree flow on the main checkout or a protected branch, a detached or
  unborn HEAD, a detected .env/secret, a red local CI gate, or a claim whose every path
  drifted.
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill make-landable --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# make-landable — gate, commit & author the PR body

Trigger: user makes a direct `$make-landable` or `/make-landable` invocation. **Manual only** — `disable-model-invocation: true`, no hook, no auto-invoke.

One route, one outcome: **a branch that is ready to land.** The work has just been implemented and the user has not accepted it yet, so this skill stops before the remote. Pushing, the pull request, the merge, and every teardown belong to `$land`.

## ⚠ Spec context

The user's direct `$make-landable` or `/make-landable` input IS the explicit commit authorization for that run.
It authorizes the guarded commit and the PR-body draft, and **nothing beyond the local repository**:
it never pushes, never opens or merges a pull request, and never authorizes the agent to invent or configure a deploy target. Never call
this skill from a hook or another skill. Natural-language requests, indirect skill
chaining, and autonomous invocation do not authorize it. The pre-flight hard stops are non-negotiable.

## Execution model — script does mechanics, the agent does judgment

All enumerable git plumbing lives in **`scripts/wrapup-land.py`** (`preflight` / `commit` / `content-claim` / `content-commit`, JSON report on stdout, exit 1 = STOP with reason in the JSON) — the same executor `$land` finishes the run with.

The agent keeps: the local CI verdict, secret review, commit message, PR body text, drift-fallback candidates, the content claim — plus **diagnosis whenever the script STOPs**. On any STOP: fix the named cause, re-run (the script is idempotent). **Force NOTHING** — no `--force`, no `-D`, no `--no-verify`.

## Flow

### 1 · Pre-flight
Run **in the worktree**:
```bash
python3 scripts/wrapup-land.py preflight
```
Hard stop (the only pure preconditions): the main checkout, a protected branch, a detached HEAD, or an unborn branch — the script exits 1 and names which. Attaching a branch resolves a detached HEAD; the first commit resolves an unborn one. Any other born, attached worktree qualifies, whatever its name or location. The report carries everything the later steps need: dirty files, `.env` hits, secret-grep hits, issue + parent (leaf vs. anchor slice), existing PR, parsed `ANNAHMEN.md` drift lines, profile values.

A session that has **no worktree and no slice** but produced durable content in the main checkout takes the durable-content mechanism in step 4 instead. The session's shape decides that, and the user's explicit file claim confirms it — it is **never** a fallback the agent reaches for after the worktree pre-flight stopped.

### 2 · Local CI gate
Run the repository's own pre-PR gate — invoke the `local-ci` skill, which reads the project's recipe. Terminal red = STOP: fix the cause and re-run. There is no `--no-verify` and no "the hook will catch it later"; the gate exists so the pull request `$land` opens is green before anyone waits on it. A project that has configured no recipe cannot be gated: say so in one note and continue — a missing recipe is a gap to fill with `/setup-workflow`, not a red.

### 3 · Retro (voluntary — never a gate)
This skill asks **no** retro question and waits on **no** retro answer. `/retro`
stays a standing offer the user takes when they want it: if they ask for one
before the commit, invoke the `retro` skill (model-invocable, non-deploying, every
mutation keeps its own approval gate) — otherwise continue straight to the
commit. Findings from a retro run here belong in the PR body's Meta section
(step 5). No marker records it, and no second invocation is
required — measured over 135 landings, the former binding duty produced its
promised artifact exactly once. A retro after the merge is a normal `/retro` run
of its own.

General chaining rule: automatically chain only into a **model-invocable**,
**non-deploying** workflow. If the named target is user-only, deploys, or
depends on an external action, **return control to the user** and **state the
reason**. A forward chain never carries this run's authorization into another run.

### 4 · Commit (only if the tree is dirty)
Judgment first, then the guarded commit:
- **Secret review:** judge the preflight `secret_hits` — a variable *named* `token` isn't a secret; a real key → resolve first, never commit. `.env` files are a mechanical hard block inside the script.
- **Commit message:** conventional, `<type>(<scope>): <summary> (#<issue>)` — type from the branch prefix, summary from the actual diff, issue from the branch.
```bash
python3 scripts/wrapup-land.py commit -m "<message>"   # --allow-matches only after judging every hit a false positive
```
STOP on hook failure: many `Cannot find module`/TS2307 across **unrelated** files in a node/pnpm repo = stale worktree `node_modules` → `pnpm install --frozen-lockfile`, re-run. Real errors in slice files = legitimate stop. **Never `--no-verify`.**

**Durable content instead of a slice** — the same step, a different mechanism, because there is nothing to infer from a branch:

```bash
python3 scripts/wrapup-land.py content-claim
```
reports every dirty path that could be durable content, each with the blob hash it carries **right now**, plus `unclaimable` — deletions, renames, symlinks, `.env*` — named instead of hidden. Ignored paths are scratch and never appear. A dirty tree too large to reason about stops with a bounded summary (count plus top directories), never a path dump.

**The claim is the one gate — agent judgment.** Show the candidates and let the **user confirm an explicit file list**. Inference proposes; the claim decides. Write exactly the confirmed records — `path` and `oid` copied verbatim — to a claim file:
```json
{"claimed": [{"path": "docs/decisions/lifecycle.md", "oid": "<from content-claim>"}]}
```
```bash
python3 scripts/wrapup-land.py content-commit --claim-file /tmp/landing-claim.json \
  -m "<commit message>" --type "<branch type>" --slug "<slug>" [--anchor <n>] [--body-file <body>]
```
The branch name comes from the profile's content branch template (issue-less by construction — a planning session has no issue number); the type is one of the profile's own branch prefixes. One call covers: re-read every claimed path (a path whose content moved since the claim is **dropped and named** in the report, the rest still lands; every claimed path gone → STOP) → `.env*` hard block plus the ordinary secret scan on exactly the diff to be committed → stage the claim into a private index and verify the resulting tree by name **and** object id → collision-check the branch locally **and** on the remote → commit → return the main checkout to the protected branch.

Everything not in the claim is a bystander and is never read, staged, or written — including changes the user had already staged. This mechanism has no wholesale staging step to widen, so the ordinary dirty-tree commit cannot be reached from here at all. It never closes an anchor: `--anchor` renders the board profile's `prMarkers.partOf` reference, and a `--body-file` that declares a close keyword is refused.

STOPs name their cause and force nothing: a claimed `.env*` or ignored path, a claim whose every path drifted, a secret in the claimed content, a branch that already exists locally or on the remote, and a **blocked return switch** — a conflicting checkout leaves the main checkout on the content branch and says so; the content is safe in the commit, and nothing is stashed or forced.

### 5 · Author the PR body (agent-written, script-checked)
Write title + body to a temp file (inline bodies with backticks crash bash) and hand both to `$land`, which creates or reuses the pull request with exactly this body and then runs the mechanical `pr-body-check.py` gate on it:
- Leaf issue → `closes #<n>`, **never inside backticks** (GitHub ignores the keyword there). Wave/cluster slice → `Part of #<anchor>`, **never `closes`** (would close the anchor early).
- **Assumption drift:** the build-time log `ANNAHMEN.md` is explicitly captured content — its well-formed lines become `annahme-drift` markers **mechanically, no confirmation gate** (`$land` merges them into the body; decision 2026-07-06, replaced the old propose+confirm for log entries). Two cases stay with the agent:
  - **Malformed line** (no `#<n>` target) → clarify with the user (fix the target or discard deliberately), never drop silently; `$land`'s `--skip-malformed-drift` only for a deliberately discarded rest.
  - **No log / empty log** → fallback, retro-style: walk the slice's deliberately made or reversed assumptions yourself and present **named candidates** (`- #<n>?: <assumption> → might carry <issue>`); user confirms → write the markers into the body by hand. Zero candidates → say so explicitly ("no drift found — checked: <what>"). The log is the floor, not the ceiling — drift noticed while preparing goes in the same way.

### 6 · Report and hand over
Concise: local CI verdict · commit sha and message · branch · issue + parent (leaf or wave slice) · the body file's path · drift markers written and any unconfirmed fallback candidate still open. Name `$land` as the next step and stop there — it is user-invoked only, and this run's authorization never becomes its authorization.

## Out of scope
- Push, pull request, merge, teardown, board reconcile: `$land` owns all of them, on the user's separate invocation.
- Live-verify / DoD: must happen **before** the landing pair — this skill prepares, it does not verify.
- Other worktrees / their servers stay untouched.
