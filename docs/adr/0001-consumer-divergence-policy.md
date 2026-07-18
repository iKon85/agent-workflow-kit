# Consumer divergence policy: clean shipped files, owned exceptions, upstream route as a question

Status: accepted (2026-07-18, issue #130)

Since the consumer-source cutover the kit is SSOT for shipped files, but
consumers keep learning: edits made directly on a shipped file in a consumer
silently fork it, and every subsequent `kit-update` reports a permanent
conflict (observed: 6 recurring conflicts in testreporter on 0.27.1).

We decided on a three-part policy:

1. **Clean shipped files.** A kit-shipped file in a consumer carries no
   project-specific content — including no project issue references in
   comments. Generic improvements are ported upstream (reference-free,
   English) and return via `kit-update`; project-specific needs live in
   consumer-native files or consumer-owned paths.
2. **Consumer-owned paths as the marked exception.** A consumer may claim a
   genuinely forking file via `own <path>` (manifest `origin: 'consumer'`).
   The reconciler then skips it entirely: no overwrite, no conflict report, no
   deletion prompt. The cost — forgoing all future kit improvements to that
   file — is deliberate and made visible on demand via `diff --owned`, never
   as warning noise in normal updates.
3. **Upstream route as a question.** When a shipped file is about to be
   edited in a consumer (retro finding or direct edit), the shipped rule asks
   the user whether the change should go upstream as a kit issue
   (`gh issue create --repo iKon85/agent-workflow-kit`, lightweight: title +
   short body). It never assumes the user is the kit maintainer and never
   files automatically.

## Considered options

- **`own` for mixed scripts too** (e.g. `scripts/board-sync.py` with both
  generic timeout fixes and project issue-reference comments): rejected —
  owning the kit's most active script means no upstream fix ever reaches it
  again.
- **Accepting perpetual conflicts**: rejected — that is exactly the noise
  this policy removes; conflict reports must stay meaningful.
- **Routing rule in the maintainer's global config or a standalone
  convention doc**: rejected — the rule must ship with the kit (retro skill,
  kit-update skill, enforcement hook) so it reaches every consumer,
  versioned, including consumers not run by the maintainer.

## Consequences

- Consumers lose the habit of annotating shipped scripts with their own
  issue numbers; provenance for shipped files lives in the kit's history.
- The reconciler gains an `own`/`disown` surface and a `consumerOwned`
  report bucket; owned files fall permanently behind the kit unless
  explicitly disowned after a peek.
