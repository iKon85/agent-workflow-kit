#!/usr/bin/env bash
# pre-commit — native git hook (zero-dep, stack-agnostic).
#
# This is a TEMPLATE. Copy it into your repo's hooks dir (default: .githooks/),
# make it executable (chmod +x), and wire the dir with:
#   git config core.hooksPath .githooks
# Then fill the gate block below with YOUR project's checks.
#
# Exit non-zero to BLOCK the commit. Keep each check fast — it runs on every
# commit. Slow/whole-suite checks belong in pre-push or CI, not here.

set -euo pipefail

# --- Optional preflight ----------------------------------------------------
# Bail early with a clear message if the toolchain isn't installed, so the
# real checks don't fail with cryptic errors. Adapt or delete for your stack.
#
#   if [ ! -d node_modules ]; then
#     echo "❌ deps missing — run your install, then commit again. NEVER --no-verify."
#     exit 1
#   fi

# --- Gate: fill in YOUR checks ---------------------------------------------
# Replace the examples below with your real commands. Each must exit non-zero
# on failure (the script's `set -e` then blocks the commit). Examples by stack:
#
#   # JS/TS (pnpm):   pnpm exec tsc -b && pnpm lint
#   # Python:         ruff check . && mypy .
#   # Go:             go vet ./... && gofmt -l .
#   # Rust:           cargo fmt --check && cargo clippy -- -D warnings
#
# >>> your gate commands here <<<
echo "⚠ pre-commit template not configured yet — add your checks in .githooks/pre-commit"

echo "✅ pre-commit checks passed."
