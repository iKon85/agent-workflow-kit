---
name: to-waves
disable-model-invocation: true
description: "Internal Program graph engine behind the public to-issues Planning facade. Turns an explicitly identified Program-PRD into execute-ready wave anchors and slice leaves after one complete chat preview. Kept as a disabled compatibility entrypoint for existing explicit invocations; normal routing always selects to-issues."
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill to-waves --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# to-waves — Internal Program graph engine

This skill is an **Internal Program graph engine**, selected by `to-issues` only
when the source carries explicit, coherent Program identity. It is not a second
public Planning route. The disabled `/to-waves` invocation remains only as a
compatibility entrypoint for existing callers and tests; it applies this same
contract and should direct future normal use to `/to-issues`.

Takes a **Program-PRD** — the native Sub-Issue anchor over a multi-wave program
(Programm → Phase → Welle → Slice) — and turns its `## Wellenplan` chapter into
**fully planned wave anchors + slice leaves** on the board. Pipeline position:
`scale-check → grill → to-prd (program mode) → to-issues`, with this internal
engine owning the per-wave `to-prd → spec-self-critique → to-issues` maturity
pass inside this run.
The **grill and to-prd sit upstream**; the facade dispatches here once the
Program-PRD exists and its identity is coherent.
It **never invents structure** — it only unfolds what the plan already decided.

<!-- readiness:required-preflight:start -->
## 0. Required readiness preflight

This is the first executable workflow step. From the project root, before any remote write or other `gh`/`board-sync.py` command, run this read-only check:

```bash
node scripts/readiness.mjs check --skill to-waves --json
```

- `verdict=ready`: continue with the existing workflow without announcing the check. **Ready is silent.**
- `verdict=blocked`: `STOP` before any mutation. Report every required capability as `<capability>=<state>` so `issueTracker`, `managedBoard`, and `specCompleteness` failures — including distinct `missing`, `pending`, and `invalid` states — stay visible, then give exactly one recovery path: **Run `/setup-workflow`, then rerun `/to-issues`.** Do not fall back to bare tracker or board commands.
- `managedBoard=not-applicable`: `STOP` and report that Program planning through `/to-issues` is **inapplicable** for a project that deliberately has no managed board. This is a terminal project decision, not invalid evidence and not a partially active mode.
<!-- readiness:required-preflight:end -->

Board constants (project node, field/status IDs) + helpers live **consumer-side**:
read `docs/agents/board-sync.md` from the project root + use the helper
`scripts/board-sync.py` (missing → `/setup-workflow` scaffolds the project layer).
Issue bodies **always** via `--body-file` (inline `--body` with backticks/parens
crashes bash).

The two grammars to-waves consumes: the Program-PRD body grammar
(`.claude/skills/to-prd/PROGRAM-PRD-FORMAT.md` — the 8-column
`Welle | Status | Issue | Name | Phase | Slices | Gate | covers` Wellenplan table) and the
per-slice metadata block (`SLICE-METADATA-FORMAT.md`, next to this file). Read both;
to-waves does not re-parse them by hand — `scripts/program_graph.py` (via the helper)
is the parser.

## 1. Input — a Program-PRD

The target is a Program-PRD issue: it carries both the
`<!-- prd: program -->` marker and the configured Program-type label, plus a
`## Wellenplan` table. Passed in from the facade or explicit compatibility
invocation. If either identity half is missing, they disagree, or Feature
identity is also present, stop before preview or write and return to
`to-issues`; never infer Program mode from the table, prose, size, or model
judgment. A plain Feature-PRD remains on the facade's Feature path; a
Wave-Anchor is already a single wave.

## 2. Parse + validate — the graph preflight

After the required readiness preflight, run the graph preflight before preview or
publication — it is **read-only** (a single board read, zero mutations):

```bash
python3 scripts/board-sync.py validate-graph --issue <prd#>
```

It parses the Wellenplan table + the per-slice metadata blocks and reports the
counted Programm-Graph findings: cycles and backward refs across wave boundaries
(blocking), a Gate-Slice with dependents outside its own wave (a non-blocking
"Struktur-Verdacht" warning), capacity preflight (the 100-children-per-parent
GitHub limit), the phase-option preflight, revision coherence, and **both
completeness axes counted** — vertical Rollup-Kette (every leaf → one wave, every
wave → ≥1 slice + outcome gate + phase where used) and horizontal Scope-Abdeckung
(every Scope-Item covered by ≥1 wave; every wave covers ≥1 Scope-Item or is an
explicit `enabler`). The command exits non-zero when a **blocking** finding exists.

**A blocking finding stops the run — do not publish a broken graph.** Report it and
send the fix back to the PRD (a structural fix is an escalation, see §8).

## 3. Preview gate — before ANY board write

This is a **hard stop**. Show the whole plan in chat and get explicit approval
**before the first write**. Because nothing has been written yet, **a rejection
costs nothing** — the board is never left half-built.

Show:

- The **complete Wellenplan table**, one row per wave: number, name, phase, the
  slices with their bucket (AFK/HITL) + Gate tag, and each wave's dependencies.
- The **counted graph result** from `validate-graph` verbatim (Scope-Abdeckung
  `X von Y`, Rollup-Kette ✓/gaps, any warnings).
- The **publish plan**: how many stubs + leaves will be created, which referenced
  existing issues will be **adopted** (§4) rather than created, and which
  Wave/Phase stamps will be applied.
- The complete per-wave issue contracts that will be materialized: outcome,
  Blast-Radius, acceptance criteria, AFK/HITL bucket, native dependencies, and
  self-contained handoff. A placeholder is not preview-complete.

This complete Program preview is the **single user approval** for the default
planning run. Only on an explicit "yes" proceed to §4/§5/§7; when a later
per-wave maturity pass reproduces the approved cut, **do not ask for another per-wave approval**.
Ask again only when new evidence changes structure or exposes
a genuinely undecided gate. On "no", stop — no writes happened.

## 4. Publish — the fixed order

After approval, publish in **exactly this order** (issue CREATES stay sequential so
the numbering is deterministic; only the field stamps are batched):

1. **Wave stubs — transient Stufe 1p.** One per Wellenplan row, native parent = the PRD.
   Title `Welle <N> — <Name>`; created with the `wave-stub` label and Status Spec.
   Body = the Stufe-1p stub template (named header, the program idempotency marker,
   the revision marker — see §6). This is a crash-recovery checkpoint inside the
   run, never its successful terminal state. Not yet Wave/Phase-stamped (step 4).
   ```bash
   python3 scripts/board-sync.py create --title "Welle <N> — <Name>" \
     --body-file <stub.md> --wave-stub --status-role spec
   ```
2. **Preliminary slice leaves for multi-slice waves.** Create one per slice under
   each wave whose approved cut contains ≥2 slices, native parent = its stub. For
   an exactly-one-slice wave, **do not create a preliminary child**: keep that
   slice's metadata on the stub so step 6 can turn the stub itself into the atomic
   executable wave leaf without a duplicate identity. Preliminary children use
   the spec-role status and **no** `ready-for-agent` (a leaf is not buildable until its
   wave is promoted — the ordering guard stays unambiguous). Body = the slice's
   `## Slices` section carried forward per `SLICE-METADATA-FORMAT.md` (metadata block +
   the outcome/placeholder skeleton, finalized in step 6). **Title carries the
   navigation prefix** `Welle <N> / Slice <local-id> — <title>` — the local-id
   (`1a`, `1b`, …) encodes the build order, so the sub-issue LIST is navigable by title
   alone (same convention as `to-issues`' promoted children, `Welle N / Slice X — <outcome>`).
   ```bash
   python3 scripts/board-sync.py create --title "Welle <N> / Slice <local-id> — <slice title>" --body-file <leaf.md> --status-role spec
   ```
3. **Sub-issue links.** Link each stub under the PRD and each leaf under its stub.
   `link` is one-parent-checked + idempotent (a foreign parent is reported, never
   silently re-parented) — which is exactly what makes the re-run in §5 safe.
   ```bash
   python3 scripts/board-sync.py link --parent <prd#> --child <stub#>
   python3 scripts/board-sync.py link --parent <stub#> --child <leaf#>
   ```
   **Blocking edges — native.** For every leaf whose metadata `blocked_by` names
   sibling slices (local-ids now resolved to issue numbers), set the edge natively —
   native issue dependencies are the blocking SSOT; the helper also writes the
   `## Blocked by` body mirror (idempotent, safe under the §5 re-run):
   ```bash
   python3 scripts/board-sync.py dep-add --issue <blocked-leaf#> --blocked-by <blocker-leaf#>
   ```
4. **Batch-stamp Wave + Phase.** One `stamp-batch` over every stub and leaf. It
   consumes a JSON list of `{issue, item_id, wave, phase}`; assemble it by resolving
   each freshly-created issue's board **item id** from the project item list (the
   same read the helper's `next-wave` performs — `gh project item-list <n> --owner
   <owner> --limit 2000 --format json` (no `--limit` defaults to 30 — a silent
   truncation dead-end on a real board), matching `content.number` → item `id`).
   Missing `phase` in the profile is **skipped visibly**, never dropped silently.
   ```bash
   python3 scripts/board-sync.py stamp-batch --items-file <stamps.json>
   ```
   The counted line `N von M Feld-Stempel gesetzt` is the verification — there is no
   extra read-back pass. Any failed alias prints an idempotent single-item repair
   (`stamp-batch --issue … --item-id … --wave …`); re-run it, a field-set is idempotent.
5. **Wellenplan back-link sync.** Run `program-sync` once so the PRD's Wellenplan
   `Issue` column links each freshly created stub (`#<stub#>`, matched via the
   `Welle <N> —` title —; idempotent, fills-never-overwrites):
   ```bash
   python3 scripts/board-sync.py program-sync <prd#>
   ```
6. **Mature every wave.** For each stub in dependency order, run the approved
   Program batch handoff: `to-prd` Mode B writes the per-wave Draft-PRD,
   `spec-self-critique` hardens it, and `to-issues` promotes/atomizes it while
   reusing the preliminary leaves. The pass writes complete issue bodies, final
   AFK/HITL buckets, handoffs, native dependencies, `plan_revision`, and removes
   `wave-stub`. It inherits the §3 approval when the cut is unchanged.
7. **Audit every wave.** Run `execute-ready-check.py --mode audit` on every promoted
   anchor or atomic wave leaf. Any incomplete placeholder, incoherent revision,
   missing bucket, or child-set mismatch blocks successful completion. **Program completion gate:**
   Although `to-issues` uses audit mode as an informational handoff check, **do not count that wave as matured** or report
   Program success until its audit findings are clean.
8. **Counted completion report + program view link.** Report `X von Y` for each part
   (stubs created, leaves adopted/created, field stamps set, waves matured, waves
   execute-ready) and link the program board view. Completeness is **counted, never
   claimed** — the numbers come from the commands, including the exact line
   `X von Y Wellen ausführungsreif`.

## 5. Adopt path — referenced existing issues

If a Wellenplan row references an **existing** issue (`#n`, e.g. one produced by
bottom-up backlog grooming), that issue is **ADOPTED**, not re-created — otherwise a
bottom-up → program transition rains duplicates. Adoption:

- **Board-sync + strip the buildable labels** in one call. `--bucket hitl` strips
  `ready-for-agent` and `wave-stub` (a leaf is not buildable until its wave is
  promoted) while the **body is kept** as the source content:
  ```bash
  python3 scripts/board-sync.py add --issue <n> --status-role spec --bucket hitl
  ```
- **Re-parent under the stub** with `link` (one-parent-checked — a foreign parent is
  reported, not overwritten). Resolve a reported conflict by hand: unlink the old
  parent first — `python3 scripts/board-sync.py unlink --parent <old#> --child <n>`
  — then re-run `link` under the intended stub.
- **Include it in the §4 batch-stamp** so it gets the same Wave/Phase as a fresh leaf.

Adoption normalizes workflow labels **immediately** (the strip above) so the
ordering guard stays clean; it never touches the issue's body.

## 6. Idempotent re-run + revision coherence

A re-run of to-waves on the same program is **delta-apply** and doubles as
**crash-recovery** for a publish that was interrupted mid-way.

- **Idempotency markers.** Every stub carries a stable
  `<!-- program-stub-source: <prd-source-id>/w<N> -->` and every leaf a
  `<!-- program-leaf-source: <prd-source-id>/<local-id> -->` (same spirit as the
  bottom-up `wave-stub-source` marker; `<prd-source-id>` is the PRD's own source
  slug). These never change across revisions — they are the identity for
  search-before-create.
- **Delta apply.** Resolve every planned identity through the shared all-state,
  exact-marker CLI (it uses `gh api --paginate`, discards REST pull-request
  items, and does not rely on GitHub Search or a capped issue list):
  ```bash
  python3 scripts/find-by-marker.py --kind program-stub-source --slug "<prd-source-id>/w<N>"
  python3 scripts/find-by-marker.py --kind program-leaf-source --slug "<prd-source-id>/<local-id>"
  ```
  Branch on each JSON result (`count`, `issues[].number`, `issues[].state`,
  `verdict`): `0` / `create` → create; exactly one `open` / `update` → update in
  place; exactly one `closed` / `user-decision` → ask the user whether to reopen,
  use a new identity, or stop; `>1` / `STOP` → stop and report every number/state.
  Never auto-delete or silently replace a closed/duplicate identity. Immediately
  after every create, run the same lookup with `--created <new-issue-number>` and
  continue only when exactly the newly-created open issue is returned; a duplicate
  reconciliation stops loudly with both/all numbers for user-decided resolution.
  A live issue carrying a
  `program-*-source` for this program that the current plan no longer references →
  report as **orphaned** (do not auto-close — closing is the abort convention, §8).
  Cross-check the native children (`children-of <prd#>` and each stub) against the
  plan so both origins are covered.
- **Atomic supersession exception.** A marked preliminary leaf whose local-id maps
  to the one slice now carried by its atomic stub is not a generic orphan. Route it
  to `to-issues` §5b cleanup whether it is still linked or was already unlinked by
  an interrupted run. Search-by-marker is the durable recovery identity.
- **Crash recovery.** Because create is search-before-create, `link` is idempotent,
  and `stamp-batch` field-sets are idempotent, re-running the whole publish after an
  abort resumes cleanly — already-created issues match, missing ones are created,
  links/stamps re-apply harmlessly.
- **Revision coherence.** to-waves stamps `<!-- program-revision: rN -->` on every
  stub. `validate-graph` checks this marker against the PRD's
  current `plan_revision` — a **stale** stub (the wave plan was revised since) blocks
  **loudly** instead of silently building from an old shape. On a plan-revision bump
  (the escalation path, §8), the delta re-run **renews the `program-revision` marker
  of every still-living stub that would otherwise fail the current PRD check** — read
  this broadly: every stub whose marker is behind, not only the textually changed
  rows. The renewal is a body edit via `gh issue edit <stub#> --body-file <updated>`
  (the same sanctioned body-write `to-prd` Mode B uses). The mechanism that renews
  coherence is the same one the revision broke — it self-repairs.

## 7. Program completion contract

to-waves also carries the **program-grill agenda** as a reference chapter — the
checklist a program grill (upstream) should cover so the wave plan does not rest on
open switches:

- **Scope → Phases.** Break the outcome into phases (optional) and the Scope-Items
  (stable IDs) each phase serves.
- **Gates from DoDs, in outcome language.** Every phase/wave gate is an
  acceptance criterion phrased as a user-visible outcome, not a task.
- **Wave cut.** Each wave is an outcome slice (a tracer), never a layer slice — a
  "backend wave" is an anti-pattern; an enabler wave names the half it cuts off and
  the outcome wave that closes it.
- **Metadata.** Wave numbers, phases, covers-IDs, gate tags filled per the two
  grammars.
- **Structure-bearing decisions are grill work, never a plan work-item.** A decision
  that changes where a boundary falls is resolved **at the grill** — escalate a
  single bounded choice to `decision-gate` — not deferred into the plan as an open
  task.

**Default postcondition:** every published wave is fully planned and passes the
shared execute-ready audit before this run reports success. Stufe 1p is an
internal recovery state, not the result presented to the user. **Late Binding is not the default**
for unfinished issue prose or missing buckets.

Uncertainty is planned, not hidden. A bounded trade-off becomes an explicit
**Decision Gate**, a factual unknown becomes a **Verify Spike**, and an unresolved
structure seam becomes a HITL **Design-Grill** slice (or an explicitly named
planning wave). Place that gate before its dependent build slice and write the
native blocking edge. The gate issue itself still receives a complete contract and
handoff; the dependent work is blocked, not vaguely under-planned.

A mandatory human or external setup action follows the same rule: model it as a
HITL predecessor, never bury it inside a `ready-for-agent` build leaf. If later
drift invalidates an already planned wave, use the revision/escalation path in §8;
do not pre-emptively leave every future wave incomplete.

## 8. Close protection, abort convention, escalation path

- **Never `closes` the Program-PRD or a wave anchor.** A slice PR uses `Part of
  #<anchor>`; `closes` only ever targets a leaf. The PRD is closed **last, manually**,
  when the program is done — never auto-closed by a PR.
- **Abort convention.** To abandon a program cleanly (no board zombies): close
  **leaves first** (`superseded by program abort`), then their **stubs**, then the
  **Program-PRD** last, manually — the order documented in the PROGRAM-PRD-FORMAT
  Abbruch-Konvention.
- **Escalation path.** When a gate result flips the structure (a wave needs to
  split/merge/reorder), **STOP** — do not patch it in a build slice. Revise the
  Wellenplan **at the PRD** with the maintainer, **bump `plan_revision`**, and re-run
  to-waves as a **delta** (which renews the `program-revision` markers per §6).
  Append-only drift notes (to future stubs/leaves + the PRD) do **not** bump
  `plan_revision`; only a structural wave-plan change does.

## 9. Live dashboard — program-sync

Between wave events the PRD's Wellenplan **Status** + **Issue** columns are
regenerated from the board (monotone, idempotent — Status never regresses, Issue
fills but never overwrites; hand-owned Name/Plan cells survive verbatim), and
mechanically completed **Phasen-Gates** are checked off (all waves of a phase ✅ →
`[x]` with an `— alle Wellen ✅ (<date>)` stamp). `wrapup` triggers the same
sync automatically on every slice merge whose wave anchor has a program parent
(upward propagation — the program table shows the event, not only the wave):

```bash
python3 scripts/board-sync.py program-sync <prd#> --dry-run   # preview the diff first
python3 scripts/board-sync.py program-sync <prd#>
```

## Audit block (visible output)

```
to-issues: planning-mode=program engine=to-waves prd=#<n> preview=<approved|rejected>
  created=<stubs X von Y, leaves X von Y>  adopted=<#a #b … | none>
  stamped=<N von M Wave/Phase>  phase=<stamped | skipped (profile lacks fields.phase)>
  matured=<X von Y>  execute-ready=<X von Y Wellen ausführungsreif>
  revision=r<N>  renewed-markers=<count | none>  orphaned=<#… | none>
  graph=<ok | blocking: …>  program-view=<url>
```
