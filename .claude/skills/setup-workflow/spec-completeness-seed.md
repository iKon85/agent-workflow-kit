# Convention — Spec completeness before implementation

Specs should reach structural completeness before implementation, so that avoidable bugs are caught at spec time rather than during live-verify. This is the project's seed convention; grow it over time (via `/retro`) by adding more `## Self-Critique-Check` blocks below.

`spec-self-critique` point 8 iterates every `docs/conventions/*.md` file and runs the `## Self-Critique-Check` block it finds (format: **Trigger / Check / Korrektur**). A convention file without such a block is skipped with a warning — so this seed ships one valid block.

## Self-Critique-Check

**Trigger:** the spec states any concrete count, quantity, or "N of M" claim (number of callers, tests, rows, files, occurrences).

**Check:** is each such number empirically verified against the source (a `grep -c`, a query, a file listing) rather than estimated or recalled?

**Korrektur:** re-derive every concrete number from the source before finalizing the spec; replace estimates with the verified count, or mark the claim as an explicit assumption to confirm during implementation.

## Vertikal-Slice-Vollständigkeit (decompose-readiness)

The convention section `to-issues` reads at runtime (it references `spec-completeness.md` §Vertikal-Slice-Vollständigkeit). Seeded project-neutral; grow it with your project's incidents over time.

**Trigger:** an artefact is about to be decomposed by `to-issues` — regardless of entry point (a `to-prd` PRD, an external PRD, a raw issue, a mechanical file bundle).

**Provenance-independent:** the contract checks the artefact's **form**, never which tool produced it. Grill depth (none / light / adversarial) is the entering person's choice — `to-issues` re-derives readiness from the artefact, it does not require a specific upstream step to have run.

**Decompose-readiness — always (every artefact class):**
- Each user-facing slice is a tracer-bullet outcome sentence ("<user action> → <visible result>"), not a layer name ("Config UI", "Backend resolver").
- ≥1 acceptance criterion per slice.
- Blast radius estimated per slice (~N files from recon/grep, not a guess).
- Seam-ownership flagged: does a slice replace/unify/retire a central mechanism? → its own grill-needed (HITL) slice, never hidden in a behavior-preserving tweak.
- Each byte-neutral/prep slice names the half it defers + the later slice that closes it.

**Mechanical-bundle minimum** (a file-list / refactor with no domain scope — e.g. shrinking files under a size/lint gate):
- Anchor/leaf header = one sentence *why* (e.g. "bring files over the size gate under it, behavior-neutral").
- Per file-slice: outcome title + short what + AC (usually "behavior unchanged + gate satisfied + tests green") + blast radius.
- Seam-check explicit ("no central mechanism replaced", or name it → then grill that slice).
- The domain grill is **skippable only** when the blast radius is estimable **and** small **and** no seam is touched; otherwise the slice is HITL with the open structural questions. No open-questions section is needed when nothing is open.

**Anti-pattern:** `to-issues` rubber-stamping a pre-cut table — the table is only "done" when every user-facing row passes the trace against the code.

## Self-Critique-Check

**Trigger:** the spec/PRD contains a slice/phase table or decomposes into multiple PRs/issues.

**Check:** is every user-facing slice a tracer-bullet outcome (not a layer name)? Does every byte-neutral slice name its deferred half + closing slice? Is blast radius estimated and seam-ownership flagged per slice?

**Korrektur:** reformulate layer-only slices as outcomes or split them; carve a new slice for any uncovered half; mark a seam-replacing slice as its own HITL slice.
