# Worktree Lifecycle contract

The consumer-owned `docs/agents/workflow-capabilities.json` profile activates
one Worktree Lifecycle. `profile.py` loads that policy. `core.py` is the only
place that derives repository facts and decides whether an event emits, allows,
or blocks. Surface adapters translate hook payloads and render the decision;
they do not carry a second branch regex, worktree traversal, or failure policy.

## Profile

`worktreeLifecycle` supports:

- `enabled`: explicit activation gate.
- `worktreeRoot`, `branchTemplate`, `pathTemplate`, and `branchRegex`: consumer
  naming and location policy.
- `contentBranchTemplate` (default `{type}/{slug}`): the issue-less branch a
  session cuts when its output is durable content. It renders `{type}` and
  `{slug}` only — a durable-content session has no issue number — and refuses
  an `{issue}` placeholder instead of inventing one.
- `mainBranches` and `protectedBranches`: branches guarded in the main checkout.
- `setupEntry` and ordered `setupSteps`: the portable setup command and project
  setup sequence.
- `riskyCommandPatterns`: commands that must target the active linked worktree.

The profile carries **structural facts only** (ADR 0009). It declares no
pattern list, because deletion policy has exactly one configuration surface:
the ignore mechanism. Making a file deletable at teardown means ignoring it.
Keys this loader does not know are ignored in silence, so a profile written for
an older kit keeps working without warning noise.

Profile globs elsewhere in the kit (Workflow Advisories) use one
repository-relative POSIX dialect, implemented once in
`scripts/profile_globs.py`. `*` and `?` stay inside one path segment;
`[seq]`/`[!seq]` are per-segment character classes; `**` as a whole segment
matches zero or more segments, so a leading `**/` also matches the repository
root and `dir/**` also matches `dir` itself; matching is always case-sensitive
on every host filesystem; and a pattern must match the whole path. Run
`python3 scripts/profile_globs.py <profile.json>` to review an installed
profile. No Worktree Lifecycle decision reads a glob: the ignore mechanism is
the single deletion-policy surface, so a pattern can no longer widen cleanup
authority at all.

Unknown or malformed events fail open without changing repository state.
Security-sensitive, profile-matched edits and commands fail closed only when
the core proves the target is unsafe.

## Adapters

| Adapter | Event | Outcome |
|---|---|---|
| `branch-context.py` | SessionStart | emits branch, issue, status, and active-worktree facts |
| `branch-watch.py` | PostToolUse | emits the same facts after a branch-changing command |
| `enforce-worktree.py` | PreToolUse | blocks tracked main-checkout edits and cross-worktree leaks |
| `enforce-worktree-cwd.py` | PreToolUse | blocks verification or Git mutation in the wrong checkout |
| `enforce-worktree-discipline.py` | PreToolUse | routes issue-branch creation through the configured setup entry |
| `slice-handoff-hint.py` | UserPromptSubmit | names the configured setup entry for a defined slice |

## Planning-artifact ignore rules

`plan-artifacts.json` is the kit-owned declaration of the planning artefacts the
shipped skills write (`PLAN.md`, `PLAN-REVIEW-LOG.md`, `ANNAHMEN.md`).
`ignore_seed.py` turns that declaration into an offer, never an installation:
`preview` reports what an approval would append and writes nothing, and `apply`
appends exactly one marker block. `.gitignore` is a consumer file the kit does
not own, so only an explicit approved `/setup-workflow` step may run `apply`;
`init` and `update` reconciliation never reach it (ADR 0008).

The append never rewrites, reorders, or removes an existing line. A repository
that already ignores every artefact reports `nothing-to-do`, a re-run after an
approval is a byte-identical no-op, and a marker block the consumer has since
edited reports `blocked` rather than being repaired. An artefact already tracked
in git is named separately — an ignore rule cannot untrack it, and the helper
never runs `git rm`. Approving that offer is also what makes the artefacts
deletable at teardown: `.gitignore` is the one deletion-policy surface.

## Cleanup

`classify.py` is the teardown authority. It reads the worktree's current state
at the moment of action and nothing else: a tracked change or an unmerged path
blocks, an untracked non-ignored file blocks with a bounded report (count plus
top directories, never a path dump), and an ignored entry is Scratch and
deletable. The single hardcoded exception is `.env*` by basename glob, which is
deletable only when it is byte-identical to its counterpart at the same
relative path in the main checkout, both opened no-follow. An ignored symlink
is deletable only when its target resolves inside the assessed worktree; the
link itself is unlinked and never followed.

`cleanup.py` previews by default. Removal additionally refuses an unregistered
path, a detached branch, a protected branch or the main checkout, an open PR,
and an unmerged branch. The assessment reads `ANNAHMEN.md` before removal and
returns its contents for propagation.

Explicit removal re-collects facts immediately before mutation and requires the
same removable inventory. The deletion walk re-opens the assessed root
no-follow, re-checks its device/inode, and re-checks every entry's kind — and a
symlink's target — immediately before unlinking it. It uses ordinary `git
worktree remove` and never bypasses Git's final concurrent-change check with
force removal.

`wrapup-land.py` runs the same assessment after a merge: quiesce the worktree's
own declared `.dev-ports` listeners, classify, delete the Scratch, remove the
worktree. Teardown always runs — a direct `/wrapup` invocation is its
authorization, including for a worktree an external tool created under a
foreign name and path (ADR 0009). There is no persisted attempt state and no
recovery flag: an interrupted landing is resumed by re-running it, because
every step verifies present state and skips what is already done.

Two residual risks are accepted deliberately (ADR 0009) — between assessment and
deletion a file could in principle be replaced, and a valuable file a consumer
keeps gitignored outside `.env*` is deletable at teardown.

`cleanup.py sweep` is the read-only inventory entrypoint. It accounts once for
every linked worktree and local branch, reports issue/PR/merge/age/removal
facts, and counts merged remote branches separately. It never removes a
worktree or branch.

Claude hook wiring and any Codex adaptation consume this same profile and core.
An adapter may change only the surface event envelope; it must preserve the
core verdict and message.
