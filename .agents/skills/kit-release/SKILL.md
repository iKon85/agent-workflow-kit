---
name: kit-release
description: "Prepare, integrate and publish a verified agent-workflow-kit release: one confirmed Semver authorizes the annotated version tag, then monitor npm/GitHub parity to released."
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill kit-release --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# Kit Release

Prepare a release deterministically. This skill owns the shipped-delta decision,
metadata preparation, verification, and the post-merge publication intent. It
delegates commit, branch push, PR, merge, and cleanup to wrapup. It never
publishes to a registry or creates a GitHub release by hand — it records intent
with the annotated tag and lets the trusted workflow publish.

The release has **one** human gate: the confirmed Semver in step 2. Everything
after it — merge, tag, publish, parity check — is the agent's to carry out.

## Workflow

1. Run the read-only plan:

   ```sh
   npm run release:prepare
   ```

   Report every added, removed, and changed shipped path plus the recommended
   Patch, Minor, or Major bump. The recommendation is deterministic: removals
   recommend Major, additions recommend Minor, and changed content recommends
   Patch.

2. Resolve authority for exactly one target Semver:

   - Normally, ask the user to confirm the target before changing release
     metadata. A recommendation is advice; the confirmed target is authority.
   - When the caller carries an **explicit AFK end-to-end mandate** whose scope
     includes release preparation, accept the deterministic recommendation as
     the target for **reversible metadata preparation** and record that choice.
     Do not turn a narrower build-only or single-action request into this
     authority.

   Either route authorizes exactly one target — and that authorization carries
   through to its tag and publish. This is the release's single human gate.

3. Prepare that authorized exact version:

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

5. Publish. Merging integrates the prepared release; only the annotated tag
   starts publication. Verify that the package version on current `origin/main`
   is exactly `<version>`, then create and push the matching annotated
   `v<version>` tag — **the confirmed Semver authorizes the whole release,
   through tag and publish, so do this without asking again**. The target was
   chosen once, at step 2; nothing between there and here produces information
   a second gate could act on. Report the integrated commit as you tag it, not
   as a question.

   Publication is **irreversible** — npm versions cannot be reused, and the
   unpublish window is narrow and breaks consumers. The safety lives in gates
   that already ran, not in a prompt: `release:guard`, `kit:staleness`, the full
   suite and `npm pack --dry-run` before merge, then the workflow's own tag
   identity, package version, main ancestry and artifact checks after it. A
   lightweight tag, a mismatching version, or a commit outside canonical `main`
   is invalid release intent. Never infer a tag target, move an existing tag, or
   tag an unmerged commit.

6. Monitor the tag-triggered `release.yml` workflow and inspect its externally
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

   Manual dispatch is recovery only. It requires the explicit existing
   annotated tag and runs the same idempotent reconciler:

   ```sh
   gh workflow run release.yml -f tag=v<version>
   ```

   Use it only after reconstructing the release state for that tag. Never use
   dispatch as the normal publication route or substitute a new version for a
   partial release.

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

It also blocks a **version bump stacked on an untagged previous release**: if
the base version carries no matching annotated tag, that release is still
`awaiting-tag` and never became its own artifact. Tag and publish it first —
never bury it under the next bump. A repository with no matching tag at all is
bootstrapping its first release and is not blocked.

A red release run does not prove nothing was published. Reconstruct the real
state from the registry and the release before reacting; a stale local
packument cache can answer "not published" for a package that is live, and the
recovery route is the idempotent reconciler on the existing tag, never a new
version.
