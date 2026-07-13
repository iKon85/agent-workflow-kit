---
name: kit-release
description: "Prepare a verified release PR for agent-workflow-kit with an explicit Semver confirmation, regenerated manifest, full tests, and pack audit, then delegate landing to wrapup."
---

# Kit Release

Prepare a release deterministically. This skill owns the shipped-delta decision,
metadata preparation, and verification. It does not implement commit, push, PR,
merge, registry publishing, tags, or release creation.

## Workflow

1. Run the read-only plan:

   ```sh
   npm run release:prepare
   ```

   Report every added, removed, and changed shipped path plus the recommended
   Patch, Minor, or Major bump. The recommendation is deterministic: removals
   recommend Major, additions recommend Minor, and changed content recommends
   Patch.

2. Ask the user to confirm exactly one target Semver. Do not change release
   metadata before confirmation. A recommendation is advice; the confirmed
   target is authority.

3. Prepare that exact version:

   ```sh
   npm run release:prepare -- --version <confirmed-version>
   ```

   The script updates `package.json`, adds the release-notes section,
   regenerates `agent-workflow-kit.package.json`, runs the full test gate, and
   performs `npm pack --dry-run`. If a gate fails, report the error and keep the
   prepared tree. Re-running the same target resumes that state without another
   bump or duplicate release notes.

4. Inspect the resulting delta and invoke **`$wrapup`**. Wrapup and
   `scripts/wrapup-land.py` exclusively own commit, push, PR creation, merge,
   and cleanup. Do not reproduce those operations here.

5. After merge, the release is not complete until the repository's configured
   publishing flow has produced the matching registry package and GitHub
   tag/release and verified their parity. If that flow is not configured, stop
   and report the missing post-merge capability; never publish ad hoc.

## Guard contract

`npm run release:guard -- --base <base-ref>` freshly builds the shipped
manifest and compares it with both the base and the checked-in manifest. It
blocks an unbumped shipped delta, a stale manifest, a too-small Semver bump, or
a dead manifest entry and prints the concrete paths. CI runs the same command;
there is no separately remembered shipped-file list.
