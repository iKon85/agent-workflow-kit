# SLICE-METADATA-FORMAT — per-slice metadata block

The metadata block a **planned slice** carries inside a Program-PRD's
`## Slices` chapter (see `.claude/skills/to-prd/PROGRAM-PRD-FORMAT.md`), and the
same fields carried forward onto the real Slice **leaf issue** once `to-waves`
publishes it. Parsed pre-publish by `scripts/program_graph.py`
for `validate-graph`; the same grammar is what a published leaf keeps so drift
tooling (adopt-path, program-sync) reads one consistent shape whether the slice
is still a PRD sub-section or already a real GitHub issue.

## The five fields — grep-bare HTML comments

One fact per line, consistent with the existing `final-cut-depends-on`
convention (`scripts/execute-ready-check.py`'s marker table) — plain HTML
comments, never folded into prose, so a script can `grep`/regex them without
parsing Markdown semantics:

```
<!-- wave: 1 -->
<!-- phase: P1 -->
<!-- area: scripts -->
<!-- gate: — -->
<!-- blocked_by: none -->
```

| Field | Value | Meaning |
|---|---|---|
| `wave` | integer | The Welle number (from the Wellenplan's `Welle` column) this slice belongs to. |
| `phase` | a Phase id (`P1`, …) or `—` | Omit/`—` when the program doesn't use phases. |
| `area` | free text (e.g. `scripts`, `frontend`, `backend`) | A short human hint about where the slice lands — not machine-checked, purely orientation. |
| `gate` | `—` \| `🧭` \| `🔬` \| `📐` \| `📝` | Same Gate-Legende as `wave-anchor-template.md`. `—` = AFK-buildable; the other four mark a Gate-Slice (read-only, blocks its dependent build-slice). |
| `blocked_by` | `none` or comma-separated **local-ids** | Other slices (by local-id, e.g. `1a`, `2c`) that must land first. `none` (not an empty string) when there is no dependency. |

**Never add a sixth field without updating this file first** — `program_graph.py`'s
parser only recognizes exactly these five keys; an unrecognized field is silently
ignored (forward-compatible for prose additions), but a mistyped one of these
five (e.g. `blocks_by`) breaks that slice's graph edges invisibly.

## Local-id convention

The local-id (`1a`, `1b`, `2a`, …) is the slice's identity **before** it becomes
a real GitHub issue — `<wave-number><letter>`, letters assigned in the order the
slice appears under its wave. It is how the Wellenplan table's `Slices` column,
other slices' `blocked_by`, and this slice's own heading
(`#### 1a — <Title>`) all refer to the same slice unambiguously pre-publish.
Once `to-waves` publishes the slice as a real issue, the local-id is superseded
by the issue number everywhere `final-cut-depends-on`-style cross-references are
used — but the metadata block's five fields keep the same shape (only `wave` and
`phase` typically survive verbatim; `blocked_by` gets rewritten to `#<n>`
references by the publish step).

## Body skeleton

Below the metadata block, every slice section carries the same three-part
skeleton — filled in loosely during `to-waves`' planning pass, **finalized**
(sharpened into a full What-to-build + AC, matching a leaf issue's usual shape)
only at promotion time, same "Late Binding" principle as the rest of the
program-route mechanics (content quality is deliberately just-in-time, not
ex ante):

```
Outcome: <one sentence — the user-visible or structural result this slice delivers>

What to build: <placeholder — sharpened at promotion>

AC: <placeholder — sharpened at promotion>
```

A slice section that still carries bare placeholders is normal *before*
promotion — `validate-graph`'s structural axes don't require sharpened prose,
only the five metadata fields and a resolvable heading. Content sharpening is a
`to-waves` promotion-time concern, not a `validate-graph` concern.
