---
name: memory-lifecycle
description: "Preview and apply a consumer-owned memory lifecycle without crossing configured roots or overwriting active, archived, or recovery evidence. Use when a user wants to restore archived memories, inspect memory placement, or run an approved memory recovery."
---

# Memory Lifecycle

Coordinate the current repository's memory placement and recovery through the
deterministic helper at `scripts/memory-lifecycle/index.mjs`. The helper owns
path validation, dry-run verdicts, exclusive restore writes, hashing, and
receipts. Keep this skill thin: do not reimplement those rules with shell file
operations.

## Boundaries

- Work only below the consumer-owned roots in
  `docs/agents/workflow-capabilities.json`.
- Never scan another repository or a user-global memory root that the current
  consumer profile does not explicitly own.
- Treat active memories, archives, policy templates, and restore receipts as
  consumer-owned. Never overwrite them.
- `init`, `update`, and an ordinary `setup-workflow` rerun must not enable this
  capability or change placement, retention, restore, or pruning grants.
- Destructive pruning is outside the helper. It requires a separate preview and
  explicit user approval; do not infer that approval from restore permission.

## Consumer profile

Adopt the `memoryLifecycle` section of
`docs/agents/workflow-capabilities.json`. Missing or disabled configuration is
a valid no-write `disabled` result.

```json
{
  "memoryLifecycle": {
    "enabled": true,
    "activeRoot": ".memory/active",
    "archiveRoot": ".memory/archive",
    "receiptRoot": ".memory/receipts",
    "approvals": { "restore": false, "prune": false },
    "memories": [
      { "path": "decisions/example.md", "enabled": true }
    ]
  }
}
```

Preserve unknown profile keys. Every configured root and candidate path must be
repository-relative. Absolute paths, parent escapes, symlink traversal,
different-content collisions, and missing restore approval are refused.

## Workflow

1. **Preview.** Run:

   ```sh
   node scripts/memory-lifecycle/index.mjs
   ```

   This is the default no-write mode. Count the candidate paths and confirm each
   appears exactly once as `create`, `restore`, `preserve`, `skip`, or `refuse`.
2. **Review refusals.** Explain every refusal. Do not weaken root, symlink,
   collision, or approval checks to make the run green.
3. **Confirm recovery.** Before applying, require the consumer profile's
   `approvals.restore` to already record the explicit restore grant. A chat
   instruction does not silently rewrite the tracked policy.
4. **Apply.** Run:

   ```sh
   node scripts/memory-lifecycle/index.mjs --apply
   ```

   The helper restores with exclusive-create semantics and keeps the archive.
   A concurrent destination collision becomes `refused`, never an overwrite.
5. **Read back.** Verify restored files by path and hash, not by printing memory
   contents. Confirm the receipt has schema/source versions plus
   `restored`/`skipped`/`refused` path verdicts and contains no memory content.
6. **Rerun.** Run the preview again. An identical restored file is preserved;
   the rerun writes no duplicate receipt.

Use `--profile <repository-relative-path>` only when the repository documents a
different consumer-owned profile location.

## Final report

Report:

- dry-run counts for all five action classes;
- applied `restored`/`skipped`/`refused` counts;
- receipt path and source versions, without memory contents;
- archive-preservation and rerun/no-write result;
- any pruning request left pending explicit approval.
