# Teardown authority is stateless repository classification

Status: accepted (2026-07-27, #320) — supersedes
[ADR-0007](./0007-session-teardown-requires-provenance-bound-ownership.md)

ADR-0007 derived teardown authority from persisted lifecycle evidence:
ownership-proof refs acquired in atomic git transactions, frozen
landing-attempt journals, baseline digests, no-follow identity binding, and a
post-merge reload of the canonical cleanup policy. Every piece was locally
justified, and the aggregate failed in practice: fifteen teardown/cleanup
issues in two weeks (#245–#319), ~5,600 lines of lifecycle code, two recovery
flags for the machinery's own bookkeeping, a legacy receipt contract, and
refusals that did not name their cause (#319: 68,856 paths, 7.4 MB, zero
actionable lines). The protection was aimed at narrow races between assessment
and deletion; the cost was that ordinary sessions could no longer finish.

We decided that teardown authority comes from the repository's **current
state**, read at the moment of action, and from nothing else:

1. **Git's own classification is the file taxonomy.** A tracked modification
   blocks teardown. An untracked, non-ignored file blocks with a bounded
   report (count plus top directories — never an unbounded path dump). An
   ignored file is Scratch: the repository declared it not-work, and it is
   deletable. "Ignored" means git's standard exclude sources
   (`--exclude-standard`: repository `.gitignore` files, `.git/info/exclude`,
   the global excludes file) — whatever the repository's own tooling treats as
   ignored is deletion authority here too.
2. **One hardcoded exception: `.env*` (basename glob).** Ignored yet
   potentially irreplaceable. Before removal each `.env*` regular file is
   compared byte-wise with its counterpart at the same relative path in the
   main checkout, both opened no-follow: identical → derived copy, deletable;
   divergent, absent in the main checkout, or either side not a regular file →
   block with the exact files named. The check is a present-state comparison,
   not a receipt.
3. **The platform PR record authorizes branch deletion.** Force-deletion
   requires exactly one PR matching the full tuple — this repository as base
   repo, head repository equal to the base repo (no fork heads), head ref
   equal to the branch name, base ref equal to the configured protected
   branch, state merged — whose head SHA equals the branch tip OID; the OID
   is re-read immediately before deletion, and zero matches, multiple
   matches, an open PR on the same head, or any drift retains the branch.
   Ancestry-merged branches (against a freshly fetched configured protected
   branch — stale ancestry stops rather than guesses) delete normally. A
   branch with neither stays and is reported. Without platform access this
   degrades to ancestry-only, reported honestly.
4. **Idempotency by re-check, not journal.** An interrupted landing is resumed
   by re-running it; every step verifies present state (PR exists? merged?
   worktree present?) and skips or proceeds. There is no persisted attempt
   state to validate, archive, or recover.
5. **A direct `/wrapup` invocation is the teardown authorization.** It lands
   and tears down the worktree it runs in — including worktrees created by
   external tools under foreign names and paths. The kit never conditions
   teardown on its own naming or location conventions; the four classification
   rules above are the only protection.
6. **Deletion policy has exactly one configuration surface: the ignore
   mechanism.** The consumer profile keeps structural facts only (worktree
   root, templates, protected branches, sweep opt-in). `scratchPatterns` and
   `landingGeneratedArtifactPatterns` are removed without migration —
   including the shipped consumer migration that seeded them; making a file
   deletable means ignoring it (ADR-0008's offered seeding remains the
   supported way; its consequence about deriving `scratchPatterns` from the
   seeded rules is obsolete with this decision).

## Considered options

- **Keep ADR-0007's provenance machinery:** rejected on empirical grounds. The
  races it closes (a foreign file occupying an assessed path between
  assessment and deletion, a same-name branch created concurrently) are rare
  and low-harm next to the observed failure mode: routine teardown becoming
  impossible and each repair adding machinery. The branch race is additionally
  closed cheaper by the tip-SHA/PR comparison.
- **Shipping default scratch patterns:** rejected. A default allowlist of the
  deletable restarts the pattern catalog and its seeding, sync, and dialect
  problems; `.gitignore` already encodes the same fact with universal
  tooling.
- **Migrating existing profiles and receipts:** rejected. The green-slate cut
  is deliberate (#320): old keys are ignored, journaled attempts are inert
  files, and no code path reads either. Maintaining both models would preserve
  the complexity this decision removes.
- **Location heuristic for externally created worktrees (land, don't tear
  down):** rejected by the user. `/wrapup` means tear down; splitting the
  outcome by worktree origin reintroduces an ownership notion.

## Consequences

- A worktree whose only untracked content is ignored dependency or build
  output is removable with zero configuration. #319's failure class cannot
  occur.
- Refusals are bounded and name their cause; the fix is always visible
  (commit the tracked change, handle the named `.env*`, ignore or remove the
  named untracked files).
- The accepted residual risk is explicit: between assessment and deletion a
  file could in principle be replaced; a valuable file a consumer keeps
  gitignored outside `.env*` is deletable at teardown. We trade these narrow
  windows for a lifecycle that ordinary sessions can actually complete.
- Planning sessions stop being a special case: durable content lands through
  wrapup's Content route as ordinary work, scratch dies with the worktree,
  and worktree creation binds to implementation, not planning.
- The lifecycle implementation shrinks from a transaction protocol to a
  classification function plus plumbing; its tests shift from race
  choreography to classification truth tables.
