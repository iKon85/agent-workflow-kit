# Path B — Native subagent dispatch

Load this recipe only when the capability selector returns Path B. That result
requires proven native spawn, wait, and aggregate primitives plus effective
concurrency and thread capacity ≥2. Route from proven capabilities only, never
from a surface name, and do not emulate a missing primitive.

This recipe is **dormant on the current Codex host.** A verify spike against
codex-cli 0.144.6 (2026-07-21) proved native start plus bounded wait, and an
effective concurrency of 4, but the host exposes tool entries carrying only a
name and a description: no tool schema, no callable or permitted flags, no
thread capacity. The adapter therefore emits `unknown` for those fields and the
selector fails closed to Path C. Only a future host that supplies the complete
normalized inventory selects this path.

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

For the current reconciled batch, spawn **one builder per slice**, again as one
concurrent batch joined by an explicit wait. Give each builder the verbatim
builder contract, its reconciled allowlist, and its required commands. The host
exposes no per-agent role, model, or reasoning selector, so routing falls back
to the parent session configuration — record the tier you intended in the
prompt itself rather than assuming the host honoured it.

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
