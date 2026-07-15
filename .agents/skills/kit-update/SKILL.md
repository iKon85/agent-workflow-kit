---
name: kit-update
description: "Preview and transactionally apply a parity-verified agent-workflow-kit release without overwriting local modifications or auto-resolving conflicts."
---

# Kit Update

Update an installed consumer only from the public scoped package
`@ikon85/agent-workflow-kit`. The unscoped `agent-workflow-kit` package belongs
to another publisher and is never a valid update source. Existing installs from
`npx github:iKon85/agent-workflow-kit` remain valid, but updates must use the
scoped npm release so the shared release-parity checker can prove that npm and
the matching GitHub release contain the same artifact.

## Workflow

1. Preview the delta without writing:

   ```sh
   npx @ikon85/agent-workflow-kit@latest diff
   ```

   Review the named added, updated, locally modified, removed, and conflicting
   paths. Do not reinterpret a local modification as permission to overwrite it.

2. Apply the update:

   ```sh
   npx @ikon85/agent-workflow-kit@latest update
   ```

   The command checks npm/GitHub release parity before staging. It prepares a
   complete candidate outside the consumer, runs the consumer's existing
   `npm test` command there, and activates only a verified candidate. A staging
   or verification failure leaves the installed tree byte-identical.

3. Read the terminal report. `aktuell` proves a second run found no upstream
   delta. A conflict report names and counts every category and leaves every
   consumer file untouched. Follow its recommendation and resolve each named
   conflict manually; never auto-merge, delete a local edit, or silently choose
   the incoming copy.

4. If a candidate is interrupted, discard its reported stage directory or
   resume the transaction through the update API's `resumeFrom` option. Do not
   copy staged files into the consumer by hand.

5. Check the optional project census after the update:

   ```sh
   python3 .claude/hooks/drift-guard.py --census-status
   ```

   When the report names a newer census builder or `refresh_required`, advise
   the user to run `$census-update`. The kit updater must never overwrite a
   consumer-owned census, profile, local scanner, decision, or override. A
   missing, disabled, unactivated, or temporarily unavailable census remains a
   visible manual-walk condition and does not invalidate an otherwise verified
   kit update.

## State contract

The update API reports `checking -> preview/awaiting_decision -> staging ->
verifying -> applied | conflicted | failed | aborted`. `conflicted`, `failed`,
and `aborted` never authorize partial activation. The existing manifest,
three-way diff, and atomic-write seams remain the source of truth.
