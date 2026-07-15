---
name: kit-release
description: "Prepare a verified release PR for agent-workflow-kit, delegate landing to wrapup, then monitor the trusted post-merge publishing flow through npm/GitHub parity."
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

5. After merge, monitor the `release.yml` workflow and inspect its externally
   reconstructable state:

   ```sh
   gh run list --workflow release.yml --limit 1
   npm run release:status
   ```

   `awaiting-npm` means the trusted workflow has not published yet;
   `awaiting-github` means npm readback passed and a safe rerun will skip npm
   publish and resume at GitHub; `released` means local, npm, and the GitHub
   release asset have identical version, manifest hash, and tarball integrity.
   The release is complete only at `released`.

   The registry identity is **`@ikon85/agent-workflow-kit`**. The unscoped
   `agent-workflow-kit` package is owned by another publisher and must never be
   queried, published, or treated as this repository's release.

   Before the first real release, the npm package must name this repository's
   exact `.github/workflows/release.yml` as its GitHub Trusted Publisher. If it
   does not exist yet, stop for a separately confirmed one-time bootstrap
   publish; npm only permits trust configuration for an existing package. That
   bootstrap creates the scoped package but does not replace the first real
   OIDC/provenance release. Never request, store, or substitute an npm token,
   and never publish or create a release ad hoc beyond that explicit bootstrap.

## Guard contract

`npm run release:guard -- --base <base-ref>` freshly builds the shipped
manifest and compares it with both the base and the checked-in manifest. It
blocks an unbumped shipped delta, a stale manifest, a too-small Semver bump, or
a dead manifest entry and prints the concrete paths. CI runs the same command;
there is no separately remembered shipped-file list.
