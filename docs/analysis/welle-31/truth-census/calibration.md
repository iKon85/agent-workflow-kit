<!-- language-census: ok -->
# Calibration record — truth census (#380 §3)

**Result: rubric frozen at r3, pooled disagreement 16.2% (111 of 687), under the
≤20% threshold.** Adjudicator: **Niko** (recorded 2026-07-28, #403).
Machine-readable: `data/calibration.json`.

## The sample

`max(ceil(0.15·N), min(20,N))` per partition × artifact kind, a stratum under 20
rules reviewed in full, drawn by stable rule-ID hash — never randomly, so the
same rule population re-draws the same sample (`lib/sample.mjs`).

| Stratum | Population | Sampled | r3 disagreement |
|---|---:|---:|---:|
| shipped-surface / skill | 2 627 | 395 | 14.2% |
| kit-core / script | 704 | 106 | 8.5% |
| maintainer-only / other | 347 | 53 | **24.5%** |
| kit-core / source | 166 | 25 | 20.0% |
| consumer-owned / other | 113 | 20 | **40.0%** |
| residual / other | 76 | 20 | 15.0% |
| kit-core / doc | 28 | 20 | **45.0%** |
| kit-core / template | 27 | 20 | **30.0%** |
| kit-core / hook | 20 | 20 (full) | 5.0% |
| maintainer-only / script | 7 | 7 (full) | 14.3% |
| kit-core / other | 1 | 1 (full) | 0% |
| **Total** | **4 116** | **687** | **16.2%** |

**The threshold was met pooled, and four strata miss it individually.** The
mandate states one number and this pass reports the one number — but a finding
drawn from `consumer-owned/other`, `kit-core/doc`, `kit-core/template` or
`maintainer-only/other` is capped at `confidence: low` in `findings.json`
instead of inheriting the pooled reassurance. Where the two reviewers actually
disagreed, the finding is `unknown`, never adjudicated silently.

## The two reviewers

| | Reviewer A | Reviewer B |
|---|---|---|
| Instrument | `lib/reviewer-mechanical.mjs` — the rubric's signal table applied literally | reading each span against the rubric's column definitions |
| Determinism | fully deterministic, re-runnable | one recorded pass, frozen in `data/reviewer-b.json` |
| Sees the other? | no | no — B's 687 labels were recorded before any reviewer-A output was read |
| Scope | all 4 116 rules | the 687-rule sample |

**Independence — the limitation, named.** #380 asks for a double review. This
surface has one model in one context, so the two reviewers are two *instruments*
rather than two independent agents: the same model authored the signal table and
produced the reading labels. The procedural separation that was actually
achieved: the mechanical reviewer was written and executed to a file first, its
distribution deliberately **not** printed (`lib/reviewer-mechanical.mjs` prints
only a count for exactly this reason), and the 687 reading labels were produced
from a listing that carried the span, the path and the carrier — nothing else.
What that does **not** remove is the shared prior. Read the 16.2% as an upper
bound on agreement between one model's mechanical rule and its own reading, not
as inter-rater agreement between two reviewers. This is recorded rather than
dressed up, per the contract's own instruction: do not fake independence.

## The rounds

| Round | Disagreement | Verdict |
|---|---:|---|
| r1 | 178 / 687 = **25.9%** | over threshold — rubric revised |
| r2 | 415 / 687 = **60.4%** | **rejected** — the revision made it worse |
| r3 | 111 / 687 = **16.2%** | **frozen** — full pass started |

### r1 → r2, and why r2 was thrown away

r2 widened `form`: any imperative clause that named no mechanism, any span that
blocks without restating its recovery, any reader mismatch, plus an
unaided-arrival ownership signal. The result:

```
A:form vs B:none  249
A:truth vs B:none  76
A:form vs B:ownership 22
```

One signal (F3, "blocks and names no recovery") produced 249 of the 415
disagreements on its own. Nearly every guard in this repository blocks without
restating its recovery *inside the extracted span* — the recovery lives one
paragraph away. A signal that fires on almost every rule does not discriminate,
and a rubric built on it would have reported "the kit is one giant form
finding". That is the anchor's own thesis turned on the instrument, so r2 is
recorded here instead of being quietly deleted.

### r2 → r3

r3 keeps every column definition unchanged and narrows the signals to the
distinguishing property:

- a comparison is a `truth` signal only when the compared value **stands in for
  something else** — a path, a command, a branch, a heading, an estimate — and
  not when it validates its own shape (`typeof`, `isinstance`, `Array.isArray`,
  "must be a…", "is required", "unknown …");
- `form` fires on an unfalsifiable qualifier or a closed-set copy-verbatim
  marker, not on imperative mood;
- the code-convention ownership signal was dropped: across 687 sampled rules the
  reading reviewer never once called an enforced code convention an ownership
  finding.

Because **no column definition changed**, reviewer B's labels were not re-run —
#380 §3's "any later change re-runs the affected column" was satisfied by there
being no affected column. Had a definition changed, the affected column would
have had to be re-read.

## Where the residual 16.2% sits

| Confusion | Count | Reading |
|---|---:|---|
| A `truth` vs B `none` | 39 | the mechanical reviewer still calls a literal comparison a proxy where the reading reviewer sees the comparison as the question itself |
| A `ownership` vs B `none` | 26 | dominated by one repeated shipped clause ("Project extensions may specialize Project details, but cannot weaken Core user gates…") which A reads as a decision-ownership rule and B read as description |
| A `none` vs B `ownership` | 16 | prescriptive prose whose phrasing the signal list does not carry (`type:cluster` always, "Correct umlauts … never ae/oe/ue") |
| A `none` vs B `form` | 10 | unfalsifiable imperatives phrased without any of the listed qualifiers |
| A `none` vs B `truth` | 7 | prose descriptions of a proxy mechanism (".env files are a mechanical hard block") that name no literal trigger |
| A `form` vs B `none` | 6 | the vagueness list catching a word used non-vaguely ("a verdict without inline evidence is just an unverified claim") |
| A `truth` vs B `ownership` | 4 | the version pin and the wave-anchor checklist — genuinely both, and precedence sends them to `truth` |
| other | 3 | |

Every one of these 111 rules is recorded in `findings.json` with verdict
`unknown` — the first-class outcome the mandate expects, not a tie broken in
private.
