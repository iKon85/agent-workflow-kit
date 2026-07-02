---
name: code-review
description: Review a diff, branch, or PR against two separate axes — Standards (this repo's own conventions plus a Fowler-smell baseline) and Spec (does the diff faithfully implement the originating issue/PRD) — reported side by side, never merged or re-ranked. Runs a three-dot merge-base preflight before either axis starts. Use when asked to review a diff/branch/PR, or when a review needs to answer both "does this follow our standards" and "does this match the spec" without one masking the other. NOT for a pre-code plan review (that reviews a plan before any code exists), NOT for root-causing a known bug (`diagnose`), and NOT a pure reuse/simplification/efficiency pass (narrower, no bug-hunting).
---

# Code Review

A code-review compares one diff against **two independent axes** — Standards and Spec — and reports them **separately**. A diff can pass one axis and fail the other: code that satisfies every convention but builds the wrong thing is a Standards-pass/Spec-fail; code that nails the issue but breaks conventions is a Spec-pass/Standards-fail. Merge or re-rank the two and one axis silently masks the other — that is the exact failure mode this method exists to prevent.

## When this and not another skill

| You are reviewing… | Use |
|---|---|
| "Review this diff/branch/PR against our standards AND the spec." | **code-review** |
| "Review this plan before any code is written." (adversarial pre-code review) | a plan-review / adversarial-review skill |
| "Why is this broken / slow?" (root-cause of a known defect) | `diagnose` |
| "Clean this up — reuse, simplify, cut waste." (no bug-hunting) | a dedicated simplification pass |

## Preflight (fail-fast, before either axis starts)

1. **Fixed point** — whatever the requester names: a SHA, branch, tag, `main`, `HEAD~N`. Missing → ask; do not guess.
2. **Three-dot diff against the merge-base** — `git diff <fixed-point>...HEAD` (three dots, not two — two dots diffs tip-to-tip and pulls in unrelated upstream changes), plus the commit list: `git log <fixed-point>..HEAD --oneline`.
3. **Validate before working** — `git rev-parse <fixed-point>` must resolve, and the diff must be non-empty. A bad ref or an empty diff fails **here**, not silently inside a parallel sub-agent.

## Axis 1 — Standards

**Sources.** This repo's own documented conventions: a root convention file (`CLAUDE.md`/`AGENTS.md`/`CONTRIBUTING.md` — whichever this repo uses), any per-package convention files in a monorepo, a `docs/conventions/` folder. If `docs/agents/code-review.md` exists (this skill's project layer, seeded by `/setup-workflow`), read it first — it names exactly which sources count here and how this method relates to any other review tooling already running in this environment. Absent that file, gather the sources yourself from the repo root before reviewing.

**Plus a Fowler-smell baseline** (*Refactoring*, ch. 3) — applies even when the repo documents nothing. Each smell is a **judgment call** (flag as "possible X"), never a hard violation:

- **Mysterious Name** — a name that does not say what it does/holds → rename; a dishonest name hides a murky design.
- **Duplicated Code** — the same logic shape in ≥2 hunks/files → extract, have both call it.
- **Feature Envy** — a function reaches into another module's data more than its own → move it to the data it envies.
- **Data Clumps** — the same fields always travel together → bundle them into one type.
- **Primitive Obsession** — a primitive/string standing in for a domain concept → give it its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurring across the diff → polymorphism or a shared map.
- **Shotgun Surgery** — one logical change forces edits scattered across many files → consolidate into one module.
- **Divergent Change** — one module edited for many unrelated reasons → split it, one reason per module.
- **Speculative Generality** — an abstraction/hook built for a need the spec does not have → delete it, inline until real demand exists.
- **Message Chains** — a long `a.b().c().d()` → hide it behind one method on the first object.
- **Middle Man** — a class/function that only delegates onward → cut it out, call directly.
- **Refused Bequest** — a subclass ignoring most of what it inherits → drop inheritance, use composition.

**Two binding rules:** (1) **A documented repo standard overrides the baseline** — if the repo's own conventions explicitly sanction something the baseline would flag, suppress the flag. (2) **Skip what tooling already enforces** — a type checker, linter, or CI guard catches that class of issue mechanically; the review does not re-derive it.

## Axis 2 — Spec

**Source.** The originating issue/PRD, resolved through this project's issue-tracker workflow (`docs/agents/issue-tracker.md`, seeded by `/setup-workflow`) — pull the issue reference from the commit messages or the PR description. No issue reference → ask the requester for the spec path. No spec exists at all → report this axis as "no spec available" and skip it; never invent requirements to check against.

**Taxonomy**, each finding cited against a specific spec line:
- (a) **Missing/partial** — requirements the spec asks for that are absent or only half-built.
- (b) **Scope creep** — behavior in the diff the spec never asked for.
- (c) **Looks-right-but-wrong** — requirements that appear implemented but diverge from what the spec actually says on inspection.

## Execution

- Run both axes as **parallel sub-agents** — separate context each, so neither poisons the other's read. Give the Standards sub-agent the Standards sources **plus** the full Fowler baseline in its prompt; it has no other way to see the baseline.
- Report **side by side**, under `## Standards` and `## Spec` headers, verbatim or lightly cleaned — never merge or re-rank the two into one combined verdict.
- Cap each sub-agent's report under 400 words — findings, not padding.
- Close with a findings count **per axis** and the single worst issue **per axis** — never a cross-axis "winner"; picking one would be exactly the re-ranking this method exists to prevent.

## Relationship to adjacent review tooling

This skill governs one thing: a diff/branch/PR review split into Standards vs. Spec. It is not the only review-shaped tool an environment may have — a pre-code plan-review loop, a security-specific audit, a pure reuse/simplification pass, or a dedicated reviewer subagent can all coexist with it; each stays its own axis, not a replacement for this one. If this repo has seeded `docs/agents/code-review.md`, it names the concrete adjacent tools and how they relate; absent that, treat any other review tool you find as complementary unless it explicitly says otherwise.
