# Domain language

## Upstream route

The defined path by which a generic improvement discovered in a consumer
reaches the kit, is generalized and released there, and returns to consumers
through a kit update. Crossing from the consumer into the kit always requires
an explicit user decision.

## Project extension

A supported consumer-owned addition of project-specific language, policy, or
capability data that leaves the corresponding Kit Core unchanged.
_Avoid_: Local patch, Consumer fork

## Kit Core

The upstream-owned behavior and protocol authority that evolves as one
coherent Kit release under the Kit's canonical identity.
_Avoid_: Consumer customization, Local copy

## Contribution bridge

A temporary local change to Kit Core that is retained while the change is
evaluated and generalized through the Upstream route. It must eventually be
absorbed by a Kit release, moved to a Project extension, or made an Explicit
fork.
_Avoid_: Consumer-owned path, Permanent override

## Explicit fork

A deliberately separate identity and update line for behavior that is intended
to diverge from Kit Core permanently.
_Avoid_: Project extension, Contribution bridge

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

## Kit-verified end state

The staged update candidate proven activatable by the Kit's own invariants —
manifest completeness, schema and protocol coherence, generated mirror parity,
syntax validity of changed artifacts, and transaction preconditions — checked
without executing any consumer behavior. There is no consumer-selected
verification command and no legacy `npm test` fallback: the Kit answers for the
end state it ships, and the consumer's test suite answers for the consumer's
own code.
_Avoid_: Update verification profile, smoke test, pre-check, update
verification command

## Behavioral parity

Evidence that a generalized kit behavior produces the same observable workflow
outcome as the consumer-native behavior it will replace. The consumer-native
behavior remains authoritative until parity is proven.

## Staged update candidate

An isolated proposed Consumer state that must be successfully materialized,
prepared, and verified before any Kit update is activated.
_Avoid_: Staging copy, verification checkout

## Ownership collision

An installed destination whose existing identity cannot be derived safely from
the Kit ledger. It requires an explicit classification before an update may
change either its bytes or its ownership.
_Avoid_: Default answer, Safe overwrite

## Release intent

An explicit authorization to publish one already-integrated Kit version. It is
separate from accepting the underlying change into the canonical branch.
_Avoid_: Version merge, Successful build

## AFK wave

A pre-authorized unit of delivery that proceeds from implementation through
verification, landing, release, acceptance, and cleanup without ordinary user
intervention. Authorization ends at the wave boundary; starting the next wave
is a separate decision.
_Avoid_: AFK program, Unbounded autonomy

## Planning facade

The single user-facing transition from an approved PRD to executable issues.
It selects Feature or Program mechanics from the PRD's explicit identity while
keeping that internal routing out of the user's workflow.
_Avoid_: Skill chooser, Altitude command

## Routing intent

A provider-neutral description of the work a delegated agent must perform: its
workload, task shape, risk, autonomy requirement, and context need. It is
durable planning data and remains valid when providers or model names change.
It carries no optimization goal — what a user is willing to spend is a Routing
profile choice, not a property of the work.
_Avoid_: Recommended model, Provider hint, Optimization goal

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

## Routing profile

The stored personal choice a user makes once: which agent surfaces they use,
whether the Kit may switch between them, which Model roster they authorize, and
their Standard routes. It is user-local, carries no revision, and is never
inferred from detection, credentials, or instruction files.
_Avoid_: Routing policy, Optimization preference

## Model roster

The set of model-and-effort pairs a user authorizes the Kit to pick from. It is
a positive list: a pair absent from it is never dispatched, whatever the
evidence says. A newly available pair stays outside the roster until the user
admits it.
_Avoid_: Installed-model list, Model allowlist, Benchmark ranking

## Standard route

The model-and-effort pair a user nominates for a broad kind of work, used when
no decisive evidence covers the resolved Routing intent. A Route decision taken
this way names the Standard route as its reason and never presents itself as
evidence-backed.
_Avoid_: Default model, Recommended model

## Routing policy

The constraint object derived from a Routing profile for one dispatch: allowed
surfaces, transports, and roster pairs, plus switching autonomy. It carries a
revision so a Dispatch receipt can prove which constraints applied, and it never
changes Evidence catalog facts.
_Avoid_: Model table, Benchmark score, Personal preference

## Dispatch plan

The resolved table a delegating workflow presents before its first dispatch:
each unit of work with its Routing intent, chosen route, and the reason that
route won. It is authorized once for the whole run, never per dispatch.
_Avoid_: Per-task prompt, Cost estimate

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

## Stateless teardown classification

The rule that teardown authority is derived entirely from the repository's
current state — git's own tracked/untracked/ignored classification over the
standard exclude sources, and the platform PR record — never from persisted
lifecycle evidence. Interrupted work is resumed by re-checking present state, not by
replaying a journal.
_Avoid_: Teardown provenance, Ownership proof, Lifecycle receipt

## Scratch

A file git's standard exclude sources (repository ignore files,
`.git/info/exclude`, the global excludes file) classify as ignored. By the
repository's own declaration it is not work, and it is therefore deletable at
teardown. The single exception class is `.env*`, and it has two arms: a file the
consumer's own seed declaration names is deletable **by that declaration** and
is listed in the teardown report; an undeclared one is compared against the main
checkout before removal and blocks unless it is byte-identical. Declaration and
ignore rule are the same kind of authority — the repository saying what is not
work — never a pattern list the kit interprets.
_Avoid_: Scratch pattern, Cleanup allowlist

## Durable content

Repository content a session produced that must reach `main` through a commit
and the ordinary PR gate — glossary and ADR updates, research documents,
tracked-file edits. Durable content is ordinary work; it has no special
landing mechanics.
_Avoid_: Planning artifact, Session leftover

## Content route

The wrapup path for a session whose output is Durable content without a
feature worktree or slice: infer the situation, claim an explicitly confirmed
file set, cut a branch, commit, and open the ordinary PR — with no teardown
half. It adds a route to wrapup, never a caller.
_Avoid_: Second landing path, Auto-commit

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

## User journey

The path the human takes to an outcome: naming the goal, answering the
decisions that are theirs, and approving. Few touchpoints, each one a decision.
_Avoid_: Human workflow, operator flow

## Agent journey

The path an agent takes through skills, hooks and scripts to deliver that
outcome, including the recovery paths it takes when something stops it. It is a
distinct journey from the User journey, not the same route seen from the other
side.
_Avoid_: Skill chain, pipeline, happy path

## Decision ownership

Which party a decision belongs to, determined by whether it binds the project
beyond the current change. A choice a later refactor can reverse without
external consequence belongs to the agent; a dependency, vendor, interface
contract, operating surface, or visible behavior belongs to the user. Technical
difficulty does not decide it.
_Avoid_: Technical vs. functional, user-facing flag

## Planning claim

A falsifiable statement the planning phase makes about what execution will
find — that a slice carries no unresolved decision, that slices are disjoint,
that a named assumption holds. Execution confirms or refutes it.
_Avoid_: Planning assumption, spec guarantee, precondition

## Analysis substrate

The shared, committed evidence base an analysis wave derives exactly once:
the scripted inventory, the derived journey set with its station tables, and
the evidence exports. Downstream analyses read it and record their own
verdicts against it; none re-derives it, and a defect found in it is fixed in
the substrate, not patched in a consumer.
_Avoid_: Shared phase 0, common groundwork, prep work
