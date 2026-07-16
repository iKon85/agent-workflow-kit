---
name: project-release
description: "Preview and prepare one coherent version change across a consumer's profiled packages without duplicating release logic or creating commits, tags, pushes, publishes, or merges."
---

# Project Release

Prepare a consumer-owned multi-package release through the kit's shared
SemVer, preview, and transactional apply engine. This skill changes only the
profiled version files. It does not commit, tag, push, publish, or merge.

## Profile contract

Read `docs/agents/workflow-capabilities.json`. The consumer owns this file and
its unknown keys. Project Release requires this versioned section:

```json
{
  "schemaVersion": 1,
  "projectRelease": {
    "versionFiles": [
      "package.json",
      "packages/example/package.json"
    ],
    "tagPrefix": "v"
  }
}
```

Every `versionFiles` path is repository-relative and must name a JSON file with
the same current SemVer. Never infer or silently add package files.

## Workflow

1. Run a byte-neutral preview for exactly one Patch, Minor, Major, or explicit
   SemVer target:

   ```sh
   node scripts/project-release.mjs preview <patch|minor|major|version>
   ```

2. Report the structured result: exact current and target version, package
   count, synchronized files, planned commit/tag actions, confirmation token,
   and every blocker. Invalid or divergent versions, dirty profiled targets,
   and an existing target tag block before the first write.

3. Ask the user to confirm the exact target and preview confirmation token.
   Do not treat a bump recommendation or a prior preview as confirmation.

4. Apply only that still-current preview:

   ```sh
   node scripts/project-release.mjs apply <patch|minor|major|version> \
     --confirm <confirmation-token>
   ```

   Apply re-reads repository facts and every target byte. A stale token,
   changed target, blocked preview, partial write, or repeated apply fails
   without a double bump. Partial writes roll back to the original bytes.

5. Inspect the resulting version-file diff, then hand commit, tag, push,
   publish, and merge to the repository's normal release/landing workflow.
   Project Release does not commit, tag, push, publish, or merge.

## Safety contract

- Preview is repeatable and byte-neutral.
- Apply writes only `projectRelease.versionFiles`.
- Commit and tag entries in preview output are plans, never side effects.
- Existing tags are never overwritten.
- No runtime dependency is required beyond Node.js and Git.
