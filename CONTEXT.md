# Domain language

## Upstream route

The defined path by which a generic improvement discovered in a consumer
reaches the kit: the consumer raises it as a kit issue, the kit builds and
releases it, and the improvement returns to every consumer through a kit
update. Raising the issue is always a question put to the user, never an
automatic action.

## Consumer-owned path

An installed file a consumer has deliberately claimed as its own. The kit's
update process leaves it untouched in every direction: no overwrite, no
conflict report, no deletion prompt. Owning a path means forgoing all future
kit improvements to it.

## Clean shipped file

A kit-shipped file in a consumer that carries no project-specific content —
including no project issue references. Project-specific needs live in
consumer-owned paths or consumer-native files, never as edits to a clean
shipped file.

## Consumer-native behavior

A workflow capability that a consumer project established locally before the
kit offered an equivalent capability.

## Generalized kit behavior

A consumer-neutral form of a proven consumer-native behavior. It preserves the
outcome while leaving project-specific activation and policy choices with the
consumer.

## Update verification profile

The consumer-selected preparation and check that decide whether a staged Kit
update is safe to activate. Until the consumer selects a profile, verification
uses the legacy `npm test` fallback.
_Avoid_: Smoke test, pre-check, update verification command

## Behavioral parity

Evidence that a generalized kit behavior produces the same observable workflow
outcome as the consumer-native behavior it will replace. The consumer-native
behavior remains authoritative until parity is proven.

## Planning facade

The single user-facing transition from an approved PRD to executable issues.
It selects Feature or Program mechanics from the PRD's explicit identity while
keeping that internal routing out of the user's workflow.
_Avoid_: Skill chooser, Altitude command

## Routing intent

A provider-neutral description of the work a delegated agent must perform: its
workload, task shape, risk, autonomy requirement, context need, and optimization
goal. It is durable planning data and remains valid when providers or model
names change.
_Avoid_: Recommended model, Provider hint

## Evidence catalog

The complete, versioned, provider-independent body of observations used to
compare candidate routes. An observation retains model, effort, harness,
workload, source, benchmark version, uncertainty, freshness, and cost. The
catalog is not filtered to models reachable from the active agent surface.
_Avoid_: Leaderboard, Model allowlist

## Access graph

The user-local map of native and cross-provider paths by which an agent surface
can reach a model runtime, together with dated capability attestations for
model selection, effort control, and dispatch. Detection does not imply user
authorization.
_Avoid_: Installed-model list, Provider preference

## Routing policy

The user-owned rules that constrain dispatch across the Access graph, including
allowed surfaces and transports, switching autonomy, optimization goals, and
optional advanced overrides. It never changes Evidence catalog facts.
_Avoid_: Model table, Benchmark score

## Route decision

The dispatch-time resolution of a Routing intent against the current Evidence
catalog, Access graph, and Routing policy. It names a model, effort, surface,
transport, and enforcement method for one execution only.
_Avoid_: Planning metadata, Permanent recommendation

## Dispatch receipt

The runtime record proving which requested Route decision was actually applied,
by which enforcement mechanism, under which policy and evidence revisions. An
AFK dispatch without proof of model and effort does not have a valid receipt.
_Avoid_: Recommendation, Agent log

## Worktree lifecycle

The complete workflow for creating, identifying, enforcing, and cleaning up an
isolated worktree. Setup and enforcement are one capability even when different
agent hooks expose parts of it.

## Safety guardrail

An independently activatable rule that prevents or detects an unsafe agent or
repository action. Guardrails may share activation and reporting machinery,
but each retains its own applicability and failure policy.

## Capability readiness

**Capability**:
A project-specific prerequisite that activates a skill or a bounded part of a
skill when its evidence is present and valid.
_Avoid_: Feature flag, setup checkbox

**Capability readiness**:
The live-derived state of a Capability: `ready`, `pending`, `not-applicable`,
`missing`, or `invalid`.
_Avoid_: Setup complete, enabled flag

**Readiness Decision**:
A durable consumer choice of `pending` or `not-applicable`; it is not a cache
of evidence-derived readiness.
_Avoid_: Readiness state, generated default

**Required Capability**:
A Capability whose unavailable state prevents the dependent skill from safely
running at all.
_Avoid_: Global setup gate

**Optional Block**:
A stable, manifest-declared region of a skill that is excluded when its
Capability is unavailable while the rest of the skill remains usable.
_Avoid_: Optional skill, prose fallback
