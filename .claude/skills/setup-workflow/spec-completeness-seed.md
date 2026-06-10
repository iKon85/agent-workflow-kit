# Convention — Spec completeness before implementation

Specs should reach structural completeness before implementation, so that avoidable bugs are caught at spec time rather than during live-verify. This is the project's seed convention; grow it over time (via `/retro`) by adding more `## Self-Critique-Check` blocks below.

`spec-self-critique` point 8 iterates every `docs/conventions/*.md` file and runs the `## Self-Critique-Check` block it finds (format: **Trigger / Check / Korrektur**). A convention file without such a block is skipped with a warning — so this seed ships one valid block.

## Self-Critique-Check

**Trigger:** the spec states any concrete count, quantity, or "N of M" claim (number of callers, tests, rows, files, occurrences).

**Check:** is each such number empirically verified against the source (a `grep -c`, a query, a file listing) rather than estimated or recalled?

**Korrektur:** re-derive every concrete number from the source before finalizing the spec; replace estimates with the verified count, or mark the claim as an explicit assumption to confirm during implementation.
