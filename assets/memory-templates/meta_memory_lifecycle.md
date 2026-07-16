# Memory Lifecycle Policy

This file is consumer-owned after its first seed. Edit roots, retention classes,
and review cadence to match the repository. Kit updates must never overwrite it.

## Retention classes

- Active: still relevant to current work and safe to load.
- Archive candidate: useful history that should leave the active set.
- Protected: user-profile, preference, or other content that must not be pruned
  by an automated repository workflow.

## Archive and restore

- Archive only inside the configured consumer-owned archive root.
- Preview every action before mutation.
- Restore only with an explicit restore grant.
- Preserve the archive and refuse destination collisions.
- Record path verdicts and hashes in a content-free, collision-safe receipt.

## Pruning

Pruning is never implied by setup, update, archive, or restore. It requires a
separate preview and explicit user approval. A failed or interrupted operation
must leave the last safe active and archived state recoverable.
