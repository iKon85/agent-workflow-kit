# Code-review project layer

The generic `code-review` skill ships the Two-Axis method (Standards × Spec),
the Fowler-smell baseline, and the merge-base preflight — the *how*. This file
is the **project layer**: it records exactly which docs count as this repo's
Standards-axis sources, and how the method relates to any other review
tooling already running in this environment. The skill reads it at runtime;
with this file present it resolves the Standards sources directly instead of
scanning the repo root itself.

This is a structured-but-empty crust — `/setup-workflow` seeds the headings,
it does not invent your project's answers. Fill the two sections below
directly (or grow them over time) whenever you know the real values.

## Standards sources in this repo
<!-- List the docs the Standards axis should read: a root convention file
     (CLAUDE.md/AGENTS.md/CONTRIBUTING.md), any per-package convention files
     in a monorepo, a docs/conventions/ folder, a style guide. One per line. -->
- _none recorded yet — add the paths this repo's standards actually live at_

## Adjacent review tooling
<!-- Name any other review-shaped tool/skill/command already running in this
     environment (a plan-review loop, a security-specific audit, a
     reuse/simplification pass, a reviewer subagent) and how code-review
     relates to it (complements it / does not replace it). One per line. -->
- _none recorded yet_
