# PROGRAM-PRD-FORMAT — the Program-PRD body grammar

The machine-parsable body grammar for a **Program-PRD** — the native Sub-Issue
Anchor sitting above a multi-Wave program (Programm → Phase → Welle → Slice,
per the program-altitude design, §2). Written by `to-prd`'s `mode=program`
auto-detection or by hand for an early program draft; parsed by
`scripts/program_graph.py` (`board-sync.py validate-graph`) for the counted
Vorschau-Gate report that `to-waves` shows before any Board write.

A regular feature-PRD (`.claude/skills/to-prd/SKILL.md`'s `<prd-template>`) stays
unchanged — this is a **parallel** grammar for the program altitude, not a
replacement.

## Top-of-body markers

```
<!-- prd: program -->
**plan_revision:** r1
```

`<!-- prd: program -->` is the durable, board-discoverable distinguishability
marker (the program-altitude counterpart of a feature-PRD's
`<!-- prd: awaiting-decomposition -->`). `**plan_revision:** rN` is the existing
convention (`execute-ready-check.py`'s `parse_plan_revision`) — it must sit before
the first Markdown heading.

## `## Scope` — stable Scope-Item IDs

A flat list of Scope-Items, each with a **stable ID** (`S1`, `S2`, …) that never
changes across revisions — the Wellenplan table's `covers` column references
these IDs, which is what makes Scope-Abdeckung ("X von Y") countable instead of
prose-only:

```
## Scope
- **S1:** <one-line capability or outcome>
- **S2:** <one-line capability or outcome>
```

IDs are assigned once, in order, and never reused or renumbered — a later
revision that drops S2 leaves a gap rather than shifting S3 down (identity ≠
position, same spirit as `to-prd`'s `prd-source-id`).

## `## Wellenplan` — the machine-parsable wave plan table

Wrapped in explicit markers (parser locates the block by marker, not by
heuristic column-sniffing — a fresh grammar gets a fresh, unambiguous anchor):

```
## Wellenplan
<!-- wellenplan:start -->
| Welle | Status | Name | Phase | Slices | Gate | covers |
|---|---|---|---|---|---|---|
| 1 | ⬜ | Fundament | P1 | 1a, 1b | — | S1,S2 |
| 2 | ⬜ | Helper | P1 | 2a | 📐 | S3 |
| 3 | ⬜ | Cleanup |  | 3a | — | enabler |
<!-- wellenplan:end -->
```

Columns:

- **Welle** — the wave number (monotone within the program; stable once
  published, per the ex-ante-stempel decision).
- **Status** — volatile, `⬜` at authoring; regenerated monotonically by
  `program-sync` from the wave's board status (⬜ not-started → 🔄 In
  Arbeit/Review → ✅ Done), never regresses. Not authored by hand and not a
  `validate-graph` input; the only column `program-sync` rewrites.
- **Name** — the wave's short title (becomes `Welle <N> — <Name>` on promotion,
  same `wave_title()` convention as the bottom-up route). Hand-owned prose —
  `program-sync` never touches this cell.
- **Phase** — optional. **Omit the whole column** if the program doesn't use
  phases at all (phases are optional per the program-altitude design, §2). If used, every wave row
  needs a Phase value (checked by `validate-graph`'s Rollup-Kette axis).
- **Slices** — comma-separated local-ids (see SLICE-METADATA-FORMAT.md)
  referencing the `## Slices` chapter below — **not** issue numbers (none exist
  pre-publish; `to-waves` mints the real Sub-Issues at publish time).
- **Gate** — this wave's Gate tag, same legend as `wave-anchor-template.md`:
  `—` AFK-Bau · 🧭 Design-Grill · 🔬 Verify-Spike · 📐 Abwägung/Research ·
  📝 Review-Notiz. Always filled (`—` is a valid, explicit "no gate").
- **covers** — comma-separated Scope-Item IDs this wave carries forward
  (`S1,S2`), or the literal token **`enabler`** for a wave that intentionally
  serves no Scope-Item directly (pure infrastructure/groundwork — declared, not
  silently absent).

The table is the **single source of truth** for the vertical Rollup-Kette
(Programm → Phase → Welle → Slice must close with no gaps) and the horizontal
Scope-Abdeckung (every `S<n>` must be covered by ≥1 wave; every wave must cover
≥1 Scope-Item or be an explicit `enabler`) — both counted, not eyeballed, at the
Vorschau-Gate.

## `## Phasen-Gates` — the phase-gate checklist

Only present when the program uses phases (Wellenplan `Phase` column filled):

```
## Phasen-Gates
- [ ] P1: <the acceptance criterion that closes this phase>
- [ ] P2: <…>
```

Every Phase referenced by a Wellenplan row needs a matching entry here (checked
by `validate-graph`); an entry naming a Phase no wave uses is a "Checklisten-Waise"
gap, also surfaced.

## `## Slices` — per-slice detail sections

One `####`-level section per planned slice, referenced by its local-id from the
Wellenplan's `Slices` column. Grammar (metadata block + body skeleton) is owned
by `.claude/skills/to-waves/SLICE-METADATA-FORMAT.md` — read that file for the
exact field set. Example:

```
## Slices
#### 1a — Formate + Graph-Modul
<!-- wave: 1 -->
<!-- phase: P1 -->
<!-- area: scripts -->
<!-- gate: — -->
<!-- blocked_by: none -->

Outcome: `validate-graph` reports a counted Programm-Graph preflight.

What to build: …
AC: …
```

`blocked_by` references other **local-ids** (`blocked_by: 1a` or
`blocked_by: 1a,2c`) — never issue numbers, since none exist yet pre-publish.
A local-id referencing a slice in a **later** wave is a blocking
Rückwärts-Ref-über-Wellengrenze finding; a Gate-Slice (🧭/🔬/📐/📝) with
dependents outside its own wave is a non-blocking "Struktur-Verdacht" warning
(Gate-Slices are meant to be wave-local/AFK-safe).

## Abbruch-Konvention (program abort)

If a program is abandoned before completion, close in this order — never leave
Board zombies:

1. **Leaves** first — every unbuilt Slice sub-issue closes with the comment
   `superseded by program abort`.
2. **Stubs** (Welle-Anchors) next — same closing comment, once all their leaves
   are closed.
3. **The Program-PRD** last, closed manually by the maintainer — a Program-PRD
   is **never** auto-closed by a PR (`closes` never targets it, same rule as any
   other Wellen-Anchor).

Document the abort in the Program-PRD body itself (a short "Abgebrochen am
<Datum>: <Grund>" note) before closing it, so the history stays legible.
