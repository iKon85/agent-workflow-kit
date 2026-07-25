---
name: implement
description: "Implement a piece of work based on a PRD or set of issues."
disable-model-invocation: true
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill implement --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

Implement the work described by the user in the PRD or issues.

## Pickup — claim the issue first

Applies whenever the work comes from a tracked issue. Work handed over as plain
text or a local plan has nothing to claim; skip this section then.

<!-- issue-claim:start -->
**Claim the issue before you build.** A worktree, branch, or PR check only sees
this machine, and only once someone has pushed — the claim on the issue itself
is the only signal a second session, a second machine, or a cloud agent can
read.

1. **Check first.** Read the issue's assignee and its claim comments. An
   `<!-- agent-claim: ... -->` marker you did not plant, or an assignee that is
   not you, is a **foreign claim**: **STOP**, report the claimed branch and
   worktree, and ask the user how to proceed. Take the issue over only on their
   word, and never delete a foreign claim. A claim whose branch and worktree no
   longer exist is stale — say that and let the user decide; do not assume it is
   dead.
2. **Plant your claim, before the first edit.** Assign the issue to yourself
   where the tracker supports it, and post the claim marker as a comment:
   `<!-- agent-claim: branch=<branch>; worktree=<absolute-path>; date=<YYYY-MM-DD> -->`
   Branch and worktree are the payload — without them a colliding session sees
   the collision but cannot find the work in progress.
3. **Release.** A PR that references the issue **supersedes** the claim, so
   landing needs no extra step. If you abandon or hand back the work, remove
   your own claim (unassign plus a one-line `claim released` comment) before you
   stop.

The concrete commands are your tracker's — `docs/agents/issue-tracker.md`,
§Pickup claim. If that layer documents no claim convention, fall back to the two
generic operations above: self-assign, plus the marker comment.
<!-- issue-claim:end -->

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review to review the work.

Commit your work to the current branch.
