<!-- language-census: ok -->
# Review rubric — truth census (#380 §3)

**Status: frozen at r3.** Pooled disagreement between the two reviewers is
**16.2% (111 of 687 sampled rules)**, under the mandate's ≤20% threshold, so the
rubric froze and the full pass started. Numbers and per-stratum detail:
`calibration.md`, `data/calibration.json`. A later change to a **column
definition** re-runs that column; r1 → r2 → r3 changed only the signal table,
so reviewer B's reading was not re-run.

The rubric decides two things and nothing else:

1. **which column** a rule belongs to — `ownership`, `truth`, `form`, `none`;
2. **whether there is something to report** — `finding` or `no-finding`.

Verdicts (`cut` / `keep` / `hypothesis` / `unknown`) are **not** a reviewer
decision. They are assigned afterwards, mechanically, by the promotion rule.

## Columns (#380 §2)

### `ownership` — whose decision does this rule make

- **Decision ownership** — the rule fixes a tool, a format, an order or a value
  that outlives the change it is written for.
- **Unaided arrival** — the rule states what a competent agent does anyway.
  A CUT *hypothesis* only; promoting it needs an ablation (§7).

### `truth` — does it measure what it means, at what resolution

- **Wrong axis** — the predicate that fires is not the thing the rule is about:
  a string comparison standing in for a semantic property, a byte comparison
  standing in for "is this safe to delete", a path substring standing in for
  "is this authorized". Nobody keeps proxy and meaning aligned, so they drift.
- **Too many bits** — the measurement is finer than the decision it feeds; the
  collapse back to the decision is where the false positive is born.
- **False negative / fail-open** — the branch that lets the unsafe case through.

A rule may be perfectly sound and still land here: implementation behaviour at
a declared safety boundary is in scope (#380 §2).

### `form` — binding hardness, proportionality, reader, aftermath

- **Hardness** — hook blocks / script fails / prose persuades.
- **Proportionality** — is the hardness proportionate to how certainly we know
  the thing? A `must` on a hypothesis is disproportionate; so is a warning on a
  known-unsafe state.
- **Reader** — written for the human who looks in, or the agent that executes?
- **Aftermath** — after it fires, is recovery named, reachable, work-preserving?

### `none`

Reviewed; well-owned, measures what it means, form fits. `no-finding` is the
expected label for most rules, and it is: **3 493 of 4 116**.

## Precedence

`truth` > `form` > `ownership` > `none`. The reviewer records the most severe
applicable column, not every applicable one.

## Mechanical signal table (r3 — frozen)

Reviewer A applies this table literally (`lib/reviewer-mechanical.mjs`);
reviewer B applies the column definitions above by reading. The table is the
falsifiable half of the rubric.

| # | Signal | Column |
|---|---|---|
| T1 | code compares against a **string or boolean literal** — and is not a shape/type check, and its message is not a shape complaint | `truth` |
| T2 | code decides by substring / prefix / glob / `not in` containment **on a path, command, branch, cwd, url or heading** | `truth` |
| T3 | the extracted action is `fail-open`, or the span itself says fail-open / "fail closed only when" / "counts as ignored" | `truth` |
| T4 | bytes compared as a proxy for a decision about work (`same_bytes`, byte-identical, byte-for-byte) | `truth` |
| T5 | prose asserts a mechanism *verifies / ensures / guarantees / proves* an outcome | `truth` |
| T6 | prose triggers on an exact literal — an inline `## Heading`, byte-for-byte, verbatim, "exactly one of", "exact match" | `truth` |
| T7 | a threshold comparison decides: a `*_LIMIT`/`*_MAX`/number in code, or `≥ N files` / `> 2× the estimate` in prose | `truth` |
| T8 | the predicate is a type or errno check while the message reports an authorization or safety failure — the wrong cause is reported | `truth` |
| T9 | a regex literal validates an external versioned format (version, semver, tag, branch, marker) | `truth` |
| F1 | prose carries an imperative **and** an unfalsifiable qualifier (blindly, organically, radically, concise, fake, invent, leftover, guess, skip …) | `form` |
| F2 | the code action is `warn` while the rule's own wording is imperative | `form` |
| F5 | prose requires a **closed-set / copy-verbatim / mandatory** marker in a human-written artifact | `form` |
| O1 | prose prescribes a tool, format, order or vocabulary that binds beyond the change (`always via`, `only through`, `never use/substitute/expose`, `instead of`, `rather than`, `prefer`) | `ownership` |
| N | none of the above | `none` |

### What each revision changed, and why

| Revision | Disagreement | Change |
|---|---|---|
| r1 | **25.9%** (178/687) | first table: equality, containment, fail-open, verify-claim, warn-imperative, prescriptive prose, code conventions |
| r2 | **60.4%** (415/687) — **rejected** | widened `form`: any imperative without a named mechanism (F1), any block without a named recovery (F3), reader mismatch (F4), unaided-arrival prose (O3). F3 alone produced 249 disagreements: nearly every guard in the repository blocks without restating its recovery inside the extracted span |
| r3 | **16.2%** (111/687) — **frozen** | narrowed to the distinguishing property. A comparison is a truth signal when the compared value **stands in for something else** (path, command, heading, estimate), not when it validates its own shape; the `form` signals fire only on an unfalsifiable qualifier or a closed-set marker; the code-convention ownership signal (O2) was dropped entirely — the read reviewer never once called an enforced code convention an ownership finding |

The lesson r2 teaches is the anchor's own thesis pointed back at the instrument:
a signal that fires on everything measures nothing. It is recorded here rather
than quietly dropped, because a rubric that only ever shows its winning revision
is the same fiction as a guard that only ever shows its greens.

## Worked examples — verified items only

Per #380 §3, worked examples are drawn only from items verified in this pass.
Unverified ones live in `fixtures/hypothesis-set.md` and calibrate nobody.

### `truth`, positive — `.env*` teardown proxy ✓ verified 2026-07-29

`scripts/worktree-lifecycle/classify.py:253-262` compares each `.env*` byte for
byte against the main checkout, and a difference blocks teardown. The decision
is "is this file work or scratch"; the proxy is "is it identical to main". A
worktree that correctly carries its own port is byte-different and trips the
block on every correct setup.

```sh
python3 docs/analysis/welle-31/truth-census/fixtures/probe-env-proxy.py
# identical -> not blocked; per-port (PORT=3101) -> blocked,
# ".env — differs from the main checkout copy"
```

### `truth`, positive — authorization by substring ✓ verified 2026-07-29

`scripts/worktree-lifecycle/core.py:487-493` asks whether the *command string
contains* a linked-worktree path and treats that as authorization.

```sh
python3 docs/analysis/welle-31/truth-census/fixtures/probe-command-substring.py
# `git push --force origin main`                              -> block
# same command + "# see .worktrees/380-truth-census"          -> allow
# `cd /srv/other-checkout && git push --force origin main`    -> block
```

### `truth`, positive — exact heading equality ✓ verified 2026-07-29

`scripts/readiness.mjs:104-107` matches `line.trim() === '## Prod'`.
`## Prod und Deployment` reports `missing-section` — the same code a genuinely
absent section reports.

```sh
node docs/analysis/welle-31/truth-census/fixtures/probe-prod-heading.mjs
```

### `truth`, negative — the manifest digest check ✓ verified 2026-07-29

`init` records a sha256 per installed file; `update` compares the destination's
current digest against it. Here the digest **is** the question ("did anyone
change this file"), not a proxy for it. The counter-control holds it green over
3 repetitions (C2, C3, C4) and the positive control shows the same harness going
red the moment the comparison is removed. Reviewed as `none`.

### `form`, positive — the `**Retro:**` closed-set line ✓ verified 2026-07-29

Machine-checked closed value set, blocking question, forced second `$wrapup`
invocation. Recounted from the frozen export: **135 merged pull requests, 74
carrying the marker, 14 carrying any findings heading, 10 of the marker-carrying
ones, 2 carrying a Meta section** (`data/retro-yield.json`). The mechanism
measures exactly what it says — the *binding* is out of proportion to the yield.

### `form`, negative — a block that names its route out ✓ verified

`wrapup-land.py` raises `Stop("0c merge-gate", "PR is CONFLICTING — rebase/
resolve the branch")`: the refusal and the recovery are in the same span.
Reviewed as `none`.

### `ownership`, positive — the over-precise version pin ✓ verified

`docs/evidence/2026-07-28-codex-exec-version-pin.md`: `codex-exec.sh` refused
with `UNTESTED_VERSION` against a two-entry allow-list while the real cause was
a duplicate `--json` in our own invocation. The rule decided, for the whole
project and beyond the change, which versions may exist.

## Verdict assignment (mechanical, not a reviewer decision)

| Verdict | Assigned when |
|---|---|
| `no-finding` | reviewer column is `none` (both reviewers, where both reviewed) |
| `cut` | an `ablation` promotion object exists — nothing else promotes a cut |
| `keep` | a `reproduction`, `repeated-incident` or `structural-invariant` promotion object exists |
| `unknown` | the two reviewers name different columns — unsettled, recorded, not adjudicated silently |
| `hypothesis` | a finding read statically, with no promotion object |

`cut` and `keep` are **schema-invalid without a well-formed `promotion` object**
and are rejected by `lib/validate-findings.mjs` before `findings.json` is
written. The validator's own negative control is in `README.md` §Reproduction.
