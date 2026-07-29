<!-- language-census: ok -->
# Journey pass — cited-promise gaps (#380 §5)

Machine-readable: **`journey-gaps.json`**. Station tables are the frozen
substrate's (#404, `stations.json`); this pass reads them and never re-derives
them.

## Counted

| | Count |
|---|---:|
| Journeys examined | **70 of 70** |
| Stations examined | **237 of 237** |
| Stations carrying a cited promise | 237 of 237 |
| Gaps found | **109** |
| Stations with at least one gap | 102 of 237 |
| Journeys with at least one gap | 49 of 70 |
| Journeys carrying `unknown-recovery` | 34 of 70 |

**A gap counts only for a cited promise.** Every station row carries
`promise.text` plus `promise.citation`, and the pass resolves each citation
before it will hold anything to it: a repository path that exists on disk, or an
issue frozen in `docs/evidence/welle-31/issue-bodies.json`. "The journey implies
it" is not a citation, which is exactly why the refuted `wrapup` claim never
became a gap here.

## The four gap classes

| Class | Count | What it is |
|---|---:|---|
| **G1** narrowed verification | 30 | the station names, in its own verification column, the part of the promise it does not establish |
| **G2** prose binding under an enforcement promise | 8 | the promise asserts something blocks/refuses/must; the binding carrying it is documented or judgment |
| **G3** unresolvable citation | **0** | the promise cannot be read back |
| **G4** blocking station on an `unknown-recovery` journey | 71 | a station that can stop the journey sits where the route out is not a named record |

### G3 is zero, and the harness proves it can be non-zero

A negative measurement is no proof until the harness has produced a positive.
The citation resolver is controlled inline before the pass runs and the control
is recorded in the output (`citationResolverControl`):

```
positive               CLAUDE.md                          -> resolves
negativeMissingPath    docs/agents/does-not-exist.md      -> does not resolve
negativeUnfrozenIssue  #999999                            -> does not resolve
negativeProse          "board profile labels.waveStub"    -> does not resolve
```

The script exits non-zero if any of those four flip. So G3 = 0 means every one
of the 237 station promises can actually be read back — not that the resolver
was asleep. (The substrate reports 4 unresolvable citations across all 417 of
its citation fields; none of them is a station promise.)

### G1 — the honest ones

30 stations state their own limit, and the substrate wrote them that way:

- `idea-to-board-issue#capture` — "that an issue was opened, **not that the idea
  was worth tracking**" (cited: `CLAUDE.md`)
- `idea-to-board-issue#classify` — "that a Status value and a type label are
  set, **not that they are the right ones**"
- `inbound-triage-to-agent-ready#readiness-label` — "that a label was applied,
  **not that the issue is executable**"
- `inbound-triage-to-agent-ready#execute-ready` — "the required sections are
  present — **presence, not sufficiency**"

These are not deceptions; they are the difference between a promise's wording
and its mechanism, written down. They matter because the *journey* reads as
though the promise were kept: a slice carrying `ready-for-agent` reads as
executable, and the mechanism only ever established that a label exists. That is
the same gap the metric measures from the other end — M1's refutation rate is
**33.6%**.

### G2 — eight promises whose enforcement is prose

| Station | Promise (cited) | Binding |
|---|---|---|
| `land-planning-output#no-release-coupling` | "Landing an ADR must not require a release" (#343) | documented |
| `small-direct-path#red-green` | "Execute = red→green test-first, never test-after" (`CLAUDE.md`) | documented |
| `two-axis-code-review#side-by-side` | "The two axes are reported side by side, never merged or re-ranked" | documented |
| `run-the-local-gate#gate-rerun` | "A red gate is fixed and the gate re-runs; never bypassed with `--no-verify`" | documented |
| `consumer-setup-pre-commit#never-bypass` | "Never bypass with `--no-verify`" (`CLAUDE.md`) | documented |
| `guarded-tool-call-block#named-recovery` | "A block names its recovery rather than only refusing" | documented |
| `recovery-red-release-run-but-published#never-bump` | "Never recover by bumping the version" (`CLAUDE.md`) | documented |
| `recovery-update-conflicts-with-local-edits#consumer-decides` | "Conflicts are never auto-resolved" | documented |

Two of these deserve a second look from whoever shapes v1.0.0: "never bypassed
with `--no-verify`" is a prose rule about the one action that disables every
mechanical gate the repository has, and "a block names its recovery" is a prose
rule *about* form — a rule that would fail on itself if it were enforced.

### G4 — 71 blocking stations with no named recovery record

The largest class, and the softest. It counts a station that can stop the
journey (a human/platform gate, or a mechanical binding) sitting on a journey
whose recovery paths are `unknown-recovery` — the substrate's honest label for
"the searched record sources produced nothing". It is **not** a claim that no
recovery exists; it is a claim that no recovery is *recorded*, which is the only
thing the evidence can carry.

`pr-recorded-stop-and-rerun` remains declared and empty across the whole journey
set: 0 of 70 journeys have a recovery backed by a pull request recording a STOP
and a re-run. A class kept at zero rather than dropped is falsifiable later; a
class that disappears when it empties is not.

## `unknown-recovery`, explicitly

34 of 70 journeys carry it. The searched population is named in the evidence
export (`recovery-record-sources`, 64 rows: recovery-labelled issues, PRs
recording a STOP and re-run, retro findings, documented recovery paths).
Exhaustiveness cannot be proven, so the category stays in the report instead of
being resolved by invention.
