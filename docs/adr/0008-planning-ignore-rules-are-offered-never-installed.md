# Planning ignore rules are offered, never installed

Status: accepted (2026-07-26, #255)

The shipped planning skills write `PLAN.md`, `PLAN-REVIEW-LOG.md`, and
`ANNAHMEN.md` into a session worktree, and several of them told the agent those
files were gitignored and lived on disk only. In a consumer repository that was
simply untrue: `init` and `update` never touch `.gitignore`, and no installed
file adds the rules. The consequence mirrors what this repository fixed for
itself in #254 — every planning worktree reports a permanently dirty tree, the
shipped Worktree Lifecycle cleanup refuses to remove it, genuinely unlanded work
becomes indistinguishable from plan scratch, and a consumer who never notices
can commit a plan doc into their history that the prose implied could not be
committed.

The constraint is the consumer contract. Consumer-owned files are written once
and never overwritten by ordinary reconciliation, and `.gitignore` is stronger
still: the kit does not own it at all and has no manifest entry, no baseline
hash, and no three-way reconcile for it. A file the kit cannot reconcile is a
file the kit must not write uninvited.

We decided to close the gap from both ends:

1. **`/setup-workflow` offers the rules as an explicit, previewed, approved
   step.** Section A11 previews with
   `python3 scripts/worktree-lifecycle/ignore_seed.py preview`, shows the exact
   lines verbatim, asks, and only an approval runs `apply`. The write is
   append-only inside one idempotent marker block. It never rewrites, reorders,
   or removes an existing line; a re-run is a byte-identical no-op; a decline
   changes nothing; a repository that already ignores the artefacts reports
   `nothing to do`; and a marker block the consumer has since edited is
   `blocked`, never repaired. Nothing in `init` or `update` can reach the
   seeder.
2. **Shipped skill prose states the assumption instead of asserting the fact.**
   A skill now says these artefacts are *expected* to be ignored and names
   `/setup-workflow` as the thing that can make it true, rather than claiming
   the kit already did. The claim is pinned by a census lint over both skill
   trees, so the assertion cannot silently return.

This is the same shape the kit shipped for the GitHub-Projects board in 0.39.0
(#24): offer, preview, obtain an explicit yes, never write an outward or
consumer-owned artefact silently.

Which artefacts the offer covers is a kit-owned fact — the kit knows which files
its own skills write — declared once in
`scripts/worktree-lifecycle/plan-artifacts.json`. That is deliberately not the
consumer's `worktreeLifecycle.scratchPatterns`, which is derived *from* the
consumer's ignored planning artefacts and would otherwise be circular: before
this decision there was nothing ignored for it to be derived from.

## Considered options

- **Append-only seed at `init`:** rejected. It respects append-only mechanics
  but still writes a file the kit does not own, uninvited, on first install —
  the one action the consumer contract exists to prevent.
- **Readiness capability only:** rejected. Reporting the gap and letting the
  affected skills degrade honestly leaves the friction in place and fixes
  nothing for the consumer who wants the promise to hold.
- **Prose-only fix:** rejected as insufficient on its own. It removes the false
  claim but leaves every consumer with dirty planning worktrees and a cleanup
  that refuses to run. It is kept as one half of the decision, not the whole.
- **Deriving the rules from `worktreeLifecycle.scratchPatterns`:** rejected as
  circular, and because that array is consumer-owned deletion-adjacent policy
  that Core never supplies defaults for.
- **Untracking an already-committed artefact:** rejected. An ignore rule cannot
  untrack a tracked file, and running `git rm` on consumer history is far past
  what a setup step may do. The seeder reports the tracked artefact and stops.

## Consequences

- A consumer who runs `/setup-workflow` and approves gets the guarantee the
  skills describe; a consumer who declines keeps a byte-identical `.gitignore`
  and loses nothing but the convenience.
- The never-overwrite contract is untouched: the only write is an append behind
  an explicit yes, and `update` reconciliation still never touches
  `.gitignore`.
- The offer reaches only consumers who run setup again. That is accepted: it is
  the price of not writing an unowned file, and re-running `/setup-workflow` is
  already the documented way to pick up a new project-layer capability.
- After an approval, `scratchPatterns` derivation finally has real ignored
  planning artefacts to read, so the Worktree Lifecycle scratch classification
  stops being vacuous in a fresh consumer repository.
- A consumer who edits or deletes the marker block owns the outcome; the kit
  reports and stops rather than restoring its own block.
