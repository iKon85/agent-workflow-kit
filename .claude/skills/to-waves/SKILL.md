---
name: to-waves
disable-model-invocation: true
description: "Unfold a Program-PRD's wave plan onto the board — parse + graph-validate it, show the complete Wellenplan as a chat preview before ANY board write, then after approval publish named wave stubs (native parent = the PRD) + slice leaves (native parent = their stub) with Wave and Phase stamped in one batch, and report a counted completion. Idempotent + crash-recoverable on re-run; adopts referenced existing issues instead of duplicating them. Use on a Program-PRD, the native anchor over several waves. NOT for a single-wave feature (to-issues) and NOT for clustering a backlog (board-to-waves)."
---

# to-waves — Unfold a Program-PRD's wave plan onto the board

Takes a **Program-PRD** — the native Sub-Issue anchor over a multi-wave program
(Programm → Phase → Welle → Slice) — and turns its `## Wellenplan` chapter into
**named wave stubs + slice leaves** on the board. Pipeline position:
`scale-check → grill → to-prd (program mode) → to-waves → …per wave: to-issues`.
The **grill and to-prd sit upstream**; to-waves runs once the Program-PRD exists.
It **never invents structure** — it only unfolds what the plan already decided.

Board constants (project node, field/status IDs) + helpers live **consumer-side**:
read `docs/agents/board-sync.md` from the project root + use the helper
`scripts/board-sync.py` (missing → `/setup-workflow` scaffolds the project layer).
Issue bodies **always** via `--body-file` (inline `--body` with backticks/parens
crashes bash).

The two grammars to-waves consumes: the Program-PRD body grammar
(`.claude/skills/to-prd/PROGRAM-PRD-FORMAT.md` — the 7-column
`Welle | Status | Name | Phase | Slices | Gate | covers` Wellenplan table) and the
per-slice metadata block (`SLICE-METADATA-FORMAT.md`, next to this file). Read both;
to-waves does not re-parse them by hand — `scripts/program_graph.py` (via the helper)
is the parser.

## 1. Input — a Program-PRD

The target is a Program-PRD issue: it carries the `<!-- prd: program -->` marker (or
the program-type label) and a `## Wellenplan` table. Passed in / from context. If the
issue is a plain feature-PRD or a Welle-Anchor, stop — a feature-PRD is `to-issues`'
target, an anchor is already a single wave.

## 2. Parse + validate — the graph preflight

Run the graph preflight first — it is **read-only** (a single board read, zero
mutations):

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

Then ask for approval. Only on an explicit "yes" proceed to §4/§5. On "no", stop —
no writes happened.

## 4. Publish — the fixed order

After approval, publish in **exactly this order** (issue CREATES stay sequential so
the numbering is deterministic; only the field stamps are batched):

1. **Wave stubs — Stufe 1p.** One per Wellenplan row, native parent = the PRD.
   Title `Welle <N> — <Name>`; created with the `wave-stub` label and Status Spec.
   Body = the Stufe-1p stub template (named header, the program idempotency marker,
   the revision marker — see §6). Not yet Wave/Phase-stamped (that is step 4).
   ```bash
   python3 scripts/board-sync.py create --title "Welle <N> — <Name>" \
     --body-file <stub.md> --wave-stub --status Spec
   ```
2. **Slice leaves.** One per slice under each wave, native parent = its stub. Created
   with Status Spec and **no** `ready-for-agent` (a leaf is not buildable until its
   wave is promoted — the ordering guard stays unambiguous). Body = the slice's
   `## Slices` section carried forward per `SLICE-METADATA-FORMAT.md` (metadata block +
   the outcome/placeholder skeleton, sharpened only at promotion).
   ```bash
   python3 scripts/board-sync.py create --title "<slice title>" --body-file <leaf.md> --status Spec
   ```
3. **Sub-issue links.** Link each stub under the PRD and each leaf under its stub.
   `link` is one-parent-checked + idempotent (a foreign parent is reported, never
   silently re-parented) — which is exactly what makes the re-run in §5 safe.
   ```bash
   python3 scripts/board-sync.py link --parent <prd#> --child <stub#>
   python3 scripts/board-sync.py link --parent <stub#> --child <leaf#>
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
5. **Counted completion report + program view link.** Report `X von Y` for each part
   (stubs created, leaves created, issues adopted, field stamps set) and link the
   program board view. Completeness is **counted, never claimed** — the numbers come
   from the create outputs + the `stamp-batch` response, not from memory.

## 5. Adopt path — referenced existing issues

If a Wellenplan row references an **existing** issue (`#n`, e.g. one produced by
bottom-up backlog grooming), that issue is **ADOPTED**, not re-created — otherwise a
bottom-up → program transition rains duplicates. Adoption:

- **Board-sync + strip the buildable labels** in one call. `--bucket hitl` strips
  `ready-for-agent` and `wave-stub` (a leaf is not buildable until its wave is
  promoted) while the **body is kept** as the source content:
  ```bash
  python3 scripts/board-sync.py add --issue <n> --status Spec --bucket hitl
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
- **Delta apply.** Filter existing issues locally by their source marker
  (`gh issue list --json number,body` + a local filter, no reliance on GitHub search —
  it does not index HTML comments). For each planned stub/leaf: **match** → update in
  place (never duplicate); **missing** → create; a live issue carrying a
  `program-*-source` for this program that the current plan no longer references →
  report as **orphaned** (do not auto-close — closing is the abort convention, §8).
  Cross-check the native children (`children-of <prd#>` and each stub) against the
  plan so both origins are covered.
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

## 7. Program-grill agenda + the per-wave-start content pass

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

**The per-wave-start content pass** is where slice content is sharpened — deliberately
**just-in-time (Late Binding)**, never ex ante on spec. When a wave is promoted:
`to-prd` (Mode B, into the wave stub) + `spec-self-critique` are **mandatory**, and
the depth ladder is **raised for a high-stakes wave** (a design-grill or a
`decision-gate` before slicing). This is what folds in any drift propagated since the
plan was first written.

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

Between wave events the PRD's Wellenplan **Status** column is regenerated from the
board (monotone, idempotent — it never regresses a wave's status, and it touches only
the Status cell; hand-owned Name/Plan cells survive verbatim):

```bash
python3 scripts/board-sync.py program-sync <prd#> --dry-run   # preview the diff first
python3 scripts/board-sync.py program-sync <prd#>
```

## Audit block (visible output)

```
to-waves: prd=#<n> preview=<approved|rejected>
  created=<stubs X von Y, leaves X von Y>  adopted=<#a #b … | none>
  stamped=<N von M Wave/Phase>  phase=<stamped | skipped (profile lacks fields.phase)>
  revision=r<N>  renewed-markers=<count | none>  orphaned=<#… | none>
  graph=<ok | blocking: …>  program-view=<url>
```
