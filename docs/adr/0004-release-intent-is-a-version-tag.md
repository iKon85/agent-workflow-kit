# Release intent is an explicit version tag

Status: accepted (2026-07-22, issue #204)

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

- A prepared version may temporarily exist on `main` in an `awaiting-tag` state.
- An AFK wave may create its own tag after all pre-authorized landing gates pass;
  the next program wave still requires separate authorization.
- Reruns reconcile the same tag and never infer that a red workflow means
  nothing was published.
