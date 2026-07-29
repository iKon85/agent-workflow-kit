<!-- language-census: ok -->
# Cost walk — Welle 31 / Slice 2 (#343)

What the implemented workflow **costs** to walk, counted over the frozen
Analysis substrate (#404). Sidecar artifacts only: nothing here ships, nothing
here is promoted, and no rule changed. **Cutting authority is Slice 3's.**

Substrate commit `c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2` · journey
denominator **70 of 70**, verbatim from the substrate (Amendment 1 — this walk
adds cost columns and re-derives nothing).

## Read in this order

| # | File | What it settles |
|---|---|---|
| 1 | [`ac-1-measurement-record.md`](./ac-1-measurement-record.md) | **AC 1** — the traversal query, its UTC window, the threshold, the gate basis and the output paths, committed **before** anything was classified |
| 2 | [`cost-table.md`](./cost-table.md) | the counted cost table — one row per journey, **70 of 70** |
| 3 | [`fable-pass.md`](./fable-pass.md) | primary pass 1 — findings F1–F8, the judgment pass over 28 of 70, cut candidates, named non-coverage |
| 4 | [`codex-pass/pass-note.md`](./codex-pass/pass-note.md) | primary pass 2 — model, effort, date, substrate commit, its own named non-coverage, and the delivery deviation |
| 5 | [`codex-pass/response.md`](./codex-pass/response.md) | pass 2 verbatim |
| 6 | [`two-model-merge.md`](./two-model-merge.md) | the merge — 6 agreements, 6 single-pass findings, **5 disagreements**, none resolved silently |

## Headline counts

| Quantity | Counted |
|---|---|
| journeys with a cost row | **70 of 70** |
| stations (steps) | 237 |
| gates that can refuse passage | 173 of 237 (73%) · pass 2's narrower basis: 62 |
| human gates · standing authorizations | 52 · 6 |
| journeys with a named recovery record | 37 of 70 |
| traversal population | 327 commits, 2026-07-03 → 2026-07-29 UTC |
| `covered-and-priced` / `unwatched` / `secured-out-of-proportion` / `unknown` | 29 / 10 / 8 / 23 |
| judgment pass | **28 of 70** (pass 1) · 12 of 70 (pass 2, a subset) |
| named non-coverage | **42 of 70**, listed individually |

## Reproduce

```sh
node docs/analysis/welle-31/cost-walk/derive-cost.mjs --check   # cost-rows.json, byte-equal
node docs/analysis/welle-31/cost-walk/classify.mjs   --check    # classification.json + cost-table.md, byte-equal
```

Both re-derive from the substrate and from repository history pinned to the
substrate's own freeze commit, so landing this analysis cannot move its own
denominator.

## Two things a Slice-3 reader should not miss

1. **`docs/agents/skills/orchestrate-wave.md:151-153` is wrong, and it ships.**
   It tells every consumer that `docs/adr/*` and `docs/research/*` are in the
   kit manifest and drag a release along. Counted: **0 of 356** manifest
   entries, **0 of 388** npm payload files, and no revision of the manifest ever
   contained one. Reported, not fixed — fixing it drags the release lockstep the
   finding is about. (`fable-pass.md` F6, `two-model-merge.md` §D1.)
2. **The bins are not authoritative.** The two passes disagree fundamentally on
   whether a traversal proxy is admissible at all (29/10/8/23 against 0/0/1/69).
   The finding both passes share is that **this kit has no journey-attributed
   traversal record**, so the classification the mandate asks for cannot be
   fully earned yet. (`two-model-merge.md` §D2.)
