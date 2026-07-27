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
- `wrapup.landingGeneratedArtifactPatterns`: an explicitly reviewed
  consumer-owned allowlist for outputs created by the landing commands. It is
  deletion authority, so setup never derives it from `.gitignore` alone and
  update never installs a universal default.

Profile globs use one repository-relative POSIX dialect, implemented once in
`scripts/profile_globs.py` and loaded by this core and by
`scripts/workflow-advisories/core.py`. `*` and `?` stay inside one path
segment; `[seq]`/`[!seq]` are per-segment character classes; `**` as a whole
segment matches zero or more segments, so a leading `**/` also matches the
repository root and `dir/**` also matches `dir` itself; matching is always
case-sensitive on every host filesystem; and a pattern must match the whole
path. For example, `**/__pycache__/**` matches both root and nested caches,
while `dist-kit/*` does not match `dist-kit/a/b`.

Because both capabilities load the same matcher, a pattern can never select one
set of paths for an advisory and a different set for a deletion decision. Run
`python3 scripts/profile_globs.py <profile.json>` to review an installed
profile: it names every pattern whose match set narrows or widens against that
key's legacy matcher, prints the witness path proving it, marks the keys that
carry deletion authority, and exits 1 when anything needs review. It reads the
profile and never rewrites a pattern, so a migration cannot silently expand
cleanup authority.

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
never runs `git rm`. Only after such an approval does the `scratchPatterns`
derivation have real ignored planning artefacts to read.

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
worktrees can receive a conservative baseline only when they are the exact
registered no-follow directory on an attached branch with a clean tracked
worktree and index. Setup reuse defers that backfill, without blocking the
existing worktree, while tracked work is dirty or landing-generated blockers
are present. Landing classifies those blockers before writing any baseline;
after they are moved, every remaining current ignored and untracked path is
recorded as pre-existing and therefore protected. A corrupt baseline or an
active landing attempt is never overwritten. The claim-bound session route
below captures its stricter baseline before project setup so a failed setup has
an exact recovery boundary.

Before merge, the committed worktree profile may only nominate exact,
identity-bound landing candidates; it authorizes no deletion. After merge and
`fetch origin/main`, cleanup reloads the profile directly from canonical
`origin/main`, requires its scratch and generator policies to equal the
worktree candidate and the policy digest frozen at attempt start, and only then
authorizes mutation. Every supplied generator-evidence path is independently
checked against that canonical generator policy. A missing policy is distinct
from an explicit empty policy. An unmerged or transient branch policy therefore
cannot grant itself broader cleanup authority.

Canonical policy that drifts between attempt start and post-merge cleanup keeps
that refusal, and the refusal names its supported recovery. Recovery re-derives
authority from the merged canonical policy alone: it never consults the stale
worktree candidate, never re-scans for new candidates, requires the branch to
already be an ancestor of canonical main, and requires each frozen identity to
be both named by canonical policy and unchanged on disk. Evidence outside
canonical policy, a changed identity, and pre-existing or foreign state stop the
recovery instead of being deleted, and a repeated run after a completed teardown
is a no-op.

The landing adapter may carry exact scratch evidence only for current ignored
files that match the consumer-owned
`wrapup.landingGeneratedArtifactPatterns` profile and were absent from that
creation baseline. Missing, changed, or incoherent provenance stops landing
cleanup. Initial/profile-matched files, unmatched files, symlinks, and writes
after the landing evidence snapshot remain cleanup stops; deletion still uses
the same descriptor-bound regular-file primitive and a second inventory check.
Mutable session logs belong in explicit `scratchPatterns`, not in the landing
generator allowlist: their identity is frozen at final cleanup assessment, so
normal logging before teardown remains live while a later append or replacement
still stops deletion.
Landing-start blockers are classified before a journal is written, so moving a
protected blocker permits a clean next attempt. An explicit relinquish archives
either a started or frozen attempt, including drifted evidence, without
deleting or claiming any file; the next preflight treats every current file as
pre-existing. Exact unchanged frozen evidence remains directly resumable. The
attempt journal name is classified without following a symlink, so a symlinked
or dangling journal entry stops instead of being read or replaced, and each
archived receipt is filed under a contract-version-neutral stem plus its own
recorded contract version. A journal written under a superseded contract is
classified as legacy rather than corrupt when it still satisfies its own
recorded contract; that refusal names the archive route explicitly, while a
journal that fails its own contract is still reported as incoherent evidence.

`cleanup.py sweep` is the read-only inventory entrypoint. It accounts once for
every linked worktree and local branch, reports issue/PR/merge/age/removal
facts, and counts merged remote branches separately. It never removes a
worktree or branch.

Claude hook wiring and any Codex adaptation consume this same profile and core.
An adapter may change only the surface event envelope; it must preserve the
core verdict and message.
