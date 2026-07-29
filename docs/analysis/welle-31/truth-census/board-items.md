<!-- language-census: ok -->
# Board items to file — prepared, not filed

#380's last acceptance criterion asks that mechanical `file:line` findings be
filed as board items. **This session's `gh` access is read-only by its own
contract**, so nothing was written to the board. The deviation is named here
rather than quietly dropped, and every item below is ready to file verbatim
through `scripts/board-sync.py` (never bare `gh issue create`).

Each carries `Part of #403`. Each is a `keep` finding: the mechanism stays, the
defect is the work.

## 1 · Teardown blocks every correctly configured worktree

`scripts/worktree-lifecycle/classify.py:253-262` byte-compares each `.env*`
against the main checkout, so a worktree that correctly carries its own port is
blocked at teardown. `CONTEXT.md:206-213` carries the same proxy in the glossary
definition of *Scratch*, so a fix has to move both.
Reproduction: `python3 docs/analysis/welle-31/truth-census/fixtures/probe-env-proxy.py`

## 2 · Worktree authorization is decided by substring

`scripts/worktree-lifecycle/core.py:487-493` — a risky command that merely
*mentions* a linked-worktree path is authorized; a command that legitimately
operates outside the repository cannot satisfy the predicate at all.
Reproduction: `python3 docs/analysis/welle-31/truth-census/fixtures/probe-command-substring.py`

## 3 · The risky-command gate is never consulted for `git -C`

`scripts/worktree-lifecycle/profile.py:111-114` — the default patterns match
`git push`, not `git -C <path> push`. The most direct way to push from the
protected main checkout at another repository is not classified risky at all.
Same reproduction as #2, arm `risky-regex-evaded`.

## 4 · `## Prod` is matched by exact string equality

`scripts/readiness.mjs:104-107` — `## Prod und Deployment` and a genuinely
absent section report the same `missing-section`. This is testreporter#2283 with
a command behind it.
Reproduction: `node docs/analysis/welle-31/truth-census/fixtures/probe-prod-heading.mjs`

## 5 · The fast-forward promise does not hold when anything conflicts

`README.md:407` and `CLAUDE.md:76` promise that an untouched file fast-forwards;
`src/commands/update.mjs:113` returns `conflicted` and activates nothing as soon
as any file conflicts. Either the behaviour or the sentence is wrong, and a
consumer reading the README predicts the wrong outcome today.
Reproduction: `node docs/analysis/welle-31/truth-census/lib/run-counter-control.mjs`

## 6 · The `**Retro:**` binding stands on a yield of 10

135 merged pull requests · 74 carrying the enforced marker · 10 of those
carrying an actual findings section · 10 carrying a value outside the enforced
closed set. The sensor stays; the binding (closed value set + blocking question
+ forced second `$wrapup` invocation) is what to re-cut.
Evidence: `docs/analysis/welle-31/truth-census/data/retro-yield.json`

## 7 · A rule that decides silently is invisible to the census

Meta, and the reason #4 had to be anchored on prose: the rule extractor anchors
on an action (block / fail / warn / mutate / fail-open). A predicate that
quietly returns `null` and lets its caller draw the wrong conclusion has no
action to anchor on. Worth a bounded follow-up: extend the extractor, or accept
the blind spot explicitly.
Evidence: `docs/analysis/welle-31/truth-census/unexamined.md` §Extraction blind spots
