<!-- language-census: ok -->
# Findings — truth census (#380)

Schema-valid records: **`findings.json`** (623 findings, validated by
`lib/validate-findings.mjs` before the file is written). This document reads
them; it does not restate them one by one.

Substrate read: **`16325e59f9c1815231f8e37c431881219fac9762`** (Analysis
substrate freeze, #404), whose own derivation reads source commit
`c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2`. Rubric: **r3, frozen at 16.2%
disagreement**.

## The counted picture

| | Count |
|---|---:|
| Rules extracted (the denominator) | **4 116** |
| Reviewed mechanically, every rule | 4 116 of 4 116 |
| Reviewed by reading (stratified sample) | 687 of 4 116 |
| `no-finding` | **3 493** |
| Findings emitted | **623** |
| — `hypothesis` | 507 |
| — `unknown` | 110 |
| — `keep` (promoted) | **6** |
| — `cut` | **0** |

**Zero cuts, and that is the designed outcome.** A CUT is promoted by `ablation`
alone. This round ran no ablation, so `lib/validate-findings.mjs` would have
rejected any cut it was handed — the absence is mechanical, not a matter of
restraint. `hypothesis` + `unknown` = 617 of 623 findings, which is #380's own
prediction for round one, arrived at rather than assumed.

### By partition and column — findings never cross the partition

| Partition | Rules | Findings | truth | form | ownership |
|---|---:|---:|---:|---:|---:|
| shipped surface | 2 627 | 423 | 142 | 89 | 192 |
| Kit Core | 946 | 124 | 112 | 4 | 8 |
| maintainer-only | 354 | 37 | 25 | 2 | 10 |
| consumer-owned project extension | 113 | 25 | 9 | 7 | 9 |
| residual | 76 | 14 | 8 | 1 | 5 |

The shape is worth naming: **Kit Core's findings are 90% `truth`**, the shipped
surface's are 45% `ownership`. Code is where a predicate can be the wrong
predicate; prose is where a decision gets made on the project's behalf. Nobody
designed that split — it falls out of the columns.

## The six promoted findings

All six are `keep`: the mechanism is load-bearing and stays, and the defect
named in `claim` is the finding. Nothing here says "delete this".

### 1 · `.env*` teardown compares bytes for a decision about work — reproduction

`scripts/worktree-lifecycle/classify.py:253-262`. The decision is "is this file
work or scratch"; the proxy is "is it byte-identical to the main checkout". A
worktree that correctly carries its own port is byte-different — so a **correct**
per-worktree setup trips the block every time. `CONTEXT.md:206-213` bakes the
comparison into the glossary definition of *Scratch*, so it is not a local
implementation detail.

Fixture, 3 repetitions, byte-identical output: identical `.env` produces no
block; `PORT=3101` produces `".env — differs from the main checkout copy"`.

### 2 · Authorization decided by substring — reproduction

`scripts/worktree-lifecycle/core.py:487-493`. `targets_linked_worktree` asks
whether the command *string contains* a linked-worktree path, and
`command_decision` treats that as authorization. The mandate carried this as a
hypothesis; both directions now have output behind them:

- `git push --force origin main` in the protected main checkout → **block**
- the same command with `# see .worktrees/380-truth-census` appended → **allow**
- `echo "/fixture/repo/.worktrees/380-truth-census" && git push --force …` → **allow**
- `cd /srv/other-checkout && git push --force origin main` → **block** (the
  legitimate outside-repo case cannot satisfy the predicate at all)

### 3 · The risky-command gate never fires on `git -C` — reproduction

Found by the same fixture, one step upstream of #2. The default
`riskyCommandPatterns` (`scripts/worktree-lifecycle/profile.py:111-114`) match
`\bgit\s+(?:commit|push)\b`, which `git -C /srv/other push --force` does not.
The most direct way to push from the protected main checkout at another
repository is **never classified risky at all**, so it never reaches the
authorization branch this whole mechanism is about. A fail-open with the sign
flipped: the guard is not bypassed, it is not consulted.

### 4 · `## Prod` is located by exact string equality — reproduction

`scripts/readiness.mjs:104-107`. `## Prod und Deployment` gives
`missing-section`; `## Prod:` gives `missing-section`; `## Deployment`,
genuinely absent, gives `missing-section`. Two different states — "you named it
differently" and "you have none" — collapse onto one code, and the collapse is
where the false "you have not configured this" is born. testreporter#2283 is
that failure in a live consumer; the fixture is the same failure with a command
behind it.

### 5 · "A file you didn't touch fast-forwards" is false whenever anything conflicts — reproduction

`README.md:407` and `CLAUDE.md:76` both promise per-file reconciliation. The
implementation is all-or-nothing: `src/commands/update.mjs:113` returns
`conflicted` and activates nothing as soon as **any** file conflicts. So in the
exact situation the sentence is written for — the consumer edited something —
no untouched file fast-forwards.

This is the counter-control catching the machinery it was pointed at. The
no-conflict arm is green over 3 repetitions, which isolates the claim to the
conflict path rather than smearing it across the reconcile. Whether the
transactional abort is the right behaviour is a design question this census does
not answer; the finding is that the documented promise and the shipped behaviour
disagree, and a consumer reading the README would predict the wrong outcome.

### 6 · The `**Retro:**` line: maximal binding, yield of 10 — repeated-incident

Recounted from the frozen export rather than repeated from the mandate:

| | Mandate claim | Recount at the freeze |
|---|---:|---:|
| merged pull requests | 128 | **135** |
| carrying the `**Retro:**` marker | 69 | **74** |
| carrying a findings heading | 8 | **14** (10 of them also carry the marker) |
| carrying a Meta section | — | **2** |
| marker value outside the enforced closed set | — | **10** |

64 independent occurrences of "marker enforced, nothing recorded", each an
individually citable pull request. The sensor stays — it is the only instrument
that currently reports whether planning was good. The **binding** is the finding:
a machine-checked closed value set, a blocking question and a forced second
`$wrapup` invocation, standing on a yield of 10.

The 10 off-closed-set values are *not* promoted: the check may post-date those
pull requests, and this round ran nothing that could tell the two apart
(`fixtures/hypothesis-set.md`).

## What the 110 `unknown` findings are

Rules where the mechanical reviewer and the reading reviewer named different
columns. The mandate calls `unknown` a first-class outcome, and this is the
honest use of it: the disagreement is recorded per rule with both readings,
rather than adjudicated in private to make the report look decided.

## Dependency graph — one edge class reviewed, one counted

| Edge class | Total | Reviewed | Result |
|---|---:|---|---|
| mirror (`.agents/` to `.claude/`) | 101 | **yes, in full** | 95 identical rule sets · 5 divergent · 1 with no primary (`codex-adapter-sync`, Codex-only by design) |
| import (caller to core) | 1 663 across 297 files | **no** | counted, named in `unexamined.md` |

Three of the five divergent mirrors were inspected: two are the documented
Claude-only rule working correctly (the Codex mirror routes to `/grill-me`
instead of `/grill-me-codex`, because a Codex-surface skill must never escalate
to a Claude-only target), one is a frontmatter quoting difference. **Two were
not inspected** and are named as such.

## Standing evidence, re-counted rather than inherited

#380 says its own standing-evidence items "enter as citations to be re-counted,
not as settled scars". Result:

| Item | Status after this pass |
|---|---|
| `.env*` byte proxy | reproduced, promoted `keep` |
| `targets_linked_worktree` substring | reproduced (was hypothesis), promoted `keep` |
| readiness `## Prod` exact match (testreporter#2283) | reproduced, promoted `keep` |
| retro yield 128/69/8 | re-counted 135/74/14 — the shape holds, the numbers moved |
| testreporter#2305 (symlink route-around) | stays hypothesis — one occurrence, private, no fixture here |
| testreporter#2312 (impact-census guard) | stays hypothesis — the guard does not exist in this repository |
| `codex-exec.sh` version pin | event verified; the *generalization* stays a hypothesis — cutting it needs an ablation |

Two of the seven were promoted from where the mandate left them, one moved its
numbers, and three stayed exactly where they were. That distribution is the
point of re-counting.
