# Path B — Native subagent dispatch

Load this recipe only when the capability selector returns Path B. That result
requires proven native spawn, wait, and aggregate primitives plus effective
concurrency and thread capacity ≥2. Route from proven capabilities only, never
from a surface name, and do not emulate a missing primitive.

This recipe is **dormant unless the current host's complete orchestration
inventory proves Path B.** The dated Codex routing attestation is a separate
gate: the observed explicit-spawn schema exposes only `task_name`, `message`,
and `fork_turns`, with no model or effort selector. Therefore
`routingAdapters/codex.mjs` blocks differentiated AFK before spawn even when
native start/wait/aggregate evidence is otherwise sufficient for Path B. A
future host may enable the route only by attesting both orchestration primitives
and applied model/effort controls; neither is inferred from the surface name.

## Main-thread preparation

1. Read the canonical `RECON_REPORT_SCHEMA` and `BUILDER_REPORT_SCHEMA` values
   from `src/lib/reportValidator.mjs`. They are the same contract every
   orchestration path reports against.
2. Embed the relevant schema verbatim in each subagent prompt, together with the
   instruction to return **exactly ONE JSON object** and nothing else — no
   prose, no fences, no second object. The host does not enforce output shape,
   so the contract lives in the prompt and the check lives in the main thread.
3. Acquire the wave claim and create every worktree from the integrated base
   through `claimWave` in `src/lib/waveClaim.mjs` before any spawn. Claim and
   worktree creation stay serial in the main thread; only the agents fan out.

## Round 1 — Recon

Spawn **one read-only explorer per slice**, all in one batch so they run
concurrently, then join them with an **explicit wait** on the spawned set —
never a sleep, a poll loop, or an implicit continue. Aggregate only after the
wait returns.

Each explorer returns one recon report. Validate every returned payload against
the recon schema in the main thread: a payload that does not parse, carries
extra top-level keys, or fails the schema **is not a PASS** — it is a missing
report. Re-spawn that single explorer with the failure quoted back to it; never
accept a prose summary in place of the object.

## Main-thread reconcile boundary

Pass the complete, validated recon set to `reconcileReconReports`. A
reconciliation failure stops the wave. A successful result is the only boundary
that permits builders to start; use its overlap graph and dependency edges to
cut safe dispatch batches. Multiple editors are safe only when dependency
reachability totally orders them; shared-mutable files still require exactly one
edit owner.

Every orchestration path crosses this same main-thread reconciliation boundary.
Reconciliation is never delegated to a subagent.

## Round 2 — Build

Before dispatch, resolve a provider-neutral Routing intent — an explicit intent
block first, otherwise the workflow classifier — and authorize the whole run
once through a Dispatch plan whose hash binds every unit, intent, route and
reason. Dispatch only through `src/lib/routeDispatcher.mjs`, and require a
Dispatch receipt from the shared spawn guard that carries the authorization id
the plan recorded. A detected transport is not authorization; AFK dispatch
stops unless requested/applied route, model/effort enforcement, environment
precedence, and catalog/access/policy revisions are proved.

For the current reconciled batch, spawn **one builder per slice**, again as one
concurrent batch joined by an explicit wait. Give each builder the verbatim
builder contract, its reconciled allowlist, and its required commands. Resolve
the provider-neutral Routing intent immediately before each spawn. Pass the
decision through `routeDispatcher.mjs` and the active surface adapter. Claude
uses its native or explicitly policy-approved transport attestation; Codex uses
only its dated `routingAdapters/codex.mjs` host attestation. Both must prove
their requested and applied model and effort controls before invocation.
Detection alone never authorizes a transport.

The spawn guard compares the requested route with the adapter's applied route
and environment precedence. It emits the shared Dispatch receipt with
catalog/access/policy revisions. An unverified control, unauthorized transport,
override mismatch, or unenforced effort blocks AFK before spawn. A genuinely
unreachable route follows the policy's handoff, inherit, or block result; never
silently inherit. A host without a proved per-agent selector remains on its
existing parent-session fallback only when explicit non-AFK policy permits it.

Each builder returns exactly one builder report. Validate it against the builder
schema and then run `semanticVerify` on it in the main thread. A subagent's own
claim of success is a hypothesis, never the gate.

## B1 fan-out is out of scope

The **B1** shape — a single fan-out over a work list (`spawn_agents_on_csv`)
plus a host-enforced per-agent `output_schema` — is explicitly excluded. The
same spike found the callable spawn schema exposes only `task_name`, `message`,
and `fork_turns`: no work-list fan-out and no output-schema parameter. This
recipe therefore documents the **B2** shape only: explicit per-slice spawns
joined by an explicit wait, with validation owned by the main thread.

Re-opening B1 requires its own version-pinned verify spike — tracked as an open
spike issue on the kit's own tracker — before any recipe or adapter change.
Never infer the capability from a release note; prove it against the pinned
runtime first.
