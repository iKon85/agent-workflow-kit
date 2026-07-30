# Teardown authority is stateless repository classification

Status: accepted (2026-07-27, #320) — supersedes
[ADR-0007](./0007-session-teardown-requires-provenance-bound-ownership.md) ·
amended 2026-07-30 (#430: §2 and §6, see [Amendment](#amendment--2026-07-30-430))

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
2. **One exception: `.env*` (basename glob) — with two arms** (amended #430).
   Ignored yet potentially irreplaceable, so who may delete it depends on
   whether the consumer declared it:
   - **Declared.** The seed declaration (`worktreeLifecycle.seed.paths`) names
     this exact repository-relative path. The consumer said this file is what a
     fresh worktree carries, and that declaration grants deletion authority the
     same way `.gitignore` does — "the repository declared it not-work". No
     comparison runs, and every waived deletion is named in the teardown
     report, because consent is only consent while it stays visible where it is
     used. Consent is exact: never a glob, never a prefix, and never a
     directory or symlink standing at the declared path.
   - **Undeclared.** Unchanged. Each `.env*` regular file is compared byte-wise
     with its counterpart at the same relative path in the main checkout, both
     opened no-follow: identical → derived copy, deletable; divergent, absent
     in the main checkout, or either side not a regular file → block with the
     exact files named. A hand-written secret is the class with no floor
     beneath it, so it keeps the conservative comparison.

   Both arms stay present-state reads: the declaration is present
   configuration, not evidence of a past action, and the classifier receives it
   as an argument rather than reading a profile itself.
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
6. **Deletion policy is configured by declaration only** (amended #430). The
   ignore mechanism decides what is Scratch at all; the seed declaration
   decides one thing and nothing more — whether a `.env*` file the consumer
   itself declared still needs the comparison. Neither is a pattern list, no
   glob widens cleanup authority, and there is still no third surface. The
   consumer profile keeps structural facts only (worktree
   root, templates, protected branches, seed, sweep opt-in). `scratchPatterns` and
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
- A consumer that declares its per-worktree config can land again (#430); one
  that declares nothing keeps the conservative block, so the amendment adds no
  new exposure to anybody who did not ask for it.

## Amendment — 2026-07-30 (#430)

The observed incident (Welle 31 truth census, R1, reproduced by
`docs/analysis/welle-31/truth-census/fixtures/probe-env-proxy.py`): the
byte-comparison of §2 was a proxy for the wrong question. The decision teardown
has to make is "is this file work or scratch"; the comparison asked "is it
identical to the main checkout's copy". A worktree that correctly carries its
own port is byte-different by construction, so **every correctly configured
worktree was blocked at teardown** — the fix visible to the user being to make
the file wrong.

Slice #429 had meanwhile given the profile a flat seed declaration: the exact
paths a consumer says a fresh worktree carries. That declaration answers the
right question directly, and it is the consumer's own statement rather than a
kit heuristic — so it, not a byte comparison, is what grants deletion authority
for the files it names. §2 keeps the comparison for everything undeclared,
which is where the irreplaceable hand-written secret actually lives.

What did **not** change: the classification model, the four rules, the absence
of persisted evidence, and the rule that a guard reads present repository state
and declarative configuration rather than reconstructing intent from bytes.
