---
name: to-prd
disable-model-invocation: true
description: "Turn a locked plan (PLAN.md in the worktree, conversation context, or an externally-authored spec) into a Draft-PRD issue on the project board, then run spec-self-critique. Use after a grill (grill-me / grill-with-docs / their -codex variants) when you want to publish the PRD. Two modes — create fresh, or reuse an existing cluster/Wave-less issue. Does NOT decompose into slices (that is to-issues) and does NOT set type:cluster / Wave (that is to-issues promotion)."
---

# to-prd — Draft PRD to the Board

Takes an **already-locked plan** and publishes it as a **Draft-PRD issue**. **Never invents requirements** — only synthesizes what's already decided. Pipeline: `board-to-waves → grill(-with-docs) → to-prd → to-issues`. The **grill sits upstream**; to-prd writes the PRD after the grill. **Slicing + promotion to an anchor (cluster/Wave, child link) = `to-issues`** (future), not here.

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

**Hard stop before any write:** the target issue carries `type:cluster` (label) OR a Wave number → **abort** and report: "cluster/Wave anchor is not a to-prd target — belongs on the Wave-model/`to-issues` path". to-prd **never sets** cluster/Wave and **never strips** them — it only ever operates on cluster/Wave-less issues. Wave lives in the Projects-v2 **field**, not as a label → read the board item before writing:
```bash
gh project item-list 1 --owner <owner> --limit 500 --format json   # check target's Wave/cluster membership
```

## 3. Target identity — identity ≠ content

- **Mode B:** target issue number **explicit** (passed in/from context). Branch derivation `feat/<#>-…` **only** when the operation explicitly says "update this issue" — the slice branch is **not** automatically the PRD.
- **Mode A — idempotency via two separate markers in the body:**
  - **Stable source identity** `<!-- prd-source-id: <id> -->` — **never** changes across plan content edits (otherwise search-before-create misses the changed re-run → duplicate). **Default rule** for `<id>` (identity ≠ content; set on the **first** to-prd run, **never** changed after — the slug then lives in the issue body and is discoverable via search-before-create): kebab-case slug of the plan topic. Priority: **(1)** explicitly passed ID / durable issue number → **(2)** existing slug from a prior run (found via search-before-create) → **(3)** new kebab-case slug from the plan/title topic. The `PLAN.md` path is only a **secondary hint** (not stable across worktrees; external specs have none), **never** the identity itself.
  - **Separate content fingerprint** `<!-- prd-content-fp: <hash> -->` — only for diff/audit/bump decisions, **not** for identity.
- **search-before-create:** **no** reliance on GitHub Search (doesn't index HTML comments). Bounded, local:
  ```bash
  gh issue list --repo <owner>/<repo> --state open --limit 500 --json number,body,labels
  # filter locally on `prd-source-id: <id>` → 1 match ⇒ update; >1 ⇒ STOP+report; 0 ⇒ create
  ```

## 4. Write the Draft PRD (deliverable)

1. Understand repo/code (if not already), respect the domain glossary + ADRs. Sketch deep modules, align with the user (which get tested).
2. Write the PRD per the template below.
3. **Board sync (mandatory):**
   - **Status `Spec`**, exactly **one** `type:*` (default `type:feature`; pure process/workflow scope → `type:followup`/`type:research` per intent) **plus** one `priority:*` (mandatory vocabulary "type+priority"). **No** `type:cluster`, **no** Wave, **no** `ready-for-agent` — a Draft PRD isn't buildable yet, it's waiting on `to-issues` decomposition.
   - Board sync via helper:
     ```bash
     python3 scripts/board-sync.py create --title "<PRD title>" --body-file <prd.md> \
       --label type:feature --label priority:medium --status Spec        # Mode A
     # Mode B: gh issue edit <target> --body-file <prd.md>  +  board-sync.py add --issue <target> --status Spec
     ```
   - **Mode B — explicit status flip:** writing the PRD into a `board-to-waves` stub, `board-sync.py add --issue <target> --status Spec` flips the board status **Triaged → Spec** (the stub was at Triaged; a Draft PRD sits at Spec).
4. **Body markers (top of the PRD body):**
   - `**plan_revision:** r1`
   - `<!-- prd: awaiting-decomposition -->` — durable distinguishability marker: makes "PRD awaiting `to-issues`" board-discoverable **without** a new label (status `Spec` alone also covers planned anchors/other specs).
   - `<!-- prd-source-id: <id> -->` + `<!-- prd-content-fp: <hash> -->` (see step 3).
5. **Mode B label normalization:** if the reused issue carries wrong/multiple `type:*`, missing `priority:*`, `ready-for-agent`, or `needs-info` → **normalize onto the PRD contract** (exactly one `type:*`, one `priority:*`, no `ready-for-agent`/`needs-info`). Exception `type:cluster`/Wave → **no** normalization, **hard stop** (step 2).

## 5. `spec-self-critique` — mandatory next step

to-prd has `disable-model-invocation: true` and can't literally invoke a skill. **After** the PRD write, the agent **must** run `spec-self-critique` on the Draft PRD; its visible two-liner (`Self-critique complete — N corrections: …` or `…no corrections needed`) is required output **before** the user review question.

## 6. Idempotent reconcile (re-run)

- **`plan_revision` parse:** counter `r<N>`; missing/malformed → treat as `r1` + warn. **Body-changing** = a non-empty diff over the **canonical PRD sections** (Problem/Solution/User-Stories/Implementation-Decisions/Testing), **excluding** metadata markers, the child-drift section, and critique output. An identical plan re-run does **not** bump.
- **R1 — no children:** update body instead of duplicating; bump `plan_revision` only on a body-changing run; critique re-runs.
- **R2 — children/cluster exist:** update body + bump + **flag durably** — a **`## Child Drift (as of r<N>)`** section in the body (not ephemeral chat output) lists children + their revision. **No** child mutation (= `to-issues`/1d), **no** blocking guard (= 1g).
- **Child discovery:** native sub-issues (via `python3 scripts/board-sync.py parent-of <#>` / rollup) are the authoritative set; report native-vs-body-listed mismatches in the drift section.

## 7. Execute-ready assertion (exit)

- **Before the write (gate):** target carries cluster/Wave → **fail before write** (hard stop, step 2) — never "reconcile after the write".
- **After the write:** assert that the Draft PRD **exists as a board item** (status write = `Spec`), exactly **one** `type:*` + **one** `priority:*`, **no** `ready-for-agent`, **no** `type:cluster` + **no** Wave (defensive against accidental mutation), carries `plan_revision` + `awaiting-decomposition` + `prd-source-id`, body complete (critique ran). = an unambiguous "PRD-awaiting-decomposition" state (neither AFK leaf nor HITL child — that's `to-issues`'s call).

## 8. Audit block (visible output)

```
to-prd: mode=<A|B> target=#<n> <created|updated> rev <old>→<new>
  status=Spec  labels=<type:*, priority:*>  cluster/Wave=none
  source=<plan|conversation|external>  synthesized=<marker-list | none>  readiness=<ok | open-questions>
  child-drift=<none | #a(r1) #b(r1) …>
```
`source` = where the input came from (make cold start visible anchor). `synthesized` = which markers `to-prd` freshly set (e.g. `prd-source-id`). `readiness=open-questions` ⇔ the PRD carries a non-empty `## Open Questions` section.

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
