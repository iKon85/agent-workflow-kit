# Release intent is an explicit version tag

Status: accepted (2026-07-22, issue #204)

Clarified 2026-07-25 by issue #239: an explicit AFK end-to-end mandate may
authorize deterministic reversible release preparation, but never the
publication tag itself.

Amended 2026-07-25 by issue #257: the confirmed Semver authorizes the whole
release, through tag and publish. The separation of integration and publication
below is unchanged — merging still cannot publish, and only an annotated tag
records release intent — but that intent no longer waits for a second human
confirmation. The maintainer chooses the version once; the agent then merges,
tags, and monitors to `released`. The second gate had proven worse than no gate:
it left prepared versions sitting in `awaiting-tag` until someone returned,
which is how 0.34.2 was skipped and buried under 0.34.3 (#243). Safety stays in
the gates that run regardless of who is watching — guard, staleness, suite,
pack, and the workflow's own tag/version/ancestry validation.

The release workflow currently publishes whenever a merge to `main` changes
`package.json`. That keeps the canonical branch and npm close together, but it
also makes an ordinary merge an irreversible public action whose consequence is
not visible in the merge affordance. A failed post-publish readback can further
make the run red after npm has already accepted the version.

We decided that integration and publication are separate transitions:

1. Merging a prepared version into `main` integrates it but does not publish it.
2. A matching annotated `v<version>` tag on that `main` commit records Release
   intent and starts the normal publish workflow.
3. The workflow validates tag, package version, canonical-branch ancestry,
   artifact integrity, and tests before publishing.
4. A manual dispatch is a recovery/reconciliation route for one explicit tag,
   never the ordinary release trigger.
5. Publication completes only when npm and the GitHub release are both visible
   and match the local version, manifest, and tarball. Eventual-consistency
   readbacks use bounded retry and preserve an externally reconstructable state.

## Considered options

- **Merge-triggered publishing:** rejected because merge acceptance and
  irreversible publication remain one implicit action.
- **Manual dispatch as the normal route:** rejected because the release identity
  is easier to forget and less durable than a version tag.
- **PR label or commit marker:** rejected because it introduces hidden release
  semantics without giving the publication a first-class Git identity.
- **Environment approval on the merge-triggered workflow:** rejected as the
  primary contract because it adds a UI gate but still does not represent the
  approved version as a durable release object.

## Consequences

- A prepared version exists on `main` in an `awaiting-tag` state only for as
  long as the agent needs to tag it — not until a human returns (amended by
  #257).
- The authorizing act is the confirmed Semver. An explicit AFK Wave/Program
  mandate that names release preparation carries the same weight, and either
  route reaches through tag and publish for that one target. A narrower
  build-only or single-action request never becomes this authority.
- A single-Wave mandate does not authorize the next Program Wave. A later
  explicit whole-Program mandate does authorize all planned Waves and remains in
  force across their boundaries.
- Reruns reconcile the same tag and never infer that a red workflow means
  nothing was published.
