---
name: kit-update
description: "Preview and transactionally apply a parity-verified agent-workflow-kit release without overwriting local modifications or auto-resolving conflicts."
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill kit-update --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# Kit Update

Update an installed consumer only from the public scoped package
`@ikon85/agent-workflow-kit`. The unscoped `agent-workflow-kit` package belongs
to another publisher and is never a valid update source. Existing direct
GitHub installs remain valid, but updates must use the scoped npm release so
the shared release-parity checker can prove that npm and the matching GitHub
release contain the same artifact.

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
   complete manifest-bounded candidate outside the Consumer, verifies the
   Kit-owned manifest, artifact, protocol, schema/reference, syntax, and
   transaction invariants, and activates only that verified candidate. It
   never runs a Consumer package script, configurable verification command, or
   legacy fallback. A staging or verification failure leaves the installed
   tree byte-identical.

   The staged candidate also adopts the current readiness schema without
   invoking `setup-workflow`: it preserves explicit readiness decisions and
   legacy project evidence, and seeds only newly introduced safe project-layer
   stubs whose destinations are absent. Those generated consumer-owned paths
   are destination-race checked and activate or roll back in the same
   transaction as kit files and the consumer manifest. Never create project
   data, infer an external fact, or manufacture `pending`/`not-applicable` to
   make a capability appear ready.

   Readiness-schema adoption also keeps the Claude and Codex instruction
   surfaces compatible. When exactly one applicable instruction surface has a
   non-empty `## Prod` section and another has no such section, the staged
   candidate mirrors the same section body into the missing surface. This
   narrow migration is previewed as `migrated`, destination-race checked,
   idempotent, and covered by the same verification and rollback transaction.
   It may create a missing instruction file, but it never rewrites an existing
   `## Prod` body. Empty, malformed, or divergent sections are named as
   conflicts and leave every consumer file untouched. This migration belongs
   to `kit update`; do not rerun `setup-workflow` after an ordinary update.
   Readiness JSON diagnoses only the affected path and problem category
   (`missing-file`, `missing-section`, `empty-section`, or
   `divergent-section`); it never echoes consumer content.

   Independently, run the routing-profile read-only preflight before applying
   the package candidate. A valid unchanged user-local profile reports
   `still valid` and causes zero prompts. Ask after successful Kit activation
   only when the profile is missing, invalid, materially stale, references a
   removed route, or a newly detected surface creates a meaningful choice.
   Re-inspect after package activation, present a typed delta containing only
   that changed choice, and preserve unaffected personal fields. Fingerprint
   and exclusively lock the destination before writing; a concurrent personal
   edit blocks reconciliation and remains untouched. Unattended update records
   `needs-reconcile`; it never invents a personal answer. Declining the
   routing reconcile leaves the successful Kit update applied because package
   installation and personal policy are separate transactions.

3. Read the terminal report. `aktuell` proves a second run found no upstream
   delta or pending readiness migration. A conflict report names and counts
   every category and leaves every consumer file untouched. Follow its
   recommendation and resolve each named conflict manually; never auto-merge,
   delete a local edit, or silently choose the incoming copy.

   Read all four availability categories alongside the file delta: newly
   available skill core, newly degraded optional blocks, newly blocked skill
   core, and still unresolved capability states. Missing readiness for genuinely
   new behavior does not block a compatible kit update; only that behavior stays
   unavailable. A compatible update must stop if it would make previously
   available skill core unavailable. `--yes` answers only package reconciliation
   questions and never supplies a readiness decision. Automated update pull
   requests carry the same availability summary and remain manual-merge only.

   For each conflicted kit-shipped file, always ask the user whether the local
   edit is a generic improvement or project-specific; never decide or act
   automatically. For a generic improvement, offer to file an issue in the
   public kit repository and keep the local edit in place as a bridge until a
   kit release containing the improvement lands. Before running
   `gh issue create --repo <owner>/agent-workflow-kit`, show a sanitized preview
   of the exact title and body with consumer identifiers and secrets stripped,
   then require the user's explicit approval. The consumer user does not need
   to be a kit maintainer. For a project-specific edit, recommend
   `npx @ikon85/agent-workflow-kit@latest own <path>` so future updates treat
   that path as consumer-owned.

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
three-way diff, and atomic-write seams remain the source of truth. A failure
also names its transaction phase and whether consumer state stayed unchanged or
was rolled back.
