---
name: setup-pre-commit
description: Set up a native, zero-dependency git pre-commit hook (via core.hooksPath) that runs your project's type checks, linting, tests, or formatting before each commit. Use when the user wants to add pre-commit hooks, gate commits on checks, or wire commit-time typecheck/lint/test/format — no Husky or Node deps required.
---

# Setup Pre-Commit Hooks (native git, zero-dep)

## What This Sets Up

A versioned hooks directory wired through git's own `core.hooksPath` — no Husky,
no `lint-staged`, no extra dependencies, works in any repo regardless of stack:

- a `.githooks/` dir tracked in the repo
- a `pre-commit` hook (from the bundled template) that runs **your** checks
- one git config line so every clone uses it

## Why native over Husky

`core.hooksPath` (git ≥ 2.9) points git at a tracked hooks dir directly. The
hooks are plain scripts under version control — readable, debuggable, and
stack-agnostic. Husky adds a Node devDependency and a `prepare` script just to
do what one `git config` line does, and assumes a Node/npm project. For a kit
that must work in any consumer repo, native is the robust default. (Husky
remains a valid choice for Node-only teams — see the disclaimer at the end.)

## Steps

### 1. Create the hooks dir + drop in the template

```bash
mkdir -p .githooks
cp scripts/pre-commit.template.sh .githooks/pre-commit   # this skill's bundled template
chmod +x .githooks/pre-commit
```

The bundled template (`scripts/pre-commit.template.sh`) is a generic skeleton:
a shebang, an optional toolchain preflight, and a clearly-marked gate block with
commented per-stack examples. You fill the gate; you don't write the plumbing.

### 2. Wire the dir (one line, every clone honours it)

```bash
git config core.hooksPath .githooks
```

- **Team-wide auto-setup (optional):** so a fresh clone wires itself without the
  manual line, add it to an install step the repo already runs — e.g. a
  `postinstall`/bootstrap script: `git config core.hooksPath .githooks`. Keep it
  idempotent (the command is safe to re-run).

### 3. Fill the gate — Refinement seam

Open `.githooks/pre-commit`. Replace the `>>> your gate commands here <<<`
block with **your** project's fast checks. Each command must exit non-zero on
failure so the script's `set -e` blocks the commit. Examples by stack:

| Stack | Example gate |
|---|---|
| JS/TS (pnpm) | `pnpm exec tsc -b && pnpm lint` |
| Python | `ruff check . && mypy .` |
| Go | `go vet ./... && gofmt -l .` |
| Rust | `cargo fmt --check && cargo clippy -- -D warnings` |

- **Keep it fast.** Pre-commit runs on every commit. A whole test suite or
  type-check of a huge repo belongs in **pre-push** or CI, not here. Put only
  the cheap, high-signal checks in pre-commit.
- **Optional preflight.** If your checks need installed deps (`node_modules`,
  a venv), keep the template's preflight block so a missing toolchain fails with
  a clear message instead of a cryptic one. **Never instruct `--no-verify`** as
  the fix — fix the deps.

### 4. (Optional) add a pre-push hook for the heavy checks

Same mechanism: drop a `.githooks/pre-push` script (already wired by step 2).
Put the slower gate there — full test suite, build, or CI-mirror commands —
so commits stay fast but pushes are still gated.

### 5. Verify

- [ ] `git config --get core.hooksPath` → `.githooks`
- [ ] `.githooks/pre-commit` exists and is executable (`-x`)
- [ ] the gate block holds your real commands (no leftover `>>> ... <<<` marker)
- [ ] a deliberately-broken change is blocked by the hook (smoke test)

### 6. Commit

Stage the new `.githooks/` dir (and any bootstrap wiring) and commit. The commit
runs through your new hook — a good smoke test that the gate works.

## Alternative: Husky

If your repo is Node-only and your team already standardises on Husky, you can
use it instead (`npx husky init` + a `.husky/pre-commit`). It pulls a Node
devDependency and a `prepare` script and assumes npm/pnpm/yarn — which is why
this skill defaults to the native `core.hooksPath` scaffold above. Don't run
both: pick one hooks mechanism per repo.

## Notes

- `core.hooksPath` is repo-local config; each clone runs the wiring once (step 2
  or the optional bootstrap).
- Hooks are just scripts — `echo`-debug them freely; nothing is hidden behind a
  tool.
- Exit non-zero = block the commit. Exit 0 = allow.
