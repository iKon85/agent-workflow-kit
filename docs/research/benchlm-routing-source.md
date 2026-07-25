# BenchLM as a routing-evidence source

**Researched:** 2026-07-22  
**Question:** What role, if any, should BenchLM play in the Kit's evidence-backed
model and effort routing, and what does that imply for setup and kit-update?

## Decision

Use BenchLM as a **catalog, discovery, and corroboration source**, not as an
authoritative routing source.

BenchLM is unusually useful for finding new model families, benchmarks,
pricing changes, supersession relationships, and gaps in current evidence. It
must not directly choose a dispatch route, especially an effort level. A route
observation still has to come from the benchmark owner and retain the complete
configuration identity: model, effort, agent/harness, benchmark version,
quality metric, uncertainty, and task cost.

This gives the source hierarchy:

1. **Benchmark owner artifacts** (DeepSWE, Artificial Analysis, OpenHands,
   Code/Design Arena) provide decision evidence.
2. **BenchLM** discovers and cross-checks those sources and model releases.
3. **Local user evidence and preferences** calibrate the resulting policy.
4. The approval-gated policy reconciler proposes, but never silently applies,
   routing changes.

## What BenchLM contributes

BenchLM currently tracks 290 models and 323 benchmarks. Its useful coverage
includes agentic work, coding, multimodal work, model pricing, context windows,
runtime signals, release metadata, and supersession chains. Its methodology
currently gives ranking weight to three agentic and five coding benchmarks;
many more sources, including DeepSWE and most frontend sources, are display-only
context ([methodology](https://benchlm.ai/methodology)).

Frontend coverage is useful primarily as a source map. The current focused page
combines sourced React Native Evals, Design2Code, Vision2Web, and related
browser-task evidence, but calls itself a reporting family rather than a
weighted category, contains only seven eligible models, and warns that models
may have as few as two source rows
([frontend/app-dev view](https://benchlm.ai/best/frontend-app-dev)). The owners
remain more authoritative: [React Native Evals](https://rn-evals.vercel.app/)
publishes agent success, token, and cost results, while
[Vision2Web](https://vision2web-bench.github.io/) explicitly evaluates
model-plus-framework submissions across visual, interactive, and full-stack
tasks.

BenchLM also exposes confidence separately from score, 90% score intervals,
`Supported` versus `Estimated` states, source-coverage counts, and a dated
BenchAlign method/frozen-input identifier. That is valuable for shortlisting
and for detecting insufficient evidence, but it is confidence in BenchLM's
composite inference rather than a pass-rate interval for our exact workload
([confidence method](https://benchlm.ai/benchmark-confidence)).

## Why it cannot drive routing directly

### Effort and harness can disappear

BenchLM's exported Sol model row records DeepSWE as `72.7`, but not the effort,
harness, confidence interval, or cost
([models export](https://benchlm.ai/data/models.json)). The owner artifact shows
that this number is specifically `gpt-5-6-sol + mini-swe-agent + max`: 72.7%
Pass@1 over four whole-benchmark runs, with a 95% run-to-run interval and about
$8.39 mean cost per scored attempt
([DeepSWE v1.1 artifact](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json)).

This collapsing is fatal for model-plus-effort selection. Some older model
families have explicit `high` or `max` variants in the BenchLM catalog, while
current Sol, Terra, Luna, and Fable evidence can be folded into one base-model
row. The overall/category scores therefore describe mixed published
configurations, not a consistent effort curve.

### Composite rankings are editorial inference

BenchAlign normalizes unlike protocols, combines source families, and imputes
missing evidence with wider uncertainty. BenchLM publishes the method version,
frozen-input identifier, weighted benchmark list, and dated output, but its
public downloads reference internal source files rather than a published,
locally reproducible BenchAlign implementation. The composite is reproducible
as a cached dated output, not independently rebuildable by the Kit from public
code ([methodology](https://benchlm.ai/methodology)).

Raw source rows are more useful than the composite, but the current
machine-readable model export is a numeric benchmark map without per-row source
URLs or complete execution settings. The Kit must follow the benchmark catalog
to the owner rather than treating `models.json` as normalized routing evidence.

### Current semantic inconsistencies require defensive ingestion

The same-day exports currently contain examples that a production adapter must
reject or downgrade:

- BenchLM's DeepSWE Markdown page says that source metadata is preserved but
  reports zero leaderboard models, while `models.json` contains six DeepSWE
  scores.
- `benchmarks.json` currently contains duplicate `sweMultimodal` definitions.
- Its Design2Code and Vision2Web catalog entries currently point to a provider
  documentation page rather than the benchmark owners. The official
  [Design2Code repository](https://github.com/NoviScl/Design2Code) and
  [Vision2Web site](https://vision2web-bench.github.io/) show the correct
  provenance.

These may be transient publishing defects, but they make last-known-good,
semantic validation, and owner verification mandatory.

## Machine-readable access, cadence, and legal posture

BenchLM documents MIT-licensed JSON downloads for leaderboard, models,
benchmarks, pricing, speed, and comparisons. Each export currently has
`schemaVersion`, `generatedAt`, and `sourceLastUpdated`; `updates.json` provides
a cheap change feed. BenchLM says it refreshes several times per week and often
within hours of major launches ([dataset documentation](https://benchlm.ai/data)).

The adapter should use the documented `/data/*.json` downloads and
`updates.json`, not scrape rendered pages. Fetch at low cadence, send ordinary
conditional requests where supported, retain attribution, and persist the raw
snapshot hash and generation timestamp.

There is one governance warning: the current Terms page still visibly contains
launch placeholders for operator identity, jurisdiction, effective date, and
contact details. It permits published downloads under their stated licenses
and non-degrading automated access, but this unfinished legal surface reduces
operational confidence. The MIT dataset declaration is clear; nonetheless the
adapter should not depend on high-frequency or undocumented endpoints
([dataset license](https://benchlm.ai/data),
[terms](https://benchlm.ai/terms)). Underlying benchmark data remains subject
to its original publisher's license.

## Concrete adapter contract

`BenchLmCatalogSource` should ingest only:

- model/provider/family and release/supersession metadata;
- current pricing and runtime hints;
- benchmark definitions and owner links;
- coverage, freshness, `Supported`/`Estimated`, and confidence metadata;
- the update feed as an invalidation and discovery trigger.

It should emit `candidate-discovered`, `source-changed`, `pricing-changed`, and
`evidence-gap` events. It must not emit an authoritative
`RouteObservation(model, effort, harness)` unless an owner adapter has verified
the complete row.

Every refresh must:

1. validate the export schema and cross-file referential integrity;
2. reject duplicate benchmark identities and implausible source changes;
3. retain the last-known-good snapshot on failure;
4. classify aggregate scores as `corroborating`, never `decisive`;
5. resolve relevant rows through the original source adapter;
6. show a human-readable diff before a personal policy changes.

## Setup and kit-update implication

BenchLM improves discovery, but it does not change ownership: setup asks which
**surfaces/providers the user can and wants to use**, not which model currently
tops a leaderboard. Availability, policy, and benchmark ability are separate.

For a first setup or an existing installation without a routing profile:

1. Detect installed/supported surfaces where possible and ask the user to
   confirm the common choices (for example Claude Code, Codex, and explicitly
   offered additional providers such as Google or Moonshot/Kimi).
2. Record availability and dispatch capability separately: subscription/API,
   allowed cross-provider execution, per-spawn model control, and per-spawn
   effort control.
3. Ask for the optimization preference and local overrides, or allow the safe
   `inherit` mode.
4. Use BenchLM to discover current candidate families, then owner sources to
   construct the proposed model-plus-effort policy.
5. Preview the policy and require approval before activation.

The list of “common AIs” must be data-driven and versioned, not hard-coded in a
skill prompt. BenchLM can nominate newly common candidates, while surface
capability checks determine whether they are actually selectable.

`kit-update` should install updated schemas, adapters, and provider-catalog
logic. It should run a short routing preflight when the profile is absent,
invalid, stale, references a removed model, or when a newly detected surface
changes available choices. It should otherwise report `still valid` without
re-running the whole interview. An update may refresh and cache evidence, but
must never rewrite the user's provider choices, model routes, effort routes, or
global configuration without a separately approved reconcile transaction.

## Final classification

| Use | Classification |
|---|---|
| Discover new models, providers, benchmarks, and releases | Recommended |
| Detect evidence/pricing/freshness changes | Recommended with validation |
| Corroborate owner-source observations | Useful |
| Select a candidate shortlist | Advisory only |
| Select model plus effort for dispatch | Rejected |
| Treat BenchAlign overall/category score as capability truth | Rejected |

BenchLM therefore adds real value to the planned routing wave, but as the
system's **radar**, not its **autopilot**.
