<!-- setup-workflow: state=filled -->
<!-- agent-workflow-kit: project-extension/v1; skill=orchestrate-wave -->
# Project layer — orchestrate-wave

Filled 2026-07-27 after Welle 18 (#289) ran the whole loop end-to-end — recon,
build, integrate, verify, land, tag, publish — and proved the recipe below. The
sections were deliberately empty until then; the generic fallback carried that
run and cost it a `degraded` start plus a hand-derivation of every command here.

This repo has **no database, no dev server, no typecheck step and no browser
surface**, so several generic phases collapse to very little. Where that is the
case the section says so rather than inventing a command.

## §Setup

Nothing to start. No DB, no tunnel, no service, no dev server — Phase 0's
"start what live-verify needs" is a no-op here.

Two things that are *not* no-ops:

- `git config core.hooksPath .githooks` once per clone (worktrees inherit it).
- `npm install` in the wave worktree after fast-forwarding to `origin/main` —
  the lockfile is untracked, so dependencies do not travel with the branch.

## §Builder Commands

Per-slice gate, run by the implementer before reporting back:

```sh
npm test                  # test:node (node --test) + test:python (unittest)
```

The fast pre-commit lints run automatically via `.githooks/pre-commit`
(~3 s, skill/manifest lints). A slice is not "green" on the fast lints alone.

## §Builder Hard Rules

- **Never `--no-verify`.** pre-commit and pre-push are the backstop, not an
  obstacle.
- **English-first prose** in every published skill; the language census in the
  maintainer suite enforces it.
- **No hardcoded board values** — labels, headings, field IDs and status names
  come from `docs/agents/board-sync.md`; the portability lint blocks literals.
- **Dual-surface mirror in the same PR.** A changed `.claude/skills/<s>/SKILL.md`
  needs its `.agents/skills/<s>/SKILL.md` mirror via `codex-adapter-sync` in the
  same PR, never after merge.
- **Shipped-file changes must preserve the manifest/reconcile contract.**

## §Integration Suites

Both frameworks, every time — `npm test` runs both and a red in either is a red:

```sh
npm test
```

- `test:node` — `node --test` (665 tests as of 0.42.0)
- `test:python` — `python3 -m unittest discover -s scripts -p 'test_*.py'`
  (522 tests as of 0.42.0)

There is no typecheck step in this repo; do not look for one. Several
negative-path tests print `[FAIL] …` lines **by design** — only the runner's own
summary and exit code decide red or green.

## §Verify Recipe

Central verify is the `/local-ci` full gate, run from the wave worktree root.
It mirrors the CI `test` job step for step:

```sh
git fetch origin main
npm test
npm run kit:staleness
npm run release:guard -- --base "$(git merge-base origin/main HEAD)"
npm pack --dry-run
```

- **No branch-name-derived guard exists here**, so the generic skill's warning
  about an integrated verify branch blocking with no baseline does not apply.
  No skip or override is needed.
- **No browser, no headless login, no screenshots, no console check, no DB
  compare, no design/brand check.** This repo ships text; "assert the AC as a
  user-visible outcome" means reading the artefact the slice produced (an ADR,
  a skill body, a script's output) and the tests that pin it.
- **`release:guard` red with "shipped delta has no version bump" is not a
  failure of the wave** — it means the wave touched the shipped consumer set and
  the release metadata is missing. See §Landing.
- **A ticked criterion names what counted it.** The Core skill forbids ticking on
  a builder's word; here, say which of the two remaining sources did the counting
  — *you* ran a command and read its output, or a named test assertion carries it
  (`test/<file>.test.mjs:<line>`). Report both kinds separately. Ticking a whole
  checklist and then verifying one item rigorously reads, to every later reader
  including you, as though all of them had been verified. Wave 30 did exactly
  that with 23 criteria across three slices before the maintainer caught it.
- **A flaky red is possible.** `scripts/codex-exec.test.mjs` contains
  timing-sensitive tests that fail under CPU contention (#345). Re-run the single
  test in isolation before treating it as a real red; a test that is green in
  isolation and red under load is contention, not the wave.

## §Headless Login

Not applicable. No application, no browser surface, no authenticated session.
Never invent a login recipe for this repo.

## §Landing

**One PR for the whole wave**, base `main`. `main` is protected by the
`main protection` ruleset: a PR is required, the CI job **`test`** (job name, not
the workflow name `CI`) must be green with the branch up to date, and there are
no bypass actors — `gh pr merge --admin` does not help.

- `Closes #<n>` on its own line per leaf; `Part of #<anchor>` for the anchor,
  never `closes`.
- Body via temp file + `--body-file`, and **run `gh` from the repo** (it resolves
  the target repo from the cwd).
- **Security-flavored removal slices** (deleting guards/hooks/auth checks) are
  not delegable: the safety classifier blocks a sub-agent instructed to remove
  protection code even with a fixed list (3 blocks, 2026-07-30). Make the
  per-item verdicts in the main session with named evidence, have the
  maintainer approve the exact list, then execute in the main thread.
- **CI-watch hygiene:** `gh pr checks --watch` right after PR create exits 0
  with "no checks reported" — wait until a run is registered (until-loop),
  then watch. Start background watches from the main checkout: a watch whose
  cwd is a worktree that gets torn down dies with a phantom failure.

**Anchor reconcile, on PR create and on merge:**

```sh
python3 scripts/board-sync.py anchor-sync <anchor#> --dry-run   # review first
python3 scripts/board-sync.py anchor-sync <anchor#>
```

`anchor-sync` only works on a **promoted** anchor whose body carries a slice
table between `<!-- slice-table:start -->` and `<!-- slice-table:end -->`. A
stub-shaped anchor (a bullet list of slices, `wave-stub` label) makes it a no-op
that exits 1 with "no slice table found — nothing to sync". That is a promotion
gap, not a sync failure: install the table with the columns
`| # | Status | Slice | Sub-Issue | Gate | closes/refs |`, drop the `wave-stub`
label, then re-run. Do not hand-maintain the Status cells afterwards — they are
regenerated from the board.

**Completion, after merge:**

```sh
python3 scripts/board-sync.py add --issue <anchor#> --status-role done
gh issue close <anchor#> --reason completed --comment "…"
python3 scripts/board-sync.py item-of --issue <anchor#>   # re-read: status must be Done
python3 scripts/board-sync.py parent-of <anchor#>         # Program-PRD?
python3 scripts/board-sync.py program-sync <prd#>         # after the anchor is Done
```

Closing the issue does **not** move the board field — set the field, then re-read
both.

**New issues** go through `python3 scripts/board-sync.py create --title … --body-file …`,
never a bare `gh issue create`.

### Release lockstep

There is no deploy and no migration, but there **is** a publication gate, and a
wave that touches the shipped consumer set — meaning a path the kit manifest
lists — drags it along. The manifest is the whole test: `docs/adr/*`,
`docs/research/*` and `docs/analysis/*` are **not** in it (0 of the manifest's
entries; re-derive from `agent-workflow-kit.package.json`), so a wave that only
lands those takes the content route and needs no bump, no tag and no publish.

1. `npm run release:prepare -- --base origin/main` reports the delta and a
   `recommendedBump` without writing anything.
2. **The confirmed Semver is the one human gate.** Ask, unless an explicit
   end-to-end mandate covers release preparation. That confirmed version then
   authorizes metadata, merge, tag *and* publish — do not ask again after merge.
3. `npm run release:prepare -- --version <x.y.z>`, commit the bump.
4. Merge the PR. Merging **integrates only**; it cannot publish.
5. Verify on canonical `main`: tip == merge commit, `package.json` version
   matches, no existing tag. Then `git tag -a v<x.y.z> <main-tip> -m "…"` and
   push. The annotated tag on the `main` tip is the sole publication intent.
6. **A red release run does not prove nothing was published.** Read
   `npm view @ikon85/agent-workflow-kit version` and `gh release view v<x.y.z>`
   directly, plus `npm run release:status` (cache-bypassing), before reacting.
7. **Recovery is `gh workflow run release.yml -f tag=v<x.y.z>` on the existing
   tag** — the reconciler is idempotent. **Never recover by bumping the version.**

The release workflow runs the full suite *after* the tag is pushed, so a flaky
test strands an already-published tag. That is the recovery path above, not a
reason to re-tag.
