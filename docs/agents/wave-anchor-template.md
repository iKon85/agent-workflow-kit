# Wave Anchor Template

The body of a wave-anchor issue. Model: this is the tracker that worked — **slimmed in**: the template part carries **navigation + decisions only**, and the full PRD is folded underneath it into a collapsed `<details>` section. One body, written once: `--json body` loads all of it, so the fold is a reading affordance for a human, not a token saving — the deliberate trade for a publish run that writes a single artefact and has no second remote object to classify when it resumes. The paste-ready handoff lives **in each slice leaf** (self-contained — no anchor↔leaf circular reference).
**Maturity stages** — replace `<…>` placeholders, delete lines that don't apply:

- **Stage 1 (candidate stub, bottom-up)** — filled by `board-to-waves`: header through the To-Do checklist. **No cluster/Wave** yet, Slice table stays empty (`⬜ via to-issues`).
- **Stage 1p (program pre-state, top-down)** — filled by `to-waves` from a Program PRD: a named stub `Welle <N> — <Topic>` **from creation**, `wave-stub` label, **Wave + Phase stamped immediately**, native parent = the Program PRD, pre-generated Slice leaves as native children. Difference from Stage 1: named + stamped + PRD-parent instead of no cluster/Wave. Details below (§ Stage 1p).
- **Stage 2 (matured + promoted)** — filled by `to-prd` (Decisions body) + `to-issues` (Slice table, links sub-issues, the publish run sets `type:cluster` + Wave; the full PRD is folded into the **same body** behind a collapsed `<details>` summary, the To-Do checklist **collapses to its one-line summary**, per-slice handoffs land in the **leaf bodies**). A Stage-1p stub matures the same way here (the first program-stub promotion flips the PRD to the in-progress status, `roles.inProgress`).

The **candidate stub** (Stage 1) has no cluster/Wave. On **`to-issues` promotion** (Stage 2) the anchor gets `type:cluster` + **Wave field = `<N>`** (monotone number, no `wave:*` label); `type:cluster` **replaces** the stub's previous `type:*` (e.g. `type:followup`) — exactly one `type:*` per issue, the publish run (`board-sync.py publish-anchor`, sharing `promote`'s writes) strips the old one; the **issue title becomes `Welle <N> — <Topic>`** (its default behavior — `wave_title()` idempotently replaces any existing `Welle X —` prefix and strips a leading conventional-commit prefix; opt out with `--no-rename` — **the code is authoritative**), and the `Welle <N> — <Topic>` string also appears in the **body's top line**. Body **always** via `--body-file` (`gotchas_gh_body_file`). Numbering → [the `board-to-waves` SKILL.md](.claude/skills/board-to-waves/SKILL.md) "Wave numbering".

---
--- TEMPLATE STARTS HERE (everything above is guidance, don't copy it into the issue) ---

<!-- wave-stub-source: <topic-slug> -->   <!-- Stage 1: stable idempotency marker, board-to-waves search-before-create; kebab-case slug of the gate outcome, never changed -->
<!-- prd-source-id: <#> -->
**plan_revision:** r<N>        <!-- Stage 2: stamped at promotion (before the first heading — the execute-ready checker requires it there, otherwise the post-promote audit denies the anchor) -->

**Welle <N> — <Short description>.** Common thread: <Gate — the shared outcome that makes these issues a wave>.

> 📍 **Execution tracker (as of <Date>).** This issue is the single source of truth for "where do we stand, what's next". Every sub-session anchors here.

## Origin

- **Source:** <board-to-waves | external-prd | raw-issue | plan | grill> *(provenance-neutral — the shape is the same regardless of origin; fill the following lines where they apply, delete where they don't)*
- **Member issues:** #<a> #<b> #<c> … *(listed; linked via `to-issues` promotion, To-Do below)*
- **Why together (firing criteria):** Gate=<Outcome> · <B1 code proximity / B2 type homogeneity / B3 dependency / B4 verify surface, where applicable>
- **Size + risk:** ~<N> slices · Backend: <yes/no> · Routing-intent mix: <judgment/development/mechanical + deep/balanced/light> · Risk: <low/medium/high — reason, e.g. race/cache/forecast/migration>
- **`grill-needed`:** <no> | <yes — this session> | <yes — own session (too big/fuzzy)>

### To-Do (maturation: grill → to-prd → to-issues) — *(Stage 1/1p only; at promotion this whole checklist collapses to ONE line: `Maturation: grill <✓/–> · to-prd ✓ · to-issues ✓ (<Date>) — Wave gate + tracking open`)*
- [ ] *(only if grill-needed=yes, own session)* dedicated `grill-with-docs` session — domain discovery
- [ ] **`to-prd`** → write decisions/PRD body into this stub (Mode B); `spec-self-critique` runs automatically
- [ ] **`to-issues`** → cut slices, **one sub-issue per slice** (reuse member issue / create new), fill the slice table + a **self-contained `## Handoff Start Command` in each slice leaf** (§5d); at ≥2 slices **publish** (one `publish-anchor` run: `type:cluster` + Wave + the one body with the PRD folded in) + link **all** slice sub-issues natively (complete — slice set == sub-issue set)
- [ ] **Wave gate** → before closing: reconcile any open `annahme-drift` propagation toward future waves/stubs (and, if part of a program, the Program PRD) — no unnoticed drift across the wave boundary (drift checkpoint, `wrapup` Step 5e.2)
- [ ] **Track** → rollup is the status; anchor closes at 100%

## Decisions — *(`to-prd` fills; for source `grill`: "Grill <Date>, locked")*

| Item | Decision |
|---|---|
| <Issue/Topic> | <What exactly, in outcome language> |

**Artifacts:** <CONTEXT.md terms / docs/adr/<nnnn>-…md, if produced during the grill>

## Slices (vertical, 1 PR/session each) — *(`to-issues` fills)*

Order (WSJF-lite): visible + low-risk first → logic/backend → cleanup. Dependencies force ordering.

<!-- slice-table:start -->
| # | Status | Slice | Sub-Issue | Gate | closes/refs |
|---|---|---|---|---|---|
| 1 | ⬜ | <Slice title> | #<sub> | <—/🧭/🔬/📐/📝> | <closes #x / refs #y> |
<!-- slice-table:end -->

Status legend: ⬜ open · 🔄 in progress · ✅ merged #<PR>. **Every slice = one sub-issue** (`#<sub>`). **The volatile Status column is generated by `board-sync.py anchor-sync <anchor#>` from the board** (between the `<!-- slice-table:start/end -->` markers; `wrapup` Step 5e.1 calls it on merge) — monotone (never flips a `✅`/`🔄` back), drift-free idempotent; **stable plan columns (Slice/Gate/refs) stay hand-maintained** and survive verbatim. It appends missing sub-issue rows (gen-b split). **Don't delete the markers** — without them `anchor-sync` can't locate the table (the first run locates it via the `Status`+`Sub-Issue` header row and sets the markers itself). The native "Sub-issues progress" rollup is the secondary %-view. *(Slimmed in: Branch is derivable from the `feat/<#>-<slug>` convention, provider-neutral routing intent lives in the leaf's handoff, Backend? carried no navigation value — legacy anchors that still have those columns keep working, `anchor-sync` matches columns by header name and refreshes Branch/Blocked-by only where the column exists.)*

**Gate legend (retro):** `—` AFK build (`/implement`) · 🧭 design grill (`grill-with-docs-codex`, ADR) · 🔬 verify spike (read-only fact question) · 📐 trade-off/research (read-only, below grill threshold) · 📝 review note (not a build slice). A gate slice (🧭/🔬/📐) sits **before** its dependent build slice (gate-before-build) and blocks it.

**Closing conditions:** <Issue #x → after which slices> · <…> · Anchor #<self> → all slices merged + native sub-issues 100%.

**Mid-wave discovered follow-ups** → schedule as a **slice row in this table** (an intermediate slice at the right sequence position, or at the end) + its own sub-issue (natively linked, counts in the rollup). **No** separate follow-ups table — that would be invisible in the slice view.

**Parallel note:** true parallelism only with a worktree per strand. Slices that share files → serial.

**Handoff lives elsewhere, the PRD is folded in:** the paste-ready start command sits **self-contained in each slice leaf** (`to-issues` §5d — scope + live-verify inline, no "see anchor" indirection). The template part of the anchor body ends here; the publish run appends the full grilled PRD underneath it in a collapsed `<details>` block (rationale for lookup, not per-session reading) — one body, written once, never a separate remote artefact.

## Stage 1p — Program pre-state (top-down, `to-waves`)

`to-waves` creates a **Program PRD**'s wave stubs in exactly this shape — the defined pre-state above the feature route (instead of no cluster/Wave like Stage 1):

- **Title** `Welle <N> — <Topic>` **from creation** (not only at promotion).
- **Label** `wave-stub`; **Wave + Phase** stamped immediately (batched via `stamp-batch`).
- **Native parent = the Program PRD** (3 levels: PRD → Stub → Slice leaves). The pre-generated Slice leaves hang as native children under the stub — for `to-prd` Mode B the **expected skeleton**, no child drift.
- **Idempotency marker in the body** (top line, grep-able, never changed):

```
<!-- program-stub-source: <prd-source-id>/w<N> -->   <!-- stable identity: to-waves search-before-create + delta re-run/crash recovery -->
<!-- program-revision: rN -->                          <!-- checked against the PRD's plan_revision; a stale stub blocks loudly; the delta re-run refreshes it -->
```

- **Handoff worktree line stays consumer-neutral** — the program pre-state is part of the published `to-waves` route, so **no** project-specific script path, but instead:

```
Worktree: your project's worktree helper, or `git worktree add`
```

Maturation: the stub matures at **wave promotion** like Stage 2 (`to-prd` Mode B into the stub + `to-issues`); unbuilt leaves/stubs of an abandoned program close in the order leaves → stubs → PRD (abandonment convention in the PROGRAM-PRD-FORMAT).
