<!-- setup-workflow: state=filled -->
# Issue tracker: GitHub

Issues and PRDs for this repo live in `iKon85/agent-workflow-kit` as GitHub issues.

## Conventions

- Use `gh` for issue reads and comments; infer the repository from the remote.
- Write multi-line issue and PR bodies through a temporary file and `--body-file`.
- Route board writes, status/wave/cluster field edits, dependencies, and sub-issue links through `scripts/board-sync.py`, not bare `gh project` commands.
- Board state is authoritative for workflow status; GitHub issues remain the durable content source.

