<!-- language-census: ok -->
# Hypothesis fixture set — items that calibrate nobody

#380 §3: worked examples in the rubric are drawn **only from verified items**;
unverified ones "live in a labelled hypothesis fixture set and never calibrate a
reviewer". This is that set. Nothing here was used as a rubric example, and
nothing here carries a promotion object.

Each item is 🔬 **hypothesis** until a fixture, a second independent occurrence,
or a structural argument moves it. None of them moved in this round.

## 🔬 The `wrapup` residual

#380's own review refuted a `wrapup` gap that had been asserted from a single
grep pattern which never contained the word being searched for. What survives is
the *shape* of the claim — `wrapup` is 213 lines carrying several routes, with
release-to-merge conflated with cleanup — and that shape is a size observation,
not a defect. Parked as a v1.0.0 seed by the mandate; not counted as a finding.

## 🔬 testreporter#2305 — the safeguard that was routed around

Cleanup can freeze identity only for regular files; a pnpm worktree holds ~3 213
symlinks, so teardown ran through `git worktree remove --force` instead. One
occurrence, in a private repository, exported digest-only
(`docs/evidence/welle-31/issue-bodies.json`). `repeated-incident` needs ≥2
independent occurrences and this is one; no fixture reproduces it here, because
reproducing it needs a pnpm worktree this repository does not have. Stays a
hypothesis, and the honest form of the claim is: *a fallback route with no
protection exists*, not *the safeguard is worthless*.

## 🔬 testreporter#2312 — the impact-census guard and coordinator branches

The guard cannot distinguish a coordinator branch from an uncensused one, so a
wave landing needs `IMPACT_CENSUS_SKIP=1` twice. One occurrence, private
repository, digest-only. The guard does not exist in this repository, so nothing
here can reproduce it.

## 🔬 The `codex-exec.sh` version pin

`docs/evidence/2026-07-28-codex-exec-version-pin.md` — an exact two-entry
`UNTESTED_VERSION` allow-list blocked a cross-model review while the real cause
was a duplicate `--json` in our own invocation. This one **is** verified as an
event (the evidence file is committed, pre-fix) and it is used as the rubric's
`ownership` worked example. What stays a hypothesis is the *generalization*:
that the pin is unnecessary rather than merely over-precise. That needs an
ablation — run the same journey with the pin removed against a fixture, with a
positive control on a version that genuinely breaks — and this round ran none.

## 🔬 The 10 off-closed-set `**Retro:**` values

`data/retro-yield.json` counts 10 merged pull requests whose `**Retro:**` line
carries a value outside the enforced closed set. Two explanations fit equally
well: the check post-dates those pull requests, or it can be bypassed. Telling
them apart needs the check's introduction date against each merge date — a
cheap query this round did not run. Recorded, not promoted.

## 🔬 Every static reading in `findings.json`

507 findings carry verdict `hypothesis`: a column assigned by reading a span
against a frozen rubric, with no fixture behind it. They are the largest bucket
by design (#380: "`unknown` … expected to be the largest bucket in round one" —
here `hypothesis` and `unknown` together are 617 of 623). A hypothesis is a
place to point an ablation, never a reason to cut.
