---
name: verify-spike
description: "Answer a single yes/no factual question about reality with a minimal throwaway, read-only harness and output-proof. Use when a plan, ADR, or implementation hinges on an empirically-checkable fact — does a library API exist / behave this way on this version, does the runtime / DB / platform actually have this capability, does an external assumption hold — and you need a proven verdict before locking the decision. NOT for design exploration (prototype), bug root-cause (diagnose), or building a feature (tdd)."
---

# Verify Spike

A verify-spike is **throwaway, read-only code that proves a yes/no fact about reality.** The question is binary; the spike makes the answer empirical instead of assumed.

This is the "Verify First" rule with a runnable harness behind it: when you cannot answer an externally-knowable fact from docs alone, build the smallest thing that forces reality to answer.

## When this and not another skill

| You are asking… | Skill |
|---|---|
| "Is this fact true against the real lib / runtime / DB / platform?" (yes/no) | **verify-spike** |
| "Does this design / state model / UI feel right?" (open-ended) | `prototype` |
| "Why is this broken / slow?" (root-cause of a known defect) | `diagnose` |
| "Build this behaviour, test-first." (new feature/fix) | `tdd` |

If the question is really "what should this be", it is not a verify-spike — those are open, not yes/no.

## Steps

1. **Frame one falsifiable question.** Write it down as a single sentence with a yes/no answer and the exact version/context it is scoped to — e.g. "Does `customType.mapFromDriverValue` run on `drizzle-orm@1.0.0-rc.3` + node-postgres?". Name what a YES vs a NO looks like in the output *before* you run anything.
2. **Build the smallest harness that forces the answer.** Borrow the feedback-loop toolkit from `diagnose` Phase 1 — a one-call throwaway script, a fixture replay, a tiny HTTP/curl probe, a headless-browser assertion. Pick the cheapest one that touches the real thing (real lib version, real runtime, the actual DB read). One command to run; locate it in a clearly-throwaway path (`scratch/`, `*.spike.ts`).
3. **Run it and capture the proof.** Keep the raw output — the value, the error, the stack, the HTTP status. The verdict is only as good as the evidence pasted under it.
4. **Record the verdict durably, with its evidence inline.** Yes/No + the proof (output snippet / `file:line` / version) + the date + the scope it was checked at. Sink it where the decision lives: an ADR, the issue body, the plan, or a PR comment. A verdict without inline evidence is just an unverified claim — keep the proof attached so a later reader does not have to re-run the spike to trust it.
5. **Delete the harness.** The *answer* is the only keeper. Remove the spike code (or fold the proven fact into real code) so nothing throwaway rots in the repo.

## Rules

1. **Read-only.** No schema changes, no migrations, no writes to a shared/prod resource. A DB question hits a scratch row or a read; never mutate state you did not create.
2. **Throwaway from line one.** No tests, no abstractions, no error handling beyond what makes it run. The spike is deleted in step 5 — do not polish it.
3. **Touch the real thing.** The whole point is empirical: pin the actual version, hit the actual runtime/API. A spike against a mock proves nothing.
4. **Evidence, not assertion.** "It works" is not a verdict. The output is.
5. **Scope honestly.** The answer holds only for the version/context you tested. State that scope in the verdict so a later version bump re-opens the question instead of inheriting a stale yes/no.
