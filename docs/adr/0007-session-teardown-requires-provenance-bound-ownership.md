# Session teardown requires provenance-bound ownership

Status: accepted (2026-07-26, Wave #271)

Long agent sessions create branches, linked worktrees, setup outputs, and
landing-time build artifacts. The desired end state is that everything created
by that session can be removed, including branches whose changes reached
canonical `main` through patch-equivalent commits rather than ancestry.

Repository state alone cannot identify that ownership safely. A foreign branch
can have the same name or patch, a user file can match a generated-artifact
pattern, and a path can be replaced between assessment and deletion. Retrying
after a crash adds a time dimension: a fresh snapshot cannot distinguish an
earlier generator output from a file created by the user between attempts.

We decided that teardown authority must come from **Teardown provenance**, not
from present-day similarity:

1. A session records intent before creation, but receives cleanup authority only
   through an atomic **Ownership proof**. Branch and proof ref are acquired in
   one Git transaction bound to the active wave claim.
2. Setup, session work, and landing are separate provenance boundaries. Setup
   and session cleanup use the worktree-creation baseline; landing cleanup uses
   a persisted landing-attempt boundary and freezes the exact outputs of its
   generator-capable step.
3. Paths and patterns select candidates but never prove identity. Cleanup binds
   regular files and worktree roots to no-follow object evidence and revalidates
   that evidence immediately before mutation.
4. The **Lifecycle receipt** is a state-transition journal. Prepared Git ref
   transactions close the worktree-removal race, and committed intermediate
   states make known outcomes resumable.
5. Lost evidence is not reconstructed from coincidence. An interrupted landing
   attempt without frozen outputs can be archived without claiming or deleting
   its files, after which the ambiguous files must be classified before a new
   attempt proceeds.

## Considered options

- **Delete branches merged by ancestry:** rejected because squash,
  cherry-pick, and patch-equivalent integration leave session-owned branch refs
  outside ancestry.
- **Treat a receipt row as ownership:** rejected because another process can
  create the named branch or worktree after the absence check but before the
  attempted creation.
- **Authorize files by ignored path or generator pattern:** rejected because a
  consumer file can occupy the same path before landing or replace an assessed
  output afterward.
- **Take a fresh landing snapshot on every retry:** rejected because it protects
  prior generator outputs as if they predated landing, while a persistent start
  snapshot alone incorrectly claims every later matching user file.
- **Force-remove apparently clean targets:** rejected because force bypasses the
  repository and filesystem evidence that distinguishes owned work from foreign
  work.
- **Guess ownership after an unjournaled crash window:** rejected because safe
  cleanup and guaranteed automatic liveness cannot both be recovered after the
  distinguishing evidence is lost.

## Consequences

- A completed session can remove its exact worktrees, branches, proof refs, and
  generated artifacts without hiding history or sweeping unrelated repository
  state.
- Foreign branches, worktrees, symlinks, replacements, late writes, and
  pre-landing consumer files are hard stops or remain outside cleanup authority.
- Retry behavior is deterministic when evidence was persisted. Ambiguous
  pre-freeze landing attempts require an explicit archive/classification step
  and never silently gain ownership.
- The lifecycle implementation is necessarily a small transaction protocol,
  with more states and race tests than a path-based cleanup script.
