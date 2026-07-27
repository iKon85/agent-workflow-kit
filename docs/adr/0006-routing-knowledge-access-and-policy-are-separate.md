# Routing knowledge, access, and policy are separate

Status: accepted (2026-07-22, Program #197) — the optimization-dial clause is
superseded by
[ADR-0010](./0010-model-roster-replaces-the-optimization-dial.md)
(items 3 and the "Model preferences and optimization overrides" sentence below;
everything else stands)

Planning cannot safely persist a concrete recommended model. Provider catalogs
change, model names age, effort behavior differs by model, agent surfaces expose
different controls, and a surface may reach another provider through a plugin
or CLI transport. A recommendation that is correct in one session can therefore
be nonexistent, unreachable, or unenforceable in the session that implements
the work.

We decided to keep three identities separate:

1. The Kit-maintained **Evidence catalog** contains all known provider models
   and observations, whether or not the active surface can use them. Each
   decision-grade observation retains the complete configuration identity:
   model, effort, harness, workload, source, benchmark version, uncertainty,
   freshness, and cost.
2. The user-local **Access graph** records the native and cross-provider paths
   available from each agent surface. Claude Code and Codex attest only their
   own runtime capabilities. A detected transport is not automatically approved,
   and neither surface claims another surface's unverified capabilities.
3. The user-local **Routing policy** records allowed surfaces and transports,
   switching autonomy, optimization goals, and optional advanced overrides.
   Personal choices do not alter catalog facts.

Durable plans and issues contain only a provider-neutral **Routing intent**.
At execution time a resolver compares all evidence-backed candidates, filters
them through the Access graph and Routing policy, and produces a one-execution
**Route decision**. It reports the best overall route separately from the best
currently executable route. An unreachable preference follows the user's
explicit handoff, fallback, or block policy.

Every surface adapter declares how independently it can control model and
effort: per spawn, through a named agent definition, through a session default,
or not at all. Environment precedence is part of the capability proof. An AFK
subagent requires enforced model and effort selection and emits a **Dispatch
receipt** containing the requested and applied route, enforcement method, and
policy/evidence revisions. Silent inheritance and unverified degradation are
not valid AFK routes.

Setup keeps the technical model behind a simple user decision. It presents a
registry-driven list of familiar agent surfaces, preselects detected entries,
and asks whether the Kit may switch automatically, ask before switching, or use
only the current surface. Adapters establish providers, transports, model
selectors, and effort controls. Model preferences and optimization overrides
remain optional advanced settings.

An existing installation without a routing profile receives this choice once
through setup or the first compatible Kit update. Later updates perform a
read-only preflight and ask again only when the profile is missing, invalid,
materially stale, references a removed route, or a newly detected surface makes
a meaningful choice available. Installing Kit mechanics and changing personal
policy are separate transactions; unattended update never invents a decision.

BenchLM may populate discovery, catalog, pricing, freshness, coverage, and
corroboration signals. Its aggregate scores are not decision-grade routing
observations because effort and harness identity may be collapsed and missing
evidence may be estimated. DeepSWE, Artificial Analysis, OpenHands, Arena, and
other benchmark-owner artifacts remain authoritative for the claims they
actually measure. Local experience may calibrate policy but does not rewrite
public evidence.

## Considered options

- **Persist a concrete model and effort in every issue:** rejected because the
  recommendation ages and may not be executable on the implementing surface.
- **Maintain separate Claude and Codex routing tables:** rejected because it
  duplicates evidence, hides cross-provider routes, and lets the two surfaces
  drift.
- **Filter the shared table during setup:** rejected because current access is
  a user/runtime fact, not a limit on routing knowledge.
- **Ask users to describe transports and enforcement capabilities:** rejected
  because these are adapter facts most users cannot answer reliably.
- **Route directly from a composite leaderboard:** rejected because benchmark,
  harness, effort, uncertainty, and workload boundaries would be lost.
- **Re-run the routing interview on every Kit update:** rejected because a valid
  user-owned profile should remain stable until a material choice changes.

## Consequences

- Model/provider churn updates the catalog and resolver without rewriting
  durable issues.
- Both Claude Code and Codex read one local policy while proving their own
  execution capabilities independently.
- Cross-provider dispatch is expressible without pretending that every surface
  can reach every model.
- The Kit must maintain source adapters, schema migration, capability probes,
  last-known-good evidence, and dispatch receipts.
- Different machines do not share personal routing state unless the user later
  chooses an explicit export or private synchronization mechanism.
