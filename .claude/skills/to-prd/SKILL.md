---
name: to-prd
disable-model-invocation: true
description: "Turn a locked plan (PLAN.md in the worktree, conversation context, or an externally-authored spec) into a Draft-PRD issue on the project board, then run spec-self-critique. Use after a grill (grill-me / grill-with-docs / their -codex variants) when you want to publish the PRD. Three modes — create fresh, reuse an existing cluster/Wave-less issue, or auto-detect a Program-PRD from a plan's Wellenplan chapter. Does NOT decompose into slices (that is to-issues) and does NOT set type:cluster / Wave (that is to-issues promotion)."
---

# to-prd — Draft PRD to the Board

> **Skill identity (don't get confused):** the folder `to-prd` + invocation `/to-prd` map to Matt Pocock's upstream skill **`to-spec`**. Upstream renamed `to-prd` → `to-spec` (v1.1.0); we deliberately keep the folder name `to-prd` (invocation stability, and PRD is this workflow's vocabulary). Content remains our fork, compared against upstream `to-spec` @ `d574778`. Provenance/rename ledger: `docs/agents/provenance.md` (§Re-Sync-Log), at the project root.

Takes an **already-locked plan** and publishes it as a **Draft-PRD issue**. **Never invents requirements** — only synthesizes what's already decided. Pipeline: `board-to-waves → grill(-with-docs) → to-prd → to-issues`. The **grill sits upstream**; to-prd writes the PRD after the grill. **Slicing + promotion to an anchor (cluster/Wave, child link) = `to-issues`** (future), not here.

<!-- readiness:required-preflight:start -->
## 0. Required readiness preflight

This is the first executable workflow step. From the project root, before any remote write or other `gh`/`board-sync.py` command, run this read-only check:

```bash
node scripts/readiness.mjs check --skill to-prd --json
```

- `verdict=ready`: continue with the existing workflow without announcing the check. **Ready is silent.**
- `verdict=blocked`: `STOP` before any mutation. Report every required capability as `<capability>=<state>` so `missing`, `pending`, and `invalid` remain distinct, then give exactly one recovery path: **Run `/setup-workflow`, then rerun `/to-prd`.** Do not fall back to bare tracker or board commands.
- `managedBoard=not-applicable`: `STOP` and report that `/to-prd` is **inapplicable** for a project that deliberately has no managed board. This is a terminal project decision, not invalid evidence and not a partially active mode.
<!-- readiness:required-preflight:end -->

Board constants (project node, field/status IDs) + helpers live **consumer-side**: read `docs/agents/board-sync.md` from the project root + use the helper `scripts/board-sync.py` (missing → `/setup-workflow` scaffolds the project layer). Issue body **always** via `--body-file` (inline `--body` with backticks/parens crashes bash).

## 1. Input — source-agnostic

to-prd reads the locked plan regardless of source:
<!-- mirror-xform:start codex-escalation -->
- **Default: `PLAN.md` in the current worktree** — what the `-codex` grills (`grill-me-codex` / `grill-with-docs-codex`) always write (the Codex review act needs the file); `grill-me` / `grill-with-docs` only write `PLAN.md` conditionally (on a worktree/session cut).
<!-- mirror-xform:end -->
- **Fallback: conversation context** (same-session, no PLAN.md).
- **Externally supplied:** a spec authored elsewhere (e.g. Claude Web/Codex), handed into context.

If a `PLAN.md` exists in the worktree, it's the source; otherwise conversation/external.

**Cold start = extract-or-synthesize, not assume-or-fail (anchor).** `to-prd` is the **universal normalizer** for loose artifacts (plan/doc/external PRD without a board issue): the PRD template sections are **extracted from what exists**, instead of assuming a prior grill. `to-prd` **mandates no** grill and **no** Codex — depth is the entry person's choice.
- **A non-derivable required section ≠ a silent "complete" placeholder (anchor):** if a required section (e.g. "Testing Decisions") can't be derived from the input, the open content moves into a **`## Open Questions (not derivable from input)`** section — the PRD is then honestly *open* instead of falsely *complete*. `spec-self-critique` (step 5) remains mandatory.
- **Downstream contract:** a non-empty `## Open Questions` forces `to-issues` to publish the affected slices as **HITL** (`headings.vorBau` heading, board profile `docs/agents/board-sync.md`; <project> currently `## Vor Bau zu klären`) or ask first — open questions never disappear silently (see `to-issues` §3b). Each open question is classified by **gate type** (🧭 design grill / 🔬 verify-spike / 📐 trade-off research / 📝 review note) so `to-issues` sequences it as a gate slice **before** the dependent build slice (gate-before-build) — a 📝 review note is **not** cut into a slice (see template section "Review Notes" + `to-issues` §3b). (Retro anchor)

## 2. Detect mode — new vs existing issue

No user flag — auto:
- **Mode A (fresh):** no target issue → to-prd creates a new Draft-PRD.
- **Mode B (reuse):** a **cluster/Wave-less** issue already exists (an earlier Draft-PRD on re-run, or a de-cored `board-to-waves` candidate stub) → to-prd writes the PRD **into that issue** (no duplicate).
- **Mode program (auto-detected, no flag, same as A/B):** the plan/source carries a `## Wellenplan` chapter (the machine-parsable table `.claude/skills/to-prd/PROGRAM-PRD-FORMAT.md` defines) → to-prd writes a **Program-PRD** per that format instead of the regular `<prd-template>` below (§4b), stamps `<!-- prd: program -->` instead of `<!-- prd: awaiting-decomposition -->` (§4), and the §8 audit line names the mode loudly (`mode=program`). Detection is purely content-based — a program-mode write can still be a fresh create (Mode A) or a reuse (Mode B); the Wellenplan chapter flips the format/marker/label, not the target-selection logic.

**Cluster/Wave discriminator (identical wording — `to-prd` §2 / `to-issues` §5):** `type:cluster` (label) always stops. A Wave number also stops, **unless** the target carries the `wave-stub` label — a Wave-stamped `wave-stub` issue is a **Stufe-1p Program-stub** (`to-waves`-published, native parent = a Program-PRD) and remains a **valid target**. A Wave-stamped issue **without** `wave-stub` (an already-assigned leaf, or a drifted item) is still a hard stop.

**Hard stop before any write:** per the discriminator above → **abort** and report: "cluster/Wave anchor is not a to-prd target — belongs on the Wave-model/`to-issues` path". to-prd **never sets** cluster/Wave and **never strips** them — it only ever operates on cluster/Wave-less issues, or on a `wave-stub`-labeled Stufe-1p stub (the exception above — this is how `to-waves`'s per-wave-start content pass writes into a wave stub, `to-waves` SKILL.md §7). Wave lives in the Projects-v2 **field**, not as a label → read the board item + its labels before writing:
```bash
gh project item-list 1 --owner <owner> --limit 500 --format json   # check target's Wave/cluster/wave-stub membership
```

**Programm-Verdacht net (a plan without a Wellenplan chapter, but oversized).** When the source carries **no** `## Wellenplan` chapter but its scope trips the `scale-check` altitude criteria (owned at `.claude/skills/scale-check/SKILL.md` § "Altitude criteria (the single source of truth)" — referenced here, **never** re-forked) — e.g. **staged delivery across >~7 slices** or **several subsystems that each stand on their own** — to-prd does **not** silently write a plain Feature-PRD. It surfaces a loud hint first: "Programm-Verdacht — scale-check-Kriterien prüfen", catching a mis-entry below the program altitude before the Feature-PRD write proceeds. Only after that hint is seen (confirmed as a Feature by the doubt-default, or re-routed through `scale-check`/a program grill) does the write continue.

## 3. Target identity — identity ≠ content

- **Mode B:** target issue number **explicit** (passed in/from context). Branch derivation `feat/<#>-…` **only** when the operation explicitly says "update this issue" — the slice branch is **not** automatically the PRD.
- **Mode A — idempotency via two separate markers in the body:**
  - **Stable source identity** `<!-- prd-source-id: <id> -->` — **never** changes across plan content edits (otherwise search-before-create misses the changed re-run → duplicate). **Default rule** for `<id>` (identity ≠ content; set on the **first** to-prd run, **never** changed after — the slug then lives in the issue body and is discoverable via search-before-create): kebab-case slug of the plan topic. Priority: **(1)** explicitly passed ID / durable issue number → **(2)** existing slug from a prior run (found via search-before-create) → **(3)** new kebab-case slug from the plan/title topic. The `PLAN.md` path is only a **secondary hint** (not stable across worktrees; external specs have none), **never** the identity itself.
  - **Separate content fingerprint** `<!-- prd-content-fp: <hash> -->` — only for diff/audit/bump decisions, **not** for identity.
- **search-before-create:** use the shared all-state exact-marker lookup (it uses
  `gh api --paginate`, discards REST pull-request items, and never relies on
  GitHub Search or a capped issue list):
  ```bash
  python3 scripts/find-by-marker.py --kind prd-source-id --slug "<id>"
  ```
  Branch on its JSON contract (`count`, `issues[].number`, `issues[].state`,
  `verdict`): `0` / `create` → create; exactly one `open` / `update` → update
  that issue; exactly one `closed` / `user-decision` → ask the user whether to
  reopen, use a new identity, or stop; `>1` / `STOP` → stop and report every
  number/state. Never auto-delete or silently replace a closed/duplicate identity.
  Immediately after a Mode-A create, run the same lookup with
  `--created <new-issue-number>`. Continue only when it returns exactly the
  newly-created open issue; duplicate reconciliation is a loud `STOP` that
  reports both/all numbers for user-decided resolution.

## 4. Write the Draft PRD (deliverable)

1. Understand repo/code (if not already), respect the domain glossary + ADRs. Sketch deep modules, align with the user (which get tested).
2. Write the PRD per the template below.
3. **Board sync (mandatory):**
   - **Status `Spec`**, exactly **one** `type:*` (default `type:feature`; pure process/workflow scope → `type:followup`/`type:research` per intent) **plus** one `priority:*` (mandatory vocabulary "type+priority"). **No** `type:cluster`, **no** Wave, **no** `ready-for-agent` — a Draft PRD isn't buildable yet, it's waiting on `to-issues` decomposition.
   - Board sync via helper:
     ```bash
     python3 scripts/board-sync.py create --title "<PRD title>" --body-file <prd.md> \
       --label type:feature --label priority:medium --status-role spec   # Mode A
     # Mode B: gh issue edit <target> --body-file <prd.md>  +  board-sync.py add --issue <target> --status-role spec
     ```
   - **Mode B — explicit status flip:** writing the PRD into a `board-to-waves` stub, `board-sync.py add --issue <target> --status-role spec` flips the board status **triaged → spec** (role names; the stub sat at the triaged-role status, a Draft PRD sits at the spec-role status).
   - **mode=program's `type:*`:** the Program-PRD's one `type:*` label is the profile's `labels.programType` value (`board_config.program_type_label()`, literal default `type:program` when unset) — never `type:feature` **and** `type:program` together (the "exactly one `type:*`" invariant is unchanged, program mode just uses a different vocabulary member). `type_labels_to_strip` protects this label from ever being stripped at promote (a Program-PRD is never itself a promote target).
4. **Body markers (top of the PRD body):**
   - `**plan_revision:** r1`
   - `<!-- prd: awaiting-decomposition -->` — durable distinguishability marker: makes "PRD awaiting `to-issues`" board-discoverable **without** a new label (status `Spec` alone also covers planned anchors/other specs).
   - **mode=program:** `<!-- prd: program -->` **instead of** `awaiting-decomposition` — the program-altitude counterpart marker (never both on the same issue).
   - `<!-- prd-source-id: <id> -->` + `<!-- prd-content-fp: <hash> -->` (see step 3).
5. **Mode B label normalization:** if the reused issue carries wrong/multiple `type:*`, missing `priority:*`, `ready-for-agent`, or `needs-info` → **normalize onto the PRD contract** (exactly one `type:*`, one `priority:*`, no `ready-for-agent`/`needs-info`). Exception per the discriminator (§2): `type:cluster` always, or Wave **without** `wave-stub` → **no** normalization, **hard stop** (step 2); a `wave-stub`-labeled Stufe-1p target normalizes normally — it is a valid Mode B target.

### Census freshness before a cross-cutting lock

When the PRD claims completeness across several product surfaces, run
`python3 .claude/hooks/drift-guard.py --census-status` before the board write.
An activated census reporting `refresh_required` means the cross-cutting PRD
must not be locked: run `$census-update`, resolve every open surface, and retry.
`disabled`, `no_census`, `bootstrap`, or `offline` stays visible and fail-open;
perform and report the existing manual walk instead. This gate does not apply
to an orthogonal, surface-local PRD.

A justified change-local override may acknowledge only a proven mechanical
false positive. It must carry `scope: "this change"`, a non-empty `reason`, and
the exact `topologyFingerprint` reported as `change_binding` by the current
status check. That binding is valid only for those freshly scanned topology
facts; a later topology change makes the persisted override stale. The
override never changes scanner facts, builder/topology fingerprints, open
verdicts, or state resolution, and therefore cannot green real drift.

## 4b. Program-PRD body (mode=program)

mode=program writes the Program-PRD per `.claude/skills/to-prd/PROGRAM-PRD-FORMAT.md` instead of the `<prd-template>` below — a **parallel** grammar for the program altitude, not a replacement (a Feature-PRD keeps using `<prd-template>` unchanged). It carries: the `## Scope` chapter with stable Scope-Item IDs (`S1`, `S2`, …), the machine-parsable `## Wellenplan` table (`Welle | Status | Name | Phase | Slices | Gate | covers`), the `## Phasen-Gates` checklist (only when the program uses phases), the `## Slices` per-slice detail chapter (one `####` section per planned slice, per `SLICE-METADATA-FORMAT.md`'s grammar), and the Abbruch-Konvention. `scripts/program_graph.py` (`board-sync.py validate-graph`) is the parser — to-prd writes the shape, it does not itself validate the graph (that is `to-waves`'s job, run once the Program-PRD exists).

## 5. `spec-self-critique` — mandatory next step

to-prd has `disable-model-invocation: true` and can't literally invoke a skill. **After** the PRD write, the agent **must** run `spec-self-critique` on the Draft PRD; its visible two-liner (`Self-critique complete — N corrections: …` or `…no corrections needed`) is required output **before** the user review question.

## 6. Idempotent reconcile (re-run)

- **`plan_revision` parse:** counter `r<N>`; missing/malformed → treat as `r1` + warn. **Body-changing** = a non-empty diff over the **canonical PRD sections** (Problem/Solution/User-Stories/Implementation-Decisions/Testing), **excluding** metadata markers, the child-drift section, and critique output. An identical plan re-run does **not** bump.
- **R1 — no children:** update body instead of duplicating; bump `plan_revision` only on a body-changing run; critique re-runs.
- **R2 — children/cluster exist:** update body + bump + **flag durably** — a **`## Child Drift (as of r<N>)`** section in the body (not ephemeral chat output) lists children + their revision. **No** child mutation (= `to-issues`/1d), **no** blocking guard (= 1g).
- **Program-stub exception to R2 (Stufe-1p pre-created skeleton):** if the Mode B target is a `wave-stub`-labeled Stufe-1p Program-stub (native parent = a Program-PRD), its existing native children are the **slice leaves `to-waves` pre-created** for this wave — that is the program's **expected skeleton**, not R2's `## Child Drift` finding, as long as they match the Program-Graph's `Wellenplan` row for this wave. A mismatch (a missing or a foreign child) is `validate-graph`'s finding to raise, not this reconcile heuristic's — to-prd Mode B does not re-derive graph conformance itself. An ordinary Mode B target (a plain cluster/Wave-less reuse, or a `board-to-waves` candidate stub) keeps the unmodified R2 behavior.
- **Child discovery:** native sub-issues (via `python3 scripts/board-sync.py parent-of <#>` / rollup) are the authoritative set; report native-vs-body-listed mismatches in the drift section.

## 7. Execute-ready assertion (exit)

- **Before the write (gate):** target carries cluster/Wave → **fail before write** (hard stop, step 2) — never "reconcile after the write".
- **After the write:** assert that the Draft PRD **exists as a board item** (status write = `Spec`), exactly **one** `type:*` + **one** `priority:*`, **no** `ready-for-agent`, **no** `type:cluster` + **no** Wave (defensive against accidental mutation), carries `plan_revision` + `awaiting-decomposition` + `prd-source-id`, body complete (critique ran). = an unambiguous "PRD-awaiting-decomposition" state (neither AFK leaf nor HITL child — that's `to-issues`'s call). mode=program asserts the same shape with its own markers: `plan_revision` + `<!-- prd: program -->` + `prd-source-id`, the profile's `programType` label (default `type:program`) as the one `type:*`, still no `ready-for-agent`, still no `type:cluster`/Wave — a Program-PRD is exactly as "awaiting further work" as a Feature-PRD, just at a higher altitude (its own lifecycle, §9).

## 8. Audit block (visible output)

```
to-prd: mode=<A|B|program> target=#<n> <created|updated> rev <old>→<new>
  status=Spec  labels=<type:*, priority:*>  cluster/Wave=none
  source=<plan|conversation|external>  synthesized=<marker-list | none>  readiness=<ok | open-questions>
  child-drift=<none | #a(r1) #b(r1) …>
```
`source` = where the input came from (make cold start visible anchor). `synthesized` = which markers `to-prd` freshly set (e.g. `prd-source-id`). `readiness=open-questions` ⇔ the PRD carries a non-empty `## Open Questions` section. For `mode=program`, `labels` shows the profile's `programType` value (default `type:program`) as the one `type:*`, and `cluster/Wave=none` still holds for the Program-PRD itself.

## 9. Program-PRD lifecycle (mode=program only)

A Program-PRD's board Status travels a longer arc than a Feature-PRD's:

- **spec role** — set here, at the mode=program write (§4's board sync, same as any Draft-PRD).
- **in-progress role** — flipped by `to-issues`, at the **first** wave-stub promotion under this PRD (not by to-prd itself; a re-run of to-prd on an already-in-progress Program-PRD leaves the status untouched).
- **done role** — set **manually**, by the maintainer, at the program's last Phasen-Gate. `closes` **never** targets a Program-PRD (same close-protection contract as any Welle-Anchor, `to-waves` §8) — it is closed last, by hand, once every wave/stub/leaf under it is done (or, on an abort, closed per the Abbruch-Konvention in `PROGRAM-PRD-FORMAT.md`).

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. **Write each story in the same language as the rest of the PRD** (this project is German-first → German stories; never mix an English scaffold onto German content). Each user story follows the actor/feature/benefit shape:

- Deutsch: `Als <Akteur> möchte ich <Funktion>, damit <Nutzen>.`
- English: `As a(n) <actor>, I want <feature>, so that <benefit>.`

<user-story-example lang="de">
1. Als QA-Lead möchte ich den Testfortschritt je Phase auf einen Blick sehen, damit ich Engpässe früh erkenne.
</user-story-example>
<user-story-example lang="en">
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending.
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Review Notes (findings that do NOT become slices)

Findings that are real but **not a buildable item** — e.g. a review-only smell no linter/gate catches (SoC drift in a handler, a style question). Per entry: what + why it's not a slice. These carry the gate tag 📝; `to-issues` does **not** cut them into a slice. Fixed opportunistically at the next touch, not tracked. (Boundary: a buildable finding belongs in Implementation Decisions; an open decision/research question belongs in `## Open Questions`.)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>
