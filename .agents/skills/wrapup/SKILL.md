---
name: wrapup
disable-model-invocation: true
"description": "Use ONLY when the user types /wrapup. Session-end \"land & clean\" for a finished feature/fix worktree — merges the open PR (= triggers prod deploy), kills the worktree dev server, removes the worktree + local branch, and fast-forwards the main checkout so main is current again, then sweeps merged-branch leftovers (local + stale remote whose PR is merged). If the slice isn't landed yet, it first makes it landable (Step 0): commits a dirty tree (after an .env/secret check), pushes, and opens the PR — reusing one if it already exists. User-triggered only (never auto-invoke, never hook). Aborts hard only on: not in a feature worktree, a detected .env/secret, a rejected push, a conflicting PR, or red (FAILURE) checks."
---

# wrapup — land PR & tear down worktree

Trigger: user types `/wrapup` (optionally with a PR number, e.g. `/wrapup 697`). **Manual only** — `disable-model-invocation: true`, no hook, no auto-invoke.

## What this skill does

Closes out a finished slice session: **make the state landable (Step 0: commit → push → create/reuse PR)** → merge the open PR → kill the worktree's dev server → tear down the worktree + local branch → fast-forward the main checkout. Saves retyping the closing sequence. If the slice is already committed/pushed/has a PR, Step 0 is a no-op (never aborts because of that).

## ⚠ Spec context (read, don't skip)

**Merging to `main` = prod deploy** (your deploy platform webhook, ~7 min live). CLAUDE.md: *"Claude never deploys on its own — merge+deploy is <maintainer>'s call."* This skill **does not violate that**, because **<maintainer> triggers it himself** — the `/wrapup` invocation IS the explicit merge+deploy authorization for that run. So: **never** call this skill from a hook, another skill, or autonomously. Only on a direct `/wrapup` input.

Always show the deploy banner **before** the merge (Step 3). No y/n confirmation (deliberate choice) — but the pre-flight hard stops are non-negotiable.

<!-- mirror-xform:start codex-wrapup-execution-model -->
## Execution model — 3 phases (recommended: mechanical part in the worker subagent)

**Why recommended:** `wrapup` is **multi-turn interactive** (retro gate, assumption-drift confirmation). All user gates **and** the secret review stay in the **main thread** (= the session model <maintainer> chose); **recommended** is handing the mechanical git/gh plumbing afterward to a Codex worker subagent. For this pure mechanics block, use `spawn_agent` with `agent_type: worker`, `model: gpt-5.4-mini`, `reasoning_effort: low`; never delegate security judgment or approvals.

**Condition — not a hard contract:** this 3-phase split only pays off **if your harness supports real subagent dispatch with a model param** (here: `spawn_agent` + `model`/`reasoning_effort`). **If your harness can't** → **everything runs inline in the main thread**: phases 1+2+3 in one pass, same steps, same order, same gates — just without the phase switch. The **STOP-back rule is unaffected by this and stays exactly as sharp** (see below): abort on every hard stop, force NOTHING, report the reason explicitly — inline that means the main thread halts at the same point instead of continuing.

| Phase | Who | Content |
|---|---|---|
| **1 — prep + gates** | **Main thread** (session model) | Pre-flight · retro-exit gate · **Step 0a commit incl. secret review** (security judgment stays here) · **Step 0c.2 assumption-drift propose+confirm**. Collects: `**Retro:**` line text, confirmed `annahme-drift` marker blocks, conventional title/commit context. |
| **2 — mechanics** | **Codex worker subagent** (dispatch, recommended — otherwise main thread inline) | Step 0b push · Step 0c create/reuse PR (body with retro line + markers + `closes`/`Part of`) → `pr-body-check` → merge gate · **Step 1 merge (= deploy)** · Step 2 kill dev server · Step 4 remove worktree · Step 5 main FF + `branch -d` · Step 5b issue close · Step 5c/5d branch sweep · Step 5e.1 anchor tick. Pure git/gh mechanics block, mechanically verifiable. |
| **3 — post-merge gates + report** | **Main thread** (session model) | Step 3 deploy banner · **Step 5e.2 sibling propagation propose+confirm+write** · Step 6 report. |

**Dispatch contract (phase 1 → phase 2, only if your harness can do subagent dispatch with a model param):** once phase 1 is green (all gates answered, commit is local), dispatch **one** subagent — `spawn_agent` with `agent_type: worker`, `model: gpt-5.4-mini`, `reasoning_effort: low`. Prompt hands over **all** values collected in phase 1:
- `WT`, `MAIN_TREE`, `BRANCH`, `ISSUE`, anchor number (if `Part of #<anchor>`) resp. leaf flag
- the **finished PR body text** (retro line + confirmed `annahme-drift` markers + `closes`/`Part of`) and the conventional title
- task: execute Step 0b→5e.1 **mechanically** (keep the steps' cwd discipline: 0b in `$WT`, from Step 1 on `cd "$MAIN_TREE"`).

**Subagent return (concise, structured) — on inline fallback the main thread records the same values itself at the end of phase 2:** PR # · `state == MERGED`? · `pr-body-check` exit · sweep counts (5c local / 5d remote) · anchor-tick result (ticked `✅ #<PR>` / propose-pending) · **`anchor-complete: yes/no`** (all slice rows ✅? — phase 3 closes the anchor on yes, Step 5e.1b) · the parsed `annahme-drift` markers (for phase-3 Step 5e.2) · main SHA · **every STOP** with reason.

**STOP-back rule (non-negotiable):** if the subagent hits **any** hard stop (push rejected · `pr-body-check` exit 1 · merge gate `CONFLICTING`/red check · merge not `MERGED` · `worktree remove`/`branch -d` refused · **any secret-grep hit** in the diff — already committed in phase 1) → **abort, force NOTHING, report back to the main thread** (reason + location). The subagent **does not resolve any security-judgment question itself** and does not ask the user directly — it reports, the main thread decides.

**Merge = prod deploy stays `/wrapup`-triggered:** the `/wrapup` input is the per-run authorization; the main thread dispatching (or executing inline) carries that authorization forward. No auto-/hook trigger.

> The following steps are each tagged `[Phase N]` — that's the **recommended** assignment for subagent dispatch. The main thread executes phases 1 + 3; **everything tagged `[Phase 2]` runs in the Codex worker subagent, provided your harness supports it** — if it can't, the main thread executes those steps **itself, inline**, in the same order, without loosening the gates/rules.
<!-- mirror-xform:end -->

## Pre-flight — hard stops (on ANY fail: abort, report, do NOT merge/delete anything) `[Phase 1 · main thread]`

Determine context:
```bash
WT=$(git rev-parse --show-toplevel)
BRANCH=$(git branch --show-current)
MAIN_TREE=$(git worktree list --porcelain | awk '/^worktree / {print $2; exit}')
```

1. **In the feature worktree?** `WT` ≠ `MAIN_TREE` **and** `BRANCH` ≠ `main`. Otherwise stop (`/wrapup` runs in the finished slice's worktree, not in the main checkout / not on main).
This is the **only** pure precondition. Previously *dirty tree*, *unpushed commits*, and *no open PR* were also hard stops — **no longer**: **Step 0** establishes them (commit → push → create/reuse PR, idempotent), **Step 0c** then checks mergeability.

Remaining hard stops (on each: abort, report, do NOT merge/delete anything):
- not in the feature worktree (#1)
- secret resp. `.env` in the commit diff (Step 0a)
- rejected push (Step 0b)
- PR `CONFLICTING` or check `conclusion` in `FAILURE`/`CANCELLED`/`TIMED_OUT` (Step 0c)

On stop: state precisely *what* blocks and *what* the user needs to do. Not "try to keep going".

## Flow (after a green pre-flight)

### Retro reminder (after pre-flight #1, BEFORE Step 0 — portable backstop, no auto-run) `[Phase 1 · main thread]`
Right after a green pre-flight, **before** Step 0a commits anything: **one** reminder as a **blocking, optional retro-exit gate** — not a merge confirmation.

> "Already ran a retro? **(a)** yes / continue → landing now. **(b)** you want one first → I'll abort **cleanly** here, you run `/retro`, then `/wrapup` again — the **repo-file** patches then travel along in this PR (memory patches stay local)."

- User picks **(b)** → `wrapup` **exits cleanly immediately** (no commit, no merge, no worktree touch). `wrapup` **cannot** pause/resume another skill mid-run → clean exit + re-run instead of a fake pause.
- User picks **(a)** → continue with Step 0a.
- **NEVER** call `/retro` itself (no auto-run / no auto-capture) — only show the reminder.
- **≠ merge y/n:** the "no y/n confirmation" rule (spec context above, l. 19) is about the **merge** confirmation — that stays (deploy banner without y/n). This gate is a **pre-Step-0 retro exit**, **not** a merge authorization. Don't confuse the two.
- **Why in the generic `wrapup`:** in a foreign project there's no project-local "offer `/retro` before PR" convention → `wrapup` is the **only portable** retro touchpoint there. In <project> the answer is usually "already done" (the primary nudge comes from the CLAUDE.md convention after `/tdd`) → no double prompt.
- **Answer → trace (materialization):** the gate answer doesn't vanish — it gets written in **Step 0c** as a mandatory `**Retro:**` line in the PR body, using one of the two `prMarkers.retroValues` values from your board profile (`docs/agents/board-sync.md`; details below in Step 0c; <project> currently `gefahren`/`übersprungen`): retro ran (this or an earlier session of the slice) → first value + findings pointer (`… — findings under ## Retro / Meta-Findings`); deliberately skipped → second value + reason (`… — <reason in <maintainer>'s words>`). That way every merged PR shows whether learning happened. This is **not** a new question and not an auto-run — just recording the answer already given.

### Step 0 — make the state landable (commit → push → PR; idempotent, IN the worktree)
Makes the slice landable **without aborting if everything's already done** (every sub-step is a no-op if there's nothing to do). Still runs **in the worktree** (cwd = `$WT`, branch = `$BRANCH` from pre-flight) — only Step 1 switches to the main tree.

<!-- mirror-xform:start codex-wrapup-phase-labels -->
> **Phase split within Step 0:** 0a (commit + secret review) and the assumption-drift **confirmation** (0c.2) are `[Phase 1 · main thread]`; 0b (push) and the rest of 0c (PR/body/merge-gate) are `[Phase 2 · Codex worker subagent]`. The main thread gathers the inputs in 0a + 0c.2 (commit local, retro line, confirmed markers) and **then** dispatches 0b→5e.1 to the subagent.
<!-- mirror-xform:end -->

**Step 0a — dirty tree → commit.** `[Phase 1 · main thread]` Only if `git status --porcelain` is non-empty.
- **`.env` hard block (mechanical):** `.env`/`.env.*` in the tree → **STOP**, never commit (global rule, non-negotiable). Resolve manually.
- **Secret review (judgment):** review `git diff --cached` before committing — no keys/tokens/passwords/private keys. `grep` is an aid, judgment decides (a variable named `token` ≠ a secret; a real key → `git reset` + stop).
- **Commit message conventional** (`<type>(<scope>): <short summary> (#<issue>)`): type from the branch prefix, summary from the **actual diff** (not just the branch slug), issue number from the branch (`feat/<N>-…`).
```bash
if [ -n "$(git status --porcelain)" ]; then
  git status --porcelain | grep -qE '(^|[ /])\.env(\.[^/ ]*)?$' \
    && { echo "STOP: .env in the working tree — do not commit, resolve manually."; exit 1; }
  git add -A
  git diff --cached | grep -niE 'BEGIN [A-Z ]*PRIVATE KEY|(api[_-]?key|secret|password|access[_-]?token|bearer)[[:space:]]*[:=]' \
    && echo "⚠ possible secrets in the diff (above) — check BEFORE committing; false positive (e.g. a variable name) → continue, real secret → git reset + STOP."
  git commit -m "<conventional message from the diff>"
fi
```
**The pre-commit hook (`tsc`+ESLint via `.githooks/`, wired via `core.hooksPath`) fires on commit** — new on this path (previously the user committed before `/wrapup`, the hook ran outside it). If it fails with *many* `Cannot find module`/TS2307 across **unrelated** files (not your slice files) → (node/pnpm repo) the worktree's `node_modules` is missing/stale, **not** a real error: `pnpm install --frozen-lockfile` (warm store, ~seconds), then commit again. **Never `--no-verify`.** Real TS/lint errors in *your* slice files = a legitimate stop → fix, don't bypass.

<!-- mirror-xform:start codex-wrapup-phase-labels -->
**Step 0b — unpushed → push.** `[Phase 2 · Codex worker subagent]` Feature branch → `pre-push` allowed (only `main` is blocked). Sets upstream idempotently:
<!-- mirror-xform:end -->
```bash
git push -u origin "$BRANCH"     # already pushed & current → no-op; rejected (e.g. diverged) → STOP + report reason
```

<!-- mirror-xform:start codex-wrapup-phase-labels -->
**Step 0c — ensure PR + merge gate.** `[Phase 2 · Codex worker subagent — EXCEPT 0c.2 drift confirmation = phase 1]` **Reuse** an existing PR (no abort!), otherwise create one; then check mergeability. The subagent gets the **finished** body text (retro line + confirmed markers) from phase 1 and only writes it — the marker confirmation (0c.2) was already done by the main thread **before** dispatch.
<!-- mirror-xform:end -->
```bash
PR=$(gh pr view "$BRANCH" --json number -q .number 2>/dev/null || true)
if [ -z "$PR" ]; then
  # write the body to /tmp (gh --body-file is mandatory: inline backticks/parens crash bash)
  #   leaf issue:          "closes #<n>"        (NEVER in backticks → auto-close won't fire otherwise, see Step 5b)
  #   wave/cluster slice:  "Part of #<anchor>"  (NEVER "closes" → would close the anchor prematurely)
  gh pr create --base main --head "$BRANCH" --title "<conventional title>" --body-file /tmp/wrapup-pr-body.md
  PR=$(gh pr view "$BRANCH" --json number -q .number)
  echo "Step 0c: PR #$PR newly created"
else
  echo "Step 0c: PR #$PR already exists — reused"
fi
gh pr view "$PR" --json state,mergeable,mergeStateStatus,statusCheckRollup
```
- Title = conventional (like the commit). Issue number from the branch. Body convention strictly as in the comment (leaf → `closes`, anchor slice → `Part of`).
- **Mandatory `**Retro:**` line in the body (materializing the retro reminder):** when writing the body, include **exactly one** of these lines, depending on the gate answer — the word right after the marker is one of the two `prMarkers.retroValues` values from your board profile (`docs/agents/board-sync.md`, `board-sync:profile` JSON block; `pr-body-check.py`'s `RETRO_RE` checks exactly against this list; <project> profile currently `gefahren`/`übersprungen`):
  - retro ran (this or an earlier session of the slice) → `**Retro:** <retroValues[0]> — findings under ## Retro / Meta-Findings`
  - deliberately skipped → `**Retro:** <retroValues[1]> — <reason in <maintainer>'s words>`

  Exact format: `**Retro:**` prefix, then one of the two `prMarkers.retroValues` words, then ` — ` + reason (with a space after the marker — `**Retro:**<value>` without a space gets rejected by the check). **Closed set: ONLY the two words configured in the profile, copy verbatim — never phrase freely.** Any other variant (e.g. "not offered", "n/a") is rejected by `pr-body-check.py` → unnecessary rework. "Nothing to retro" (meta/config session without a feature slice) is **not** a third state — it's the second `retroValues` value + `<reason>` (e.g. "meta/config session, no slice retro"). **Applies to EVERY PR body creation — including ad-hoc mid-session** (`gh pr create` outside this Step 0c): same two forms verbatim, otherwise the check catches them and you rework it. No auto-run of `/retro` — just recording the answer.
  - **Reuse path (PR already existed):** the existing body may lack the line. **Add it proactively** — if the `**Retro:**` line is missing from the reused body, insert it via `gh pr edit "$PR" --body-file <updated body>` **before** the body-convention check runs (don't rely on its exit 1 + manual fix — the slice-7/8 gap).
- **Assumption-drift self-check (before merge —) — BEFORE the body check `[0c.2 · phase 1 · main thread]`:** the **confirmation** of the markers is done by the **main thread before dispatch** (user gate — a subagent can't get confirmation). **Writing** the confirmed markers into the body + the body check then happen in phase 2: write the markers into the body first (see below), THEN run the body-convention check, so it sees the **final** body (R2-F4). Source = the **build-time log** `ANNAHMEN.md` (worktree root, gitignored), kept live by wave-slice sessions (captured while context is fresh instead of from memory at session end; convention: CLAUDE.md cross-slice writeback + `tdd` checklist). **Q3-compliant: no code/diff scan, no heuristic — the log IS explicitly stated content, just captured earlier.** The log is the **floor, not the ceiling**: if drift shows up while landing that's **not** in the log, bring it in the same retro-style way (see fallback) instead of skipping it.
  - **Log present + non-empty** → build one `annahme-drift` marker proposal per line and show it to the user for **confirmation** (write to the PR body only after OK — session notes vanish after merge+worktree removal, only the PR body survives for Step 5e). Line format `- #<n>: <text>` (optionally `- #<n> §<section>: <text>`); build markers from it with defaults `section="Vor Bau zu klären"` (= `headings.vorBau` from the board profile), `op="append"` — JSON payload in an HTML comment (survives quotes/newlines/`-->`):
    ```
    <!-- annahme-drift: {"target":"","section":"Vor Bau zu klären","op":"append","text":"retro seam unified in 1g — check before the split"} --> <!-- portability-lint: ok -->
    ```
  - **Line without a `#<n>` target (malformed)** → **warn + clarify in the walkthrough** (add the target or deliberately discard the entry), **never silently drop** (mirror of "silent writes forbidden", Step 5e).
  - **Log missing/empty** (or a non-wave slice without a log) → **fallback, retro-style: I bring my own candidates first, I don't ask blank.** Like `/retro` (the user provides direction + approval, not the implementation detail — they usually don't know it, I built it): go through the assumptions **deliberately made or reversed** in the slice that might carry an **unbuilt** sibling issue, and present them as **named candidates** — each `- #<n>?: <assumption> → might carry <issue/contract>`. The user confirms / rejects / prioritizes; confirmed ones → markers as above, by hand. **Zero** candidates → **say so explicitly** ("no drift found — checked: <brief, what was touched>"), only then optionally the one-line safety net *"anything overlooked that carries an unbuilt issue?"*. The blank question is **never** a substitute for going through it yourself.
  - No marker → nothing propagated (a forgotten drift gets caught by the drift guard at the next handoff).
- **Body-convention check (mechanical) — after the retro line + assumption-drift markers, against the final body:** the script checks the `closes`-vs-`Part of` rule (anchor guard) + the mandatory `**Retro:**` line against the **real PR body**. It **does not parse `annahme-drift` markers** (their validation is deliberately not mechanized/R2-F6) — that's why the marker writes run first. Issue number from the branch, parent via `board-sync.py parent-of`.
  ```bash
  python3 scripts/pr-body-check.py --branch "$BRANCH"
  ```
  - **Exit 0** → green, continue to the merge gate.
  - **Exit 1** → **STOP**: fix the reported violations in the body (`gh pr edit "$PR" --body-file <fixed body>`), then run the script **again** until exit 0. **Never** merge with a red check.
  - **Exit 2** → warning only (no issue from the branch / no PR body retrievable), **no block** (fail-open).
- **Merge gate** (the former pre-flight #4 check, now **after** creating the PR):
  - `state == OPEN` and **no** check with `conclusion` in `FAILURE`/`CANCELLED`/`TIMED_OUT` → otherwise **STOP** (name the red checks).
  - `mergeable == CONFLICTING` → **STOP** (merge conflict; rebase/resolve the branch).
  - `mergeable == UNKNOWN` (freshly created PR — GitHub computes mergeability async) → **no stop**: the merge attempt in Step 1 is the real gate (Step 1 verifies `state == MERGED` and otherwise stops).

<!-- mirror-xform:start codex-wrapup-phase-labels -->
### Step 1 — merge the PR (= prod deploy) `[Phase 2 · Codex worker subagent]`
<!-- mirror-xform:end -->
**Body-convention gate (before the merge):** only merge once `pr-body-check.py` (Step 0c) returned **exit 0** — it mechanically covers the mandatory `**Retro:**` line (one of the `prMarkers.retroValues` values + reason) **and** the `closes`-vs-`Part of` anchor rule. On exit 1, fix the body first (`gh pr edit "$PR" --body-file <fixed body>`) and re-check, **don't** merge blind. (An existing PR without a `**Retro:**` line falls into this STOP too.)

**Important:** `gh pr merge` internally does `git checkout main` — that fails if `main` is checked out in the feature worktree. So **always switch to the main tree first**:
```bash
cd "$MAIN_TREE"
gh pr merge "$PR" --merge --delete-branch
```
- `--merge` = merge commit (repo convention, see `git log` on main).
- `--delete-branch` removes the **remote** branch. `gh` doesn't delete the local branch while it's checked out in the worktree — Step 4 does that.
- Then verify: `gh pr view "$PR" --json state -q .state` == `MERGED`. Not MERGED → stop, do NOT run the rest.
- An "already merged" message + `state == MERGED` → OK (the remote merge went through, only the local follow-up steps were missing) → continue.

<!-- mirror-xform:start codex-wrapup-phase-labels -->
### Step 2 — kill the worktree's dev server (BEFORE tearing down the worktree!) `[Phase 2 · Codex worker subagent]`
<!-- mirror-xform:end -->
Ordering trap: a running process holds the dir + ports → `git worktree remove` otherwise fails.
**cwd trap:** the kill loop below matches processes by cwd-under-WT — if the shell itself is running in the WT
(e.g. the "PR already merged" path, where Step 1's `cd "$MAIN_TREE"` gets skipped), it kills its own
shell ancestor → exit 144, the loop aborts, a stray process remains. So switch to the main tree FIRST.
```bash
cd "$MAIN_TREE"   # out of the worktree — otherwise the cwd filter below hits the shell itself
# read ports from .dev-ports (separate source line, not chained with &&)
VITE_DEV_PORT="" BACKEND_PORT=""
[ -f "$WT/.dev-ports" ] && source "$WT/.dev-ports" 2>/dev/null || true

# a) kill listeners on the offset ports (front + back)
for p in "${VITE_DEV_PORT:-}" "${BACKEND_PORT:-}"; do
  [ -n "$p" ] && lsof -ti:"$p" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
done
# b) [node/pnpm-stack specific — other runtimes: adjust the process list] kill processes whose cwd is UNDER the worktree
#    (catches the pnpm-dev parent + tsc-watch, which hold no port but hold the dir)
while IFS= read -r pid; do
  cwd=$(readlink -f /proc/"$pid"/cwd 2>/dev/null) || continue
  case "$cwd" in "$WT"*) kill "$pid" 2>/dev/null || true;; esac
done < <(pgrep -f 'tsx|vite|tsc|pnpm|node' 2>/dev/null)
```
If the server was started as a background task in THIS session, also stop it via `TaskStop` (task ID from the session history).

### Step 3 — deploy banner `[Phase 3 · main thread]`
The main thread prints the banner from the subagent report (the subagent merged in Step 1). One line, e.g.:
> ⚠ PR #`$PR` merged → your deploy platform deploys `main` (~7 min live: <your-app-domain>).

<!-- mirror-xform:start codex-wrapup-phase-labels -->
### Step 4 — tear down the worktree (FROM the main tree) `[Phase 2 · Codex worker subagent]`
<!-- mirror-xform:end -->
`git worktree remove` must not run from the worktree being removed → switch to the main tree first. **Step 5** deletes the local branch (after the main update — `-d` refuses before that, see there).
```bash
cd "$MAIN_TREE"
git worktree remove "$WT"          # tree is clean (Step 0a committed) → no --force needed
git worktree prune
git fetch origin --prune
```
- If `git worktree remove` fails ("contains modified or untracked files" / "is locked") → **don't** blindly `--force`: first check whether Step 2 really terminated all processes (`lsof`, `pgrep`), otherwise real files might get lost. Report the cause instead of forcing.

<!-- mirror-xform:start codex-wrapup-phase-labels -->
### Step 5 — update main + delete the local branch `[Phase 2 · Codex worker subagent]`
<!-- mirror-xform:end -->
```bash
cd "$MAIN_TREE"
git checkout main 2>/dev/null || true   # usually already on main
git pull --ff-only
git branch -d "$BRANCH"                  # AFTER the ff pull — only now is the merge commit reachable from main
```
`--ff-only`: no push, doesn't touch branch protection (pre-push). No fast-forward possible → report (a diverged main is an anomaly, investigate).
- **`git branch -d "$BRANCH"` belongs AFTER the pull** (not in Step 4): before that, the merge commit isn't yet reachable from `main` + the remote upstream is already pruned → `-d` refuses "not fully merged" and suggests the hook-blocked, forbidden `-D`. `-d` always works after the pull; if it still fails → report, **never** `-D`.

<!-- mirror-xform:start codex-wrapup-phase-labels -->
### Step 5b — verify issue close (catch auto-close misses) `[Phase 2 · Codex worker subagent]`
<!-- mirror-xform:end -->
GitHub only closes the `closes #<n>` issue on merge if the keyword is not inside backticks/a code span — otherwise the issue silently stays open. So verify hard, don't trust it. The issue number comes from the branch (`feat/<N>-…`).
```bash
ISSUE=$(echo "$BRANCH" | sed -E 's#^(feat|fix|chore|docs)/([0-9]+)-.*#\2#')
if [[ "$ISSUE" =~ ^[0-9]+$ ]]; then              # bash regex, not grep (rtk-alias trap)
  state=$(gh issue view "$ISSUE" --json state -q .state 2>/dev/null)
  if [ "$state" = "OPEN" ]; then
    gh issue close "$ISSUE" -c "Merged via PR #$PR — auto-close didn't fire (keyword possibly in backticks); closed manually."
    echo "Step 5b: #$ISSUE was OPEN despite the merge → closed manually"
  else
    echo "Step 5b: #$ISSUE already $state ✓"
  fi
else
  echo "Step 5b: no issue number in the branch — skipped"
fi
```
**Preventively** also: never write `closes #<#>` in the PR body inside backticks/a code span (otherwise GitHub ignores the keyword — exactly the miss this step catches).

<!-- mirror-xform:start codex-wrapup-phase-labels -->
### Step 5c — sweep orphaned merged branches (local stragglers) `[Phase 2 · Codex worker subagent]`
<!-- mirror-xform:end -->
Step 4 deletes **only** this slice's branch. Over time, local branches whose PR was merged long ago pile up (manual merges, old states from before this skill, other sessions). Do one safe sweep after the main update — **exclusively `-d`** (only deletes what's reachable from `main`; refuses anything else, including branches checked out in other worktrees):
```bash
cd "$MAIN_TREE"
for b in $(git branch --merged main --format='%(refname:short)'); do   # grep-free (rtk-alias trap, see 5b)
  [ "$b" = "main" ] && continue
  git branch -d "$b" 2>/dev/null && echo "  swept: $b"
done
```
- **Never `-D`** (hook-blocked, hard rule). The sweep is doubly guarded by `--merged main` **and** `-d` — by definition it can't hit anything unmerged.
- **Squash-/rebase-merged** branches aren't reachable from `main` → the sweep **deliberately** leaves them alone (no `-D` bypass). Those stay a manual case-by-case call: verify via `gh pr list --head <b> --state merged`, then the user forces it themselves.
- Covers the merge-commit class (repo default `--merge`) and prevents the branch clutter that motivated this step (2026-06-02, 28 stragglers).

<!-- mirror-xform:start codex-wrapup-phase-labels -->
### Step 5d — sweep orphaned merged branches (REMOTE stragglers) `[Phase 2 · Codex worker subagent]`
<!-- mirror-xform:end -->
`--delete-branch` (Step 1) only deletes the remote branch of *this* slice. Over time, hundreds of remote branches whose PR was merged long ago pile up on `origin` (GitHub's "auto-delete head branches" is off, manual merges, old states). 5c doesn't see those — it only sweeps locally. So sweep the remote stragglers here once, **authoritatively via PR status** (not via `--merged` reachability — that would miss squash/rebase-merged ones, see 5c). Safe set = *remote branch exists* **and** *has a MERGED PR* **and** *has NO open PR* (reuse guard).

**Switch (opt-in):** the actual deletion only runs if `wrapup.remoteBranchSweep` in your board profile (`docs/agents/board-sync.md`, `board-sync:profile` JSON block) is `true` — **default `false`/missing = off** (an automatic remote delete is an unexpected side effect in a foreign project without this convention). The candidate set is **always** determined (read-only, same three filters), whether the switch is on or off:
```bash
cd "$MAIN_TREE"
SWEEP_ON=$(python3 -c "import sys;sys.path.insert(0,'scripts');from board_config import load_board_config as L;print(bool(L().get('wrapup', {}).get('remoteBranchSweep')))" 2>/dev/null)
git fetch origin --prune
gh pr list --state merged --limit 1000 --json headRefName -q '.[].headRefName' | sort -u > /tmp/wrapup-merged.txt
gh pr list --state open   --limit 1000 --json headRefName -q '.[].headRefName' | sort -u > /tmp/wrapup-open.txt
# query real origin heads DIRECTLY — NOT `git branch -r` (local tracking refs; a
# `fetch --prune` can cut the ref while the origin head is still alive → an
# orphaned remote branch gets missed)
git ls-remote --heads origin | sed -n 's#^.*[[:space:]]refs/heads/##p' | sort -u > /tmp/wrapup-remotes.txt
# merged-PR heads ∩ existing origin heads − open-PR heads (comm = grep-free, rtk-alias trap, see 5b/5c)
comm -23 <(comm -12 /tmp/wrapup-merged.txt /tmp/wrapup-remotes.txt) /tmp/wrapup-open.txt > /tmp/wrapup-stale.txt
STALE=()
while IFS= read -r b; do
  [ -z "$b" ] && continue
  [ "$b" = "main" ] && continue          # never delete main (safety net)
  STALE+=("$b")
done < /tmp/wrapup-stale.txt
if [ "$SWEEP_ON" != "True" ]; then
  echo "Step 5d: sweep skipped — ${#STALE[@]} stale remotes, enable via wrapup.remoteBranchSweep"
elif [ "${#STALE[@]}" -gt 0 ]; then
  git push origin --delete "${STALE[@]}" && echo "Step 5d: ${#STALE[@]} remote merged-PR branch(es) deleted"
  git fetch origin --prune               # pull in local remote-tracking refs
else
  echo "Step 5d: no stale remote merged branches"
fi
```
- **Reversible:** an accidentally deleted remote branch can be restored via the GitHub PR page ("Restore branch") — the merge commit keeps the commits regardless. The set is still triple-filtered (MERGED PR + exists + no open PR + never `main`).
- **`--delete-branch` in Step 1 stays** — 5d is the cumulative follow-up sweep, not its replacement; with clean hygiene 5d is usually a no-op.
- **<project> has the switch enabled** (`docs/agents/board-sync.md`) — the first run after introduction swept the backlog in **one** multi-ref push (2026-06-08, 142/145 stale remotes).

### Step 5e — land-reconcile (keep anchor + siblings coherent —) `[5e.1 = phase 2 · 5e.2/5e.3 = phase 3]`
Only applies if the merged issue is a **slice of a wave anchor** (`Part of #<anchor>`). Keeps the rest of the graph execute-ready on the land side. **Phase split:** the tick (5e.1) is a clear-cut one-line flip → runs in the **subagent** (phase 2); the substantive sibling edits (5e.2) are a user gate (propose+confirm) → **main thread** (phase 3), fed from the `annahme-drift` markers the subagent report returns.

<!-- mirror-xform:start codex-wrapup-phase-labels -->
1. **Anchor-tracker sync — `anchor-sync`** `[Phase 2 · Codex worker subagent]`. Instead of a manual tick: `python3 scripts/board-sync.py anchor-sync <anchor#> --dry-run` → review the diff → then write without `--dry-run`. This regenerates the **volatile columns of the slices table from the board** — **status** (`✅ #<PR>` merged · `🔄` open PR/in progress · `⬜` otherwise) and **branch** (actual PR `headRefName`) — **monotonically** (never flips an existing `✅`/`🔄` back if a sub-issue stays open as a `Part of`-gen-a/gen-b without a closing PR) and **drift-free idempotent**. **Stable plan columns** (slice/model/gate/blocked-by) stay **verbatim**; manual annotations like `✅ (gen-a)` survive. **Missing sub-issue rows** (mid-wave splits, the gen-b case) get appended as fresh rows — the output names them (`+N new sub-issue row(s)`); fill their stable cells (slice/gate/model) by hand afterward. `anchor-sync` does **not** manage the **gate symbol** → fix separately if needed. The status column is thus board-derived; the native "sub-issues progress" rollup is the %-secondary view. Replaces the manual tick + Step-6 reminder. Script error / no slice table → **stop + propose**.
<!-- mirror-xform:end -->
1b. **Anchor-complete check (right after the tick)** `[detection phase 2 · close phase 3]`: after the flip, check whether **all** slice rows in the table carry `✅` (no more `⬜`/`🔄`) — result as `anchor-complete: yes/no` in the subagent report. On **yes** the **main thread** (phase 3) closes the anchor: `gh issue close <anchor#> -c "Wave complete — all slices merged via PR #<PR>."` and verifies the board status `Done` (auto-rule issue-closed→Done). Rationale: the guard keeps the anchor away from **any** auto-close — it only gets closed here, after a verified complete state. Without this step it stays silently open after the last slice (gap PR). Out-of-scope wave leftovers get their own issues, not a placeholder inside the anchor.
2. **Assumption propagation — PROPOSE + CONFIRM** (Q2) `[Phase 3 · main thread]`. Parse `annahme-drift` markers from the **subagent report** (resp. the PR body) (JSON). Per marker: draft a sibling edit (e.g. append to the target issue's `headings.vorBau` heading — <project> currently `## Vor Bau zu klären`) **+ re-stamp the sibling's `plan_revision`**; **show it to the user, get confirmation, only then write**. Silent writes are forbidden (Codex #15). Both are prose-led: the tick (1.) is a clear-cut one-line flip with no user gate, the substantive sibling edits are judgment → propose + confirm.
3. **Land sanity (non-blocking):** `python3 scripts/execute-ready-check.py --issue <anchor#> --mode audit` → two-liner; name any drift in the report.

### Step 6 — report `[Phase 3 · main thread]`
The main thread summarizes from the subagent report. Concise: merged PR (#), issue-close status (auto vs. manual via Step 5b), worktree removed (path), local branch deleted, **swept merged branches local (Step 5c) + remote (Step 5d), counts each**, `main` now at `<SHA>` (`git log --oneline -1`), deploy running. **Anchor tracker** (for `Part of #<anchor>`): ticked in Step 5e — state the result (ticked / propose-pending), **no** more manual reminder; on `anchor-complete: yes` additionally: anchor closed + board status `Done` verified (Step 5e.1b).

## Out of scope
- Live-verify / DoD: must have happened BEFORE `/wrapup` — this skill lands (Step 0 makes it landable, then merges), it does **not** verify. Step 0's auto-commit doesn't replace live-verify.
- `/retro`: offer it **before** landing (see the retro reminder before Step 0) — repo-file patches travel in the PR, memory patches stay local. `wrapup` **never calls `/retro` itself** (no auto-run); `wrapup` itself only lands/verifies, it doesn't run a retro.
- Other running worktrees / their servers are left untouched.
