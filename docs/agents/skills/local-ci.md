<!-- setup-workflow: state=filled -->
<!-- agent-workflow-kit: project-extension/v1; skill=local-ci -->
# Project layer — local-ci

This repo is a Node + stdlib-Python repo with no database, no dev server and no
typecheck step, so the two generic profiles map onto a short command set. Run the
two commands below; do not infer others.

Prerequisite once per clone (worktrees inherit it):

```sh
git config core.hooksPath .githooks
```

## Fast static guards

The skill/manifest lints, ~3s, no network, no DB. This is exactly what
`.githooks/pre-commit` runs, so a normal commit already covers it:

```sh
python3 -m unittest discover -s scripts -p 'test_skill_*.py' -q
```

## Full gate

Mirrors the `test` job in `.github/workflows/ci.yml` step for step. Run it from
the branch's worktree root before opening a PR:

```sh
npm test
npm run kit:staleness
npm run release:guard -- --base "$(git merge-base origin/main HEAD)"
npm pack --dry-run
```

Notes on the individual steps:

- `npm test` is `test:node` (`node --test`) plus `test:python`
  (`python3 -m unittest discover -s scripts -p 'test_*.py'`). Several negative-path
  tests print `[FAIL] …` lines by design; only the runner's own summary and exit
  code decide red or green.
- CI runs `npm install --ignore-scripts` first. Locally that is only needed after
  a dependency change.
- `release:guard` runs in CI on `pull_request` only, against
  `github.event.pull_request.base.sha`. `git merge-base origin/main HEAD` is the
  local equivalent; `git fetch origin main` first if `origin/main` is stale.
- `npm pack --dry-run` catches packaging drift (a file added outside the
  published set) without publishing anything.

## Enforcement

Since #220 the host **does** enforce: the `main protection` ruleset makes the CI
job `test` a required status check on `main`, with no bypass actor. So the
generic skill's "When the host CAN enforce" branch applies to this repo — the
local gate is a pre-flight that shortens the feedback loop, not the only thing
standing between a red branch and `main`.

Layered, from cheapest to strongest:

| Layer | Runs | Scope |
| --- | --- | --- |
| `pre-commit` | automatic, every commit | fast skill/manifest lints |
| `pre-push` | automatic, every push | full `npm test` |
| this full gate | explicit, before a PR | `npm test` + staleness + release guard + pack |
| CI `test` | automatic, on the PR | the same set, machine-enforced at merge |

Never bypass a hook with `--no-verify`.

**Drift rule.** The full gate above and `.github/workflows/ci.yml` are two copies
of one list. Change one, change the other in the same PR — otherwise the local
gate goes green on a set the required check does not accept.

## Contention

Not applicable here. This repo has no dev server and the suites are process-level
(`node --test`, `unittest`), so the generic boot-contention false-red guidance has
no target. A red is a real red until an isolated re-run of that one test proves
otherwise.

## On a red

1. Read the failing assertion — the guards print the exact drift (`file:line`,
   the offending token, the missing manifest key).
2. Fix the source. A guard that legitimately cannot be satisfied yet gets a
   documented allowlist entry with a reason; never widen a guard silently.
3. Re-run the single failing suite, then the full gate for sign-off.

`kit:staleness` red almost always means the generated kit artefacts lag the
skill sources — run `npm run kit:build` and commit the result rather than
editing the generated output by hand.
