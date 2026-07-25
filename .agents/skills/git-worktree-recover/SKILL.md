---
name: git-worktree-recover
description: "Recovery skill for git branch mix-ups — a commit landed on the wrong branch, the branch switched unexpectedly, or work appears lost. Uses git reflog to find the misplaced commit, moves it to the right branch (git branch -f), optionally resets the wrong branch, and sets up a clean worktree. Triggers: commit on the wrong branch, branch switched on its own, this commit doesn't belong here, my work is gone, I committed to main by accident."
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill git-worktree-recover --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# git-worktree-recover

Recovery skill for branch mix-ups. When two processes share one checkout's global
`HEAD`, they can clobber each other — a commit lands on the wrong branch. This
skill is the **reaction** when a prevention layer (a worktree-per-session
discipline and its guards) didn't stop it.

## When to invoke

- "My commit is on the wrong branch"
- "The branch switched even though I did nothing"
- "This commit doesn't belong here"
- "My work is gone / I can't see my commit anymore"
- "I accidentally committed to main"

## Precondition

This generic recovery remains usable whether or not the project has prevention
guards or a custom worktree setup command.

## Readiness preflight — first

<!-- readiness:optional-preflight:start -->
Before assessing refs or moving a branch, run this once from the project root:

```bash
node scripts/readiness.mjs check --skill git-worktree-recover --json
```

- `ready`: continue silently with generic recovery and the active
  `projectRecovery` block.
- `degraded`: keep generic reflog recovery active, omit only
  `projectRecovery`, and emit exactly one concise summary: `Readiness degraded
  — inactive block projectRecovery (worktreeRecoveryLayer: <state>). Run
  /setup-workflow, configure docs/agents/skills/git-worktree-recover.md, then
  rerun this skill.`
- `blocked`: stop before continuing and report the non-ready required capability
  plus the exact `/setup-workflow` recovery path.
- Invalid evidence is always visible in that one summary; never interpret it as
  an opt-out or invent a project command.
<!-- readiness:optional-preflight:end -->

<!-- readiness:block projectRecovery -->
When `projectRecovery` is active, read
`docs/agents/skills/git-worktree-recover.md` and apply its named prevention
guards and exact worktree setup command around the generic recovery below.
<!-- readiness:end -->

---

## Phase 1 — Assess the situation

Run these four read-only commands (no harm):

```bash
git branch --show-current
git log --oneline -10
git reflog --oneline -20
git worktree list
```

**Goal:** identify the misplaced commit SHA + the intended target branch.

### What to look for in the reflog

A line like:

```
691b655 HEAD@{3}: commit: <your commit message>
```

...appearing on a branch that is *not* the commit's intended branch. Note the SHA
and message.

---

## Phase 2 — Safety checks

Before any destructive action:

1. **Is the target branch checked out in another worktree?**
   ```bash
   git worktree list
   ```
   `git branch -f <branch> <sha>` fails if the branch is checked out elsewhere —
   that is safe (git refuses it), but check first to get a clear message.

2. **Does the wrong branch have its own commits that must survive?**
   ```bash
   git log --oneline <wrong-branch>..origin/main
   ```
   If nothing of its own (it is `main`, or carries nothing) → a reset to
   `origin/main` is safe.

3. **Is the SHA really the right commit?**
   ```bash
   git show --stat <sha>
   ```
   Check the message + changed files against the intended context.

---

## Phase 3 — Move the commit to the right branch

**Case A: target branch does not exist yet (most common)**

```bash
git branch <target-branch> <sha>
git log --oneline <target-branch> -5   # verify
```

**Case B: target branch exists and the commit is missing there**

```bash
git branch -f <target-branch> <sha>    # only if NOT checked out elsewhere
git log --oneline <target-branch> -5   # verify
```

**Case C: several commits on the wrong branch (stacked mix-up)**

```bash
git cherry-pick <sha1> <sha2> ...      # run on the correct branch, oldest first
```

---

## Phase 4 — Clean up the wrong branch (optional, recommended)

Only when:

- the wrong branch is checked out in the main tree (not a worktree), AND
- the wrong branch is `main` or carries no feature commits of its own.

```bash
git reset --hard origin/main
git log --oneline -5   # the misplaced commit must NOT appear here anymore
```

If the wrong branch is a feature branch with its own state → do **not** reset; drop
only the one commit (`git rebase --onto`). Rare special case — confirm before doing
it.

---

## Phase 5 — Set up a worktree

Set the recovered branch up cleanly in its own worktree. The generic fallback is:

```bash
git worktree add <path> <recovered-branch>
```

**Verify after setup:**

```bash
git worktree list
```

---

## Phase 6 — Final check

```bash
git log --oneline <target-branch> -5   # SHA must appear here
git log --oneline <wrong-branch> -3    # SHA must no longer be the top here
git worktree list                      # clean
```

---

## Background + cause

`git` keeps ONE global `HEAD` pointer per checkout. If two processes run
`git checkout`, the second overwrites the first — a commit can then land on the
wrong branch. Not a bug, a git property. The fix is isolation via `git worktree`
(one checkout dir per session); this skill is the reaction when a prevention guard
did not catch it.

**Safety guarantees of `git branch -f`:**

- Refuses to run if the branch is checked out in another worktree (git built-in).
- No data loss: the commit stays in the object store, only the branch pointer moves.
- Always reversible via `git reflog`.

## Anti-patterns

- **`git rebase -i` to remove commits from main** — too destructive, risks a
  force-push to main (a pre-push hook should block it, but avoid it anyway).
- **`git reset --hard` without the safety check** — only after the worktree-list
  check and only when the branch has no feature state of its own.
- **Reflog without SHA verification (`git show`)** — reflog shows checkouts too,
  not just commits; always `git show <sha>` before acting.
