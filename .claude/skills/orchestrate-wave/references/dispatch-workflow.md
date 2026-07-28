# Path A — Scripted Workflow dispatch

Load this recipe only when the capability selector returns Path A. That result
requires the literal `Workflow` tool and every required primitive. Route from
proven capabilities only, never from a surface name, and do not emulate
Workflow. The current Codex host lacks complete capability evidence and selects
Path C; a future host selects whichever path its evidence proves.

## Main-thread preparation

1. Read the canonical `RECON_REPORT_SCHEMA` and `BUILDER_REPORT_SCHEMA` values
   from `src/lib/reportValidator.mjs`.
2. Serialize each value as an inline schema literal in its generated Workflow
   script. Workflow scripts cannot import modules, so never put an `import()`,
   `require`, `process`, or `fetch` workaround in them.
3. Build deterministic run arguments. Pass run identity, slice IDs, prompts,
   models, effort levels, and timestamps through `args`; never call
   `Date.now()` or `Math.random()` in a script.

## Run 1 — Recon

Declare the named recon phase in `meta.phases`. Within it, make one `agent()`
call per slice, with explicit `model`, `effort`, and `phase` options. Give every
call the inline recon schema so the Workflow runtime rejects prose or malformed
output before aggregation.

Use the run identity supplied in `args` and retain the Workflow-managed
`journal.jsonl`. The main thread waits for the Recon run to finish and collects
its schema-valid reports. It must not dispatch a builder yet.

## Main-thread reconcile boundary

Pass the complete Recon-run result to `reconcileReconReports`. A reconciliation
failure stops the wave. A successful result is the only boundary that permits
the Build run to start; use its overlap graph and dependency edges to cut safe
dispatch batches. Multiple editors are safe only when dependency reachability
totally orders them; shared-mutable files still require exactly one edit owner.

Every orchestration path, including Paths B and C, must cross this same
main-thread reconciliation boundary. Reconciliation is not Workflow-script
logic.

## Run 2 — Build

Generate a separate Build run with its own named entry in `meta.phases`. For the
current reconciled batch, make one `agent()` call per slice with explicit
`model`, `effort`, and `phase` options and the inline builder schema. Preserve
the reconciled allowlist and required commands in each verbatim builder prompt;
the main thread still performs `semanticVerify` on every returned report.

Before dispatch, resolve a provider-neutral Routing intent — an explicit intent
block first, otherwise the workflow classifier — and authorize the whole run
once through a Dispatch plan whose hash binds every unit, intent, route and
reason. Dispatch only through `src/lib/routeDispatcher.mjs`, and require a
Dispatch receipt from the shared spawn guard that carries the authorization id
the plan recorded. A detected transport is not authorization; AFK dispatch
stops unless requested/applied route, model/effort enforcement, environment
precedence, and catalog/access/policy revisions are proved.

Before each `agent()` call, resolve its provider-neutral Routing intent and pass
the decision through the shared spawn guard and active surface adapter. The
Claude adapter must attest Workflow model/effort precedence in the current
environment; a future Codex host may use this path only when its dated
`routingAdapters/codex.mjs` attestation proves the same controls. Create the
Dispatch receipt before invocation; any requested/applied mismatch, unverified
control, or unauthorized transport blocks AFK rather than silently degrading.

## Resume exactly once

Resume an interrupted Recon or Build run with its recorded `resumeFromRunId`
and the same deterministic `args`. Workflow returns cached results for completed
agents: accept those results and dispatch only unfinished calls. Never create a
replacement run for completed work, and never replay a completed builder. This
makes each builder phase execute exactly once while the retained
`journal.jsonl` remains the recovery and progress record.
