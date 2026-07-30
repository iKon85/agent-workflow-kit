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
- `setupEntry`: the portable setup command a session is routed to.
- `seed`: what a fresh worktree carries — see §Seed below.
- `riskyCommandPatterns`: commands that must target the active linked worktree.

The profile carries **structural facts only**. It declares no pattern list,
because deletion policy is configured by declaration: the ignore mechanism
decides what is scratch, and `seed.paths` decides only whether a `.env*` the
consumer itself named still needs teardown's comparison against the main
checkout. Making a file deletable at teardown means ignoring it (and, for a
`.env*`, declaring it in the seed).
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

## Seed

`setup.py` is the optional creation helper: one call cuts the profile's branch,
adds the worktree at the profile's path, and seeds it. It is an offer, not a
mandate — a worktree created with plain `git worktree add`, under any name and
path, stays first-class everywhere else in the lifecycle.

The seed is a **flat declaration**, two keys and no third:

```json
"seed": {
  "paths": [".env", "config/local.json"],
  "variables": { "VITE_DEV_PORT": 5173, "BACKEND_PORT": 3001 }
}
```

- `paths`: repository-relative files copied verbatim from the main checkout to
  the same relative path in the new worktree. A path that escapes the
  repository, is absolute, or is not a plain file is refused by name; a symlink
  is never followed. A declared path the main checkout does not have is named
  in the output and skipped — a fresh clone has no local config yet.
  Declaring a path is also **consent to delete it at teardown**: for a `.env*`
  file the declaration replaces the comparison against the main checkout (see
  §Cleanup), because a file you declared as what a fresh worktree carries is
  by your own statement not work. Do not declare a file whose only copy lives
  in the worktree.
- `variables`: named positive integer bases. The helper derives this worktree's
  own slot from the issue number (or the branch checksum when there is none)
  and writes `<name>=<base + slot × 10>` lines into the worktree's `.dev-ports`,
  stepping past the ports browsers refuse to connect to. `.dev-ports` is the
  same file `wrapup-land.py` quiesces at teardown.

There are no step kinds, no ordering knobs, no per-entry flags, and no command
execution: a declaration of *what* a worktree carries transfers between
projects, a procedure that produces one does not. The kit owns the mechanism
and never reads, parses, or patches a declared file's contents — a hand-written
secret crosses into the worktree as bytes and nothing else.

Seeding runs only for a worktree this call creates. An existing worktree is
adopted and reported, never re-seeded over the consumer's own values, and a
seeding failure removes the fresh worktree together with the branch it cut, so
no half-built checkout survives the command.

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

Two rule classes, one declaration each — never a literal typed into the helper:

- `plan-artifacts.json` is the kit-owned declaration of the planning artefacts
  the shipped skills write (`PLAN.md`, `PLAN-REVIEW-LOG.md`, `ANNAHMEN.md`).
- the worktree root the consumer profile declares (`worktreeRoot`, kit default
  `.worktrees`). Without that rule a stray `git add -A` stages every linked
  worktree as an embedded git repository, and the resulting commit carries
  gitlinks no clone can resolve.

`ignore_seed.py` turns those declarations into an offer, never an installation:
`preview` reports what an approval would append and writes nothing, and `apply`
appends exactly one marker block. `.gitignore` is a consumer file the kit does
not own, so only an explicit approved `/setup-workflow` step may run `apply`;
`init` and `update` reconciliation never reach it.

The append never rewrites, reorders, or removes an existing line. A repository
that already ignores every offered rule — by any pattern, including a wildcard
— reports `nothing-to-do`, a re-run after an approval is a byte-identical
no-op, and a marker block that no longer covers every rule reports `blocked`
with the uncovered rules named, rather than being repaired. An artefact already
tracked in git is named separately — an ignore rule cannot untrack it, and the
helper never runs `git rm`. Approving that offer is also what makes the
artefacts deletable at teardown: `.gitignore` is the one deletion-policy
surface.

## Cleanup

`classify.py` is the teardown authority. It reads the worktree's current state
at the moment of action and nothing else: a tracked change or an unmerged path
blocks, an untracked non-ignored file blocks with a bounded report (count plus
top directories, never a path dump), and an ignored entry is Scratch and
deletable. The single exception is `.env*` by basename glob, and it has two
arms:

- **Declared** — the path is listed in the profile's `seed.paths` (§Seed). The
  consumer said this file is what a fresh worktree carries, so the declaration
  itself grants deletion authority, exactly as an ignore rule does. No
  comparison runs, and the teardown report names every deletion the declaration
  authorized. Consent is exact: never a glob, never a prefix, and never a
  directory or symlink standing at the declared path.
- **Undeclared** — deletable only when it is byte-identical to its counterpart
  at the same relative path in the main checkout, both opened no-follow. A
  hand-written secret nobody declared keeps this conservative block.

A worktree that correctly carries its own port is byte-different from the main
checkout by construction, so before the declared arm existed every correctly
configured worktree was blocked at teardown. The classifier reads no
profile itself: whoever assesses a worktree passes the declared paths in, so
resolving consumer configuration stays with the caller.

An ignored symlink is deletable only when its target resolves inside the
assessed worktree; the link itself is unlinked and never followed.

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
foreign name and path. There is no persisted attempt state and no recovery
flag: an interrupted landing is resumed by re-running it, because every step
verifies present state and skips what is already done.

Three residual risks are accepted deliberately — between assessment and deletion
a file could in principle be replaced, a valuable file a consumer keeps
gitignored outside `.env*` is deletable at teardown, and a declared `.env*` file
is deleted without any comparison. The third is the consent the declaration
grants, which is why every such deletion is named in the report.

`cleanup.py sweep` is the read-only inventory entrypoint. It accounts once for
every linked worktree and local branch, reports issue/PR/merge/age/removal
facts, and counts merged remote branches separately. It never removes a
worktree or branch.

Claude hook wiring and any Codex adaptation consume this same profile and core.
An adapter may change only the surface event envelope; it must preserve the
core verdict and message.
