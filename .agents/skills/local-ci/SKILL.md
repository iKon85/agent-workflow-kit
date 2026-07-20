---
name: local-ci
"description": "Run the repo's local CI gate before opening a PR — the stand-in for GitHub required status checks when your plan or repo visibility can't enforce them (a Free-plan private repo has no branch protection). Use before every PR, when a guard/test red is suspected on a branch, or when wiring/repairing the pre-push guard backstop. Triggers — \"local ci\", \"run local ci\", \"pre-PR check\", \"why is main red\", \"did a guard land red\"."
---

# Local CI

A guard only protects if it runs on a **gate**. When your host can't enforce a
required status check at merge — **GitHub Free + Private has no branch protection
and no rulesets** ([GitHub Docs: protected
branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches))
— the gate has to be **local**. This skill is that gate.

> Fault class: *Detection without Enforcement.* A guard that runs only in a
> manual, opt-in step is not a gate — the drift it catches still merges. Fix the
> gate class, not the one field that slipped through.

The exact commands, guard names, hook wiring and the project's own incident lore
live in the **project layer** for this skill (its `docs/agents/skills/local-ci.md`,
seeded as an empty stub by `/setup-workflow` and filled per project). This
skeleton names the two profiles generically; run the two your project layer names.

## Required readiness preflight

Before running a guard, hook, test, or any other project command, run:

```sh
node scripts/readiness.mjs check --skill local-ci --json
```

Treat the result as authoritative. A `ready` verdict is silent: continue with
the existing gate and its safety rules. For a `blocked` verdict, stop without
running any guessed command and report `Local CI unavailable`, the
`localCiRecipe` state (`missing`, `pending`, `not-applicable`, or `invalid`),
and one recovery path: run `/setup-workflow`, then fill
`docs/agents/skills/local-ci.md` with the project's exact commands. Never infer
commands from package scripts, hooks, CI configuration, or another repository.

## When

- **Before opening ANY PR** → run the full local gate. Red → fix it, or defer a
  *single* failure ONLY with an explicit written reason in the PR body (never
  silently — a skipped gate framed as done is a fake quality gate).
- A guard/test red is suspected on a branch ("why is main red").
- Wiring or repairing the pre-push backstop / adding a new guard.

## The two profiles

Two commands, one fast and one full — your project layer names the exact
invocations:

- **Fast static guards** — no DB, ~seconds. Run automatically at **pre-push** so a
  red drift guard cannot leave the machine.
- **Full gate** — typecheck + lint + the test suites a CI job would run, ~a minute.
  Too slow for a hook → the **agent's named pre-PR step**, explicit not automatic.

## Enforcement model

- **pre-push** runs the fast guards automatically → a red drift guard cannot be
  pushed. Keep any emergency escape hatch explicit and logged — never a silent one.
- **pre-commit** gates typecheck + lint, and should block a committed focused-test
  marker (`.only` / `fit` / `fdescribe`) so a focused test can't silently gut a
  file's coverage (green-but-empty).
- The **full gate** is the agent's named pre-PR step: the full suite is too slow
  for a hook, so it is explicit, not automatic. Run it; report the result honestly.

## Contention — stop the dev server before the full gate

The full gate runs several test runners at once. A dev server running in parallel
oversubscribes the cores → **boot-contention false reds**: hook/boot timeouts in
*unrelated* tests that are green in isolation. Symptom = "Hook timed out" in tests
that pass on their own.

- Stop the dev server before the full gate. Verify a suspicious red as a false red
  by running that one test in isolation — green in isolation = contention, not a
  real red.
- Kill the dev server by **PID-via-port, not a process-name match**. A name match
  (`vite`) also hits the test runner (`vitest`), and matching your own command line
  kills the running command. Resolve the PID from the listening port instead.

## On a red

1. Read the failing test's message — a good guard prints the exact drift
   (`file:line`, the offending token, the missing allowlist key).
2. Fix the source. If a guard legitimately can't be satisfied yet, add its
   **documented allowlist entry with a reason** — never widen a guard silently
   (that re-opens the blind spot the guard exists to close).
3. Iterate on the single file, then the full gate for sign-off.

## Adding a new guard

Prefer a **glob-discovered** guard config so a new fast static guard joins the
pre-push set automatically — no hand-maintained list. Name it to match the include
glob and keep it **DB-free** (pre-push must stay ~seconds); DB-bound tests belong
to the full gate, not the fast pre-push set.

## Baseline-green first

If your success criterion is "gate green" and you do NOT know the base's green
status — you are **hardening the gate itself**, or building against a `main` that a
rename/schema cascade is landing on piecemeal — run the relevant gate part ONCE on
the **unmodified base** before your first edit. It separates pre-existing breakage
from your work; otherwise foreign reds surface one at a time as you build (an abort
+ scope question each).

## When the host CAN enforce

If the repo moves to a plan/visibility with required checks: add a CI workflow
running the full gate on PR and make it a **required status check** — then the gate
is machine-enforced at merge, not just local. Until then, local is the gate.
