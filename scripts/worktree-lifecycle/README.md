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
- `mainBranches` and `protectedBranches`: branches guarded in the main checkout.
- `setupEntry` and ordered `setupSteps`: the portable setup command and project
  setup sequence.
- `riskyCommandPatterns`: commands that must target the active linked worktree.
- `scratchPatterns`: consumer-owned glob patterns for untracked disposable
  planning artefacts. No filename is assumed by Core.

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

## Cleanup

`cleanup.py` previews by default. Removal refuses protected, tracked-dirty,
non-scratch-dirty, open-PR, or unmerged worktrees. Profile-declared untracked
scratch is named in the report but does not block removal. The assessment reads
`ANNAHMEN.md` before removal and returns its contents for propagation.
`wrapup-land.py` invokes this same assessment after a merge and before killing
processes or removing the worktree.

Explicit removal re-collects facts immediately before mutation, requires the
same removable inventory, deletes only the exact contained regular scratch
files from that inventory, and uses ordinary `git worktree remove`. It never
bypasses Git's final concurrent-change check with force removal.

The generic setup route atomically records its ignored and complete
untracked-file inventories in the linked worktree's Git metadata after its
configured setup steps. The record is bound to the worktree path, branch, root
device/inode, and setup HEAD, and carries a canonical digest. Existing
worktrees are never backfilled because their initial inventory is no longer
knowable. The claim-bound session route below captures its stricter baseline
before project setup so a failed setup has an exact recovery boundary.

The landing adapter may carry exact scratch evidence only for current ignored
files that match the consumer-owned
`wrapup.landingGeneratedArtifactPatterns` profile and were absent from that
creation baseline. Missing, changed, or incoherent provenance stops landing
cleanup. Initial/profile-matched files, unmatched files, symlinks, and writes
after the landing evidence snapshot remain cleanup stops; deletion still uses
the same descriptor-bound regular-file primitive and a second inventory check.

`cleanup.py sweep` is the read-only inventory entrypoint. It accounts once for
every linked worktree and local branch, reports issue/PR/merge/age/removal
facts, and counts merged remote branches separately. It never removes a
worktree or branch.

## Session-owned teardown

`session.py` is the narrower orchestration route. It binds one receipt in the
Git common directory to the active `wave-active/<anchor>` annotated claim:

```sh
python3 scripts/worktree-lifecycle/session.py begin --anchor <n> --owner <run> --base <wave-head>
python3 scripts/worktree-lifecycle/session.py create --anchor <n> --owner <run> --base <current-wave-head> <issue> <slug> <type>
python3 scripts/worktree-lifecycle/session.py recover --anchor <n> --owner <run> --branch <exact-branch>
python3 scripts/worktree-lifecycle/session.py seal --anchor <n> --owner <run>
python3 scripts/worktree-lifecycle/session.py inspect --anchor <n> --owner <run> --main origin/main
python3 scripts/worktree-lifecycle/session.py teardown --anchor <n> --owner <run> --main origin/main
```

Only `create` can add an inventory row, and it refuses any branch or path that
already existed. It journals a provisional exact row before `git worktree add`,
then captures the shared artifact baseline before project setup and promotes
the row only after setup succeeds. Session inspection
therefore accepts generated scratch only when the exact path matches the
profile and is absent from the creation baseline; missing, changed, or
incoherent provenance stops. `seal` records the final exact branch OIDs.
Inspection reports ancestry, one-to-one stable patch equivalence, unique
content, and ambiguity separately. Empty commits, non-ancestry merge commits,
duplicate patch IDs, open or unreadable PR evidence, dirt, protected names,
stale registrations, recreated removed targets, and identity drift stop the
whole teardown before mutation.

If setup fails, the provisional row becomes `recovery-pending`. Automatic and
explicit `recover` use the same bounded route: active claim and receipt,
protected name, PR state, exact ref OID, registration/root identity, and the
creation baseline are revalidated. Only regular files whose path,
device/inode, size, and digest were frozen at the setup failure may be removed;
later foreign files or replacements stop without losing receipt ownership.
Recovery uses ordinary worktree removal and compare-deletes the exact ref.

Teardown re-runs that complete assessment, archives every recovery OID in the
receipt before its first mutation, and revalidates canonical main, the active
claim and receipt, profile protection, PR state, branch OID, worktree
registration/root identity, dirt, and the exact scratch inventory immediately
before each target mutation. After ordinary worktree removal it rechecks the
ref-side gates, then compare-deletes only the recorded local refs with
`git update-ref -d <ref> <expected-oid>`. A concurrent ref move therefore
survives, while a partial run keeps its recovery OIDs and can resume. Generic
cleanup and sweep never consume this ownership route and never infer authority
over a foreign branch.

Claude hook wiring and any Codex adaptation consume this same profile and core.
An adapter may change only the surface event envelope; it must preserve the
core verdict and message.
