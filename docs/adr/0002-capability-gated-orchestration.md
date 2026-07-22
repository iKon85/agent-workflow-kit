# Capability-gated orchestration: scripted-workflow / native-subagents / direct, fail-closed, no emulation

Status: accepted (2026-07-22, issue #167)

`orchestrate-wave` fans out recon and building across agents. The mechanic that
performs that fan-out is not the same on every host: one host exposes a scripted
workflow runtime, another exposes native subagent spawn/wait primitives, a third
exposes neither. The skill ships from one body for both surfaces, so the mechanic
cannot be baked into the prose — and a wrong guess is expensive, because a wave
that half-dispatches leaves worktrees and branches behind.

We decided to select the mechanic from **proven, host-supplied capability
evidence**, never from a surface name and never from the model's own belief
about what it can call.

1. **A capability matrix over normalized tool entries.** The host supplies an
   inventory; `capabilityAdapter.claude` / `.codex` only normalize what was
   handed to them and perform no ambient discovery. Each entry carries
   `callable`, `permitted`, a schema, and `capabilities: string[] | "unknown"`.
   `classifyCapabilities` returns exactly one of three paths, and
   `selectOrchestrationReference` returns one discriminated target: a reference
   path for A and B, the inline marker for C.
2. **Fail closed, A → B → C.** Missing or `unknown` evidence never proves a
   capability. Path A additionally requires the *literal* tool name plus every
   named primitive individually proven; Path B requires proven spawn, wait, and
   aggregate plus effective concurrency and thread capacity ≥2. Anything short
   of that degrades to Path C — direct, serial, in the main thread — which is
   always available.
3. **Never emulate a missing primitive.** A host without a scripted workflow
   runtime does not get a hand-rolled imitation of one. The degraded path is a
   different, simpler recipe, not the same recipe with the primitive faked.
4. **The report contract is path-independent.** Every path produces the same
   schema-valid recon and builder reports (`src/lib/reportValidator.mjs`, mirrored
   in `references/report-contracts.md`), and every path crosses the same
   main-thread boundary: schema validation, then `reconcileReconReports`, then
   `semanticVerify` on builder reports. A subagent's own PASS is a hypothesis.
5. **Progressive disclosure.** `SKILL.md` carries only the selector, the
   invariants, Path C, and pointers; each path's recipe lives in `references/`
   and is loaded only when selected.

## Considered options

- **Route by surface name** (Claude → workflow, Codex → subagents): rejected —
  it is a claim, not evidence. A verify spike against codex-cli 0.144.6 found
  native spawn and wait callable and concurrency ≥2, yet the host exposed tool
  entries with only a name and a description: no schema, no callable/permitted
  flags, no thread capacity. Name-based routing would have selected Path B on a
  host that cannot prove it.
- **Emulate the missing primitive** (hand-rolled fan-out where no workflow
  runtime exists): rejected — it reproduces the failure modes the runtime exists
  to prevent (run identity, resume-exactly-once, runtime output validation)
  without any of its guarantees, and it fails at the worst moment, mid-wave.
- **Fail open on unknown evidence** (assume a capability when the host is
  silent): rejected — the cost asymmetry is severe. A false Path C is slower; a
  false Path A or B strands a partially dispatched wave.
- **One monolithic SKILL.md carrying all three recipes**: rejected — every
  session would pay for two recipes it will never run.

## Consequences

- The current Codex host selects Path C. `references/dispatch-subagents.md` is
  written and tested but **dormant** until a host supplies the complete
  normalized inventory; that dormancy is pinned from both sides by tests.
- Adding a path means adding evidence requirements and a reference, not
  branching the skill body.
- Hosts that improve their inventory reporting gain a faster path with no skill
  change — the selector picks it up as soon as the evidence arrives.
- The B1 fan-out shape (`spawn_agents_on_csv` plus a host-enforced per-agent
  `output_schema`) stays out of scope until its own version-pinned verify spike
  returns a positive verdict.
