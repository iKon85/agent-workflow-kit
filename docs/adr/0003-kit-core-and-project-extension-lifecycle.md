# Kit Core and project extensions have separate identities

Status: accepted (2026-07-22, issues #190, #194, #196, #197)

The original divergence policy allowed any shipped path to become
consumer-owned. That is safe for a genuinely project-specific file, but not for
a protocol authority such as the skill/readiness registry: once a consumer
owns that mixed file, new Kit declarations stop arriving while local additions
and stale Kit declarations remain indistinguishable. A real consumer exhibited
exactly this state: the installed readiness harness was current while its owned
registry had no readiness capabilities or declarations.

We decided to model four explicit lifecycle states instead of treating every
local difference as file ownership:

1. **Kit Core** remains upstream-owned under the Kit's canonical identity. A
   consumer cannot permanently own it under that same identity.
2. **Project extensions** live on separate consumer-owned surfaces. Every
   shipped skill may load its optional `docs/agents/skills/<skill>.md`; local
   skill identities live in a separate local registry. Neither surface changes
   the corresponding Kit Core.
3. A **Contribution bridge** may temporarily retain a registered local Core
   experiment. It must resolve into a project extension, a generalized upstream
   contribution that returns in a release, or an explicit fork.
4. An **Explicit fork** has its own identity, version, and update line. Semantic
   divergence cannot masquerade indefinitely as the canonical Kit skill.

An update composes and validates the complete protocol group in an isolated,
manifest-derived staged candidate. It never infers an ownership decision from
`--yes`: an unclassified collision blocks unchanged until a user classifies it.
Existing mixed states migrate semantically, preserving local identities and
project metadata on their new surfaces; an ambiguous semantic change blocks
instead of being overwritten or frozen silently.

The upstream route is capability-based, not maintainer-specific. At the moment
of contribution, repository permissions and an optional machine-local upstream
checkout determine whether the approved route can use a direct pull request, a
fork, or an issue. No consumer asks who the user is, and no telemetry reports
local edits automatically.

## Considered options

- **Keep arbitrary consumer-owned shipped paths:** rejected because a protocol
  authority then stops receiving schema and behavior evolution under the same
  identity.
- **Add more merge rules to the mixed registry:** rejected because local skills,
  project annotations, readiness declarations, and upstream skill definitions
  have different ownership and lifecycle semantics.
- **Overwrite Core and discard local changes:** rejected because it loses valid
  project behavior and can destroy unregistered work.
- **Special-case the maintainer:** rejected because identity is irrelevant; the
  portable distinction is whether the user has an approved route and the
  required repository capabilities.

## Consequences

- ADR-0001 remains valid for genuine consumer-owned files but is narrowed for
  Kit Core and mixed registries.
- Core updates can advance without erasing project-specific behavior.
- Consumers gain explicit extension, contribution, and fork lifecycles instead
  of permanent accidental divergence.
- Migration requires a one-time semantic classification of existing mixed
  states and must fail closed when that classification is ambiguous.
