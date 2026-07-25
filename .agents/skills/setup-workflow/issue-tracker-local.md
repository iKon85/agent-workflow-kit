# Issue tracker: Local Markdown

Issues and PRDs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md`
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Pickup claim

Used by `/implement`, `/diagnose`, and `/orchestrate-wave`: the visible claim
that keeps a second session, machine, or cloud agent off an issue already being
built. There is no assignee field here, so the marker line carries the whole
claim — commit it, otherwise no other checkout can see it.

- **Check** (before any edit): read the issue file and grep it for `<!-- agent-claim:`. A marker this session did not plant is a foreign claim: stop and report it, never overwrite or delete it.
- **Claim**: set `Status: claimed` and add one marker line directly under it — `<!-- agent-claim: branch=<branch>; worktree=<absolute-path>; date=<YYYY-MM-DD> -->` — then commit and push the issue file so other checkouts see the claim.
- **Release**: a PR referencing the issue supersedes the claim. On abandon, delete your own marker line, reset `Status:` to its pre-pickup role, and commit.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` — the Notes / Decisions-so-far / Fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
