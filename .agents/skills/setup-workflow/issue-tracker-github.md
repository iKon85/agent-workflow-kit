# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <file>` — body always via `--body-file` (inline `--body` with backticks/parens crashes bash). Use a heredoc to build the file for multi-line bodies.
  <!-- setup-workflow: when board-sync.md ends at mode=github-projects-v2, insert the managed-board routing line here — "Board writes (item-add, status/wave/cluster field edits, sub-issue links) go through scripts/board-sync.py, not bare `gh issue create`/`gh project item-*`." Omit for GitLab / local / other / mode=none. -->
- **Sync to the board** (managed-board projects only): route board writes through the board-sync helper, not bare `gh issue create`/`gh project item-*` — see `docs/agents/board-sync.md` once `/setup-workflow` has filled it.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
