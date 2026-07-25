<!-- setup-workflow: state=filled -->
# Issue tracker: GitHub

Issues and PRDs for this repo live in `iKon85/agent-workflow-kit` as GitHub issues.

## Conventions

- Use `gh` for issue reads and comments; infer the repository from the remote.
- Write multi-line issue and PR bodies through a temporary file and `--body-file`.
- Route board writes, status/wave/cluster field edits, dependencies, and sub-issue links through `scripts/board-sync.py`, not bare `gh project` commands.
- Board state is authoritative for workflow status; GitHub issues remain the durable content source.

## Pickup claim

Used by `/implement`, `/diagnose`, and `/orchestrate-wave` before the first
edit. Board status `In Progress` is the human-facing signal; the claim below is
the machine-readable one, and it is the only one that names the branch and
worktree a colliding session would have to find.

- **Check**: `gh issue view <n> --json assignees,comments --jq '{assignees: [.assignees[].login], claims: [.comments[].body | select(contains("<!-- agent-claim:"))]}'` — a foreign assignee or a marker this session did not plant is a foreign claim: stop, report the claimed branch/worktree, and leave it alone.
- **Claim**: `gh issue edit <n> --add-assignee @me`, then `gh issue comment <n> --body '<!-- agent-claim: branch=<branch>; worktree=<absolute-path>; date=<YYYY-MM-DD> -->'`. Board status stays a `scripts/board-sync.py` write, never a bare `gh project` call.
- **Release**: the slice PR (`closes #<n>` / `Part of #<anchor>`) supersedes the claim, so `/wrapup` needs no extra step. On abandon: `gh issue edit <n> --remove-assignee @me` plus a `claim released` comment.

