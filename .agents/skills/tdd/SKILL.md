---
name: tdd
description: "Test-driven development with red-green-refactor loop. Use when user wants to build features or fix bugs using TDD, mentions \"red-green-refactor\", wants integration tests, or asks for test-first development."
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill tdd --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# Test-Driven Development

## Philosophy

**Core principle**: Tests should verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe _what_ the system does, not _how_ it does it. A good test reads like a specification - "user can checkout with valid cart" tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means (like querying a database directly instead of using the interface). The warning sign: your test breaks when you refactor, but behavior hasn't changed. If you rename an internal function and tests fail, those tests were testing implementation, not behavior.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This is "horizontal slicing" - treating RED as "write all tests" and GREEN as "write all code."

This produces **crap tests**:

- Tests written in bulk test _imagined_ behavior, not _actual_ behavior
- You end up testing the _shape_ of things (data structures, function signatures) rather than user-facing behavior
- Tests become insensitive to real changes - they pass when behavior breaks, fail when behavior is fine
- You outrun your headlights, committing to test structure before understanding the implementation

**Correct approach**: Vertical slices via tracer bullets. One test → one implementation → repeat. Each test responds to what you learned from the previous cycle. Because you just wrote the code, you know exactly what behavior matters and how to verify it.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
  ...
```

## Workflow

### 1. Planning

**First, mark the ticket active on the board.** When a ticket was provided (you're on a `feat/<#>-`/`fix/<#>-` branch), run once at TDD pickup:

<!-- mirror-xform:start codex-board-sync-command -->
```
python3 .claude/hooks/sync-board-status.py
```
<!-- mirror-xform:end -->

It parses the issue # from the current branch and moves the board item to the profile's in-progress status (`fields.status.roles.inProgress`; only from the idea/triaged/spec roles, idempotent). No ticket / no parseable branch → it's a silent no-op, so this is safe to run unconditionally. This closes the gap where the SessionStart sync already ran on `main` before the worktree existed, leaving the board stale.

When exploring the codebase, use the project's domain glossary so that test names and interface vocabulary match the project's language, and respect ADRs in the area you're touching.

Before writing any code:

- [ ] Confirm with user what interface changes are needed
- [ ] Confirm with user which behaviors to test (prioritize)
- [ ] Find the nearest existing tests for those behaviors
- [ ] Assign exactly one test-delta decision per behavior
- [ ] Identify opportunities for [deep modules](deep-modules.md) (small interface, deep implementation)
- [ ] Design interfaces for [testability](interface-design.md)
- [ ] List the behaviors to test (not implementation steps)
- [ ] Get user approval on the plan

Ask: "What should the public interface look like? Which behaviors are most important to test?"

**You can't test everything.** Confirm with the user exactly which behaviors matter most. Focus testing effort on critical paths and complex logic, not every possible edge case.

### 2. Existing-Test-First Decision

TDD does not imply a new test file or a growing test count. Start at the nearest
existing behavioral test. For each planned behavior, record exactly one of these
test-delta decisions:

- **REUSE** — the existing public-behavior test already protects the change.
- **EXTEND** — add the missing boundary to the nearest suite or parameter table.
- **REPLACE** — establish equivalent protection at a smaller or more stable level,
  then retire the duplicate.
- **NEW** — only for a distinct, previously unprotected risk; name the plausible
  defect it catches.
- **RETIRE** — the behavior or contract is intentionally gone or already replaced;
  delete its obsolete test.
- **NO-NEW-TEST** — a behavior-neutral refactor or removal without a durable
  negative contract.

Do not create a new test file until the nearest existing owner has been inspected
and rejected with a reason. A feature, source file, component, method, or
acceptance-criterion line is not itself a test boundary.

Every executable new behavior and bug fix must begin with a failing assertion.
REUSE and NO-NEW-TEST never bypass this RED-first invariant. For a `REUSE`
candidate, run the existing assertion before implementation: if the requested
behavior is executable and the assertion is already green, an already-green
assertion does not prove the requested change; choose `EXTEND`, or choose `NEW`
after rejecting the nearest owner. `NO-NEW-TEST` is limited to behavior-neutral
work and removals without a durable absence contract.

For removals, delete the tests that specified the retired behavior. Add or keep a
negative assertion (`404`, forbidden, hidden) only when absence itself is a durable
security, API, or compatibility promise. Permanent skipped executable tests are
retired or moved to a runbook or issue, not parked in the green suite.

### Worked decision matrix

| Behavior situation | Decision | Feedback proof |
|---|---|---|
| An existing regression test reproduces the bug | REUSE | Existing assertion is RED, then the minimal fix makes it GREEN |
| The nearest suite lacks one requested boundary | EXTEND | Added assertion is RED, then the minimal change makes it GREEN |
| A broad duplicate can become a stable focused check | REPLACE | Equivalent protection is proven before the duplicate is removed |
| A distinct risk has no suitable owner after documented inspection | NEW | New assertion is RED and names the plausible defect it catches |
| The specified behavior is intentionally removed | RETIRE | Obsolete test is removed with the obsolete behavior |
| An internal refactor preserves all observable behavior | NO-NEW-TEST | Relevant existing suite is GREEN before and after the change |

### 3. First Feedback Cycle

Pick ONE behavior and use its decision's feedback loop:

```
REUSE, executable change: existing assertion → RED → minimal code → GREEN
EXTEND/NEW:              assertion in nearest suite → RED → minimal code → GREEN
REUSE, neutral change:  relevant suite GREEN → small refactor → stays GREEN
REPLACE:                 prove equivalent protection → remove duplicate → GREEN
RETIRE:                  remove obsolete behavior and its obsolete test → GREEN
NO-NEW-TEST:             relevant suite GREEN → behavior-neutral change → stays GREEN
```

The RED-to-GREEN cycle is the tracer bullet for each executable new behavior or
bug fix. It proves the path end to end without automatically creating another
test file.

### 4. Incremental Loop

Repeat one behavior at a time, using the matching feedback loop above.

Rules:

- One test at a time
- Prefer extending the existing owner or parameter matrix over adding a sibling file
- Only enough code to pass current test
- Don't anticipate future tests
- Keep tests focused on observable behavior

### 5. Refactor

After all tests pass, look for [refactor candidates](refactoring.md):

- [ ] Extract duplication
- [ ] Deepen modules (move complexity behind simple interfaces)
- [ ] Apply SOLID principles where natural
- [ ] Consider what new code reveals about existing code
- [ ] Run tests after each refactor step

**Never refactor while RED.** Get to GREEN first.

## Checklist Per Cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Exactly one test-delta decision is recorded for this behavior
[ ] NEW names the distinct plausible defect; a new file has a justified owner boundary
[ ] Code is minimal for this test
[ ] No speculative features added
[ ] Wave slice: a flipped/new assumption affecting an unbuilt sibling issue → log it to ANNAHMEN.md (worktree root; `make-landable` reads it when it authors the PR body)
```

At handoff, list every behavior and its one decision, then report the counted
test delta: `Reused X · Extended Y · New Z · Replaced/retired W`.
