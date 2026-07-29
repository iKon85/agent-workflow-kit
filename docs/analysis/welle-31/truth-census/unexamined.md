<!-- language-census: ok -->
# Unexamined — named, counted, not implied (#380 §8)

"Coverage is not reduced; only the order is staged, and **any artifact left
unexamined is named**." This is that list. Nothing below was skipped silently,
and every entry carries the number that makes it checkable.

## Artifacts: 633 of 633 accounted for

| | Count | Depth reached |
|---|---:|---|
| Tracked artifacts at the substrate freeze | **633** | — |
| Files a rule span was extracted from | 341 | rules extracted, every rule mechanically reviewed |
| Files whose text yielded no rule span | 218 | read by the extractor, produced no clause with a directive verb and no predicate-plus-action; recorded per file in `data/rules.json` → `perFile` |
| Files with no extractable rule surface | **74** | named individually in `data/rules.json` → `noRuleSurface` |

The 74, by kind: `.json` 54 · `.txt` 7 · no extension 7 · `.html` 3 · `.toml` 1
· `.svg` 1 · `.png` 1.

Two of the JSON files are not inert data and are named specifically:
`.claude/skills/skill-manifest.json` and `agent-workflow-kit.package.json` (the
generated shipped contract #380 §1 puts in scope). Their producer-to-consumer
parity is auditable and **was not audited here** — the mirror edge class was,
the manifest-to-bundle contract was not.

## Rules: 4 116 extracted, 687 read

| Depth | Count | Share |
|---|---:|---:|
| Mechanically reviewed (frozen rubric, every rule) | 4 116 | 100% |
| Read-reviewed (stratified sample, second reviewer) | 687 | 16.7% |
| **Not read-reviewed** | **3 429** | **83.3%** |

Per partition, rules **not** read-reviewed: shipped surface 2 232 of 2 627 ·
Kit Core 754 of 946 · maintainer-only 294 of 354 · consumer-owned 93 of 113 ·
residual 56 of 76.

This is the mandate's own design (§3: a stratified sample calibrates, the double
review measures completeness) and not a shortfall — but the mechanical pass and
a read pass are not the same depth, and 507 `hypothesis` findings carry
`confidence: low` precisely because most of them were never read by the second
reviewer.

## Extraction blind spots — what the denominator cannot see

Named because a denominator that hides its own blind spots is the fiction this
anchor hunts.

1. **A rule that decides silently is not in the population.** The code extractor
   anchors on an action — block, fail, warn, mutate, or a fail-open branch. A
   predicate that quietly returns `null`/`None` and lets a caller draw the wrong
   conclusion has no action to anchor on. **`scripts/readiness.mjs::section` is
   exactly that shape** — the promoted finding #4 had to be anchored on the
   prose promise that cites it, with the code location in `evidence[]`, because
   the rule itself is invisible to the extractor. Unknown how many more there
   are; this one was found by following the mandate's standing evidence, not by
   the census machinery.
2. **Prose rules are clause-level, so a rule spread over two sentences counts
   as two, or as none.** Compound splitting is mechanical (`lib/extract-rules.mjs`
   → `splitCompound`) and versioned with the population.
3. **Fenced code, headings and HTML comments are excluded from prose**
   (§3: "headings, examples and rationale are not rules"). A rule that exists
   only inside a fenced example is not counted.
4. **`if __name__ == "__main__"` and `import.meta.url` entry-point boilerplate
   were excluded** after the first extraction showed them as rules — they select
   how a file was started, not whether an action is permitted. 85 spans left the
   population that way (4 201 → 4 116), and the exclusion is in the script.
5. **Directive detection strips inline code and paths first**, because
   `` `enforce-worktree-cwd.py` `` matched the verb "enforce" and produced three
   file names as rules in the first run.

## Edges: 1 663 counted, 101 reviewed

| Edge class | Total | Reviewed |
|---|---:|---|
| mirror (`.agents/` to `.claude/`) | 101 | **101 — in full** |
| import (caller to core) | **1 663** across 297 files | **0** |

§4 wants each caller→core contract reviewed **per caller**: what the caller
assumes about inputs, outputs, failure mode and fail-open behaviour, and whether
the core delivers it. That is 1 663 readings and this round ran none of them.
It is the single largest unexamined surface in this census, and the one most
likely to hold the next finding of the shape #3 has (a guard that is never
consulted rather than bypassed).

Also unexamined inside the reviewed class: **2 of the 5 divergent mirrors**
(3 were inspected and explained).

## Ablations: 0 of 0 run

No `ablation` promotion exists, therefore **no CUT exists**. §7's protocol
(fixtures only, destructive journeys never live, positive control first, ≥3
repetitions, a directional vector over correctness/safety/recovery/friction,
cross-surface evidence before generalizing) is implemented as a *validator*
(`lib/validate-findings.mjs` → `validatePromotion`) and never as a run. The
507 `hypothesis` findings are where an ablation would point next; the four
`ownership` clusters in the shipped surface are the densest target.

## Metric: claims that exist and are not counted

| | Count |
|---|---:|
| Eligible claims counted | 209 |
| M3 claims dropped — landing PR closed several issues, so blast radius is not attributable at slice resolution | **114** |
| Meanings with no carrier at all today (toppled sibling assumption, `ANNAHMEN.md`) | unquantified — this is what the unobserved-claim bound is for |

## Not in scope, so nobody substitutes it

Per the mandate: performance; product behaviour unrelated to a claim a mechanism
makes; #343's journey-cost walk; the safety floor as a *design* question;
building a friction sensor; delivered software quality — **measured by no
control here and claimed by none**.
