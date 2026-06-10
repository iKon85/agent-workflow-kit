# agent-workflow-kit

**A complete shipping loop for coding agents — plan → execute → land → learn.**

These are the skills, helper scripts, and conventions one team actually uses to
take work from a vague idea to a merged, verified PR with [Claude Code] and
[Codex]. One `npx` command drops them into any repo; `/setup-workflow` wires
them to your tracker and board. Edit anything — updates never clobber your changes.

[Claude Code]: https://claude.com/claude-code
[Codex]: https://developers.openai.com/codex/cli

## Quickstart

```sh
# from the root of the repo you want to add the workflow to
npx github:iKon85/agent-workflow-kit init
```

1. **`init`** copies the skills + helper scripts in, and seeds empty
   project-layer stubs. It never overwrites a file you already have.
2. **Run `/setup-workflow`** once (in Claude Code / Codex). A guided, idempotent
   skill that detects your issue tracker, writes your label + domain + deploy
   config, and — for a GitHub Projects board — discovers the field IDs into a
   board profile. See [Configuration](#configuration).
3. **Start working.** Trigger skills by name (`/grill-with-docs`, `/tdd`,
   `/wrapup`, …) — the workflow below explains when each one earns its keep.

## The workflow it installs

The skills aren't a grab-bag — they're four phases of one loop. Each phase below
names the failure mode it removes and the skills that remove it.

### 1. Plan — turn a vague idea into shaped, tracked work

> *Agents dive into code before the problem is sharp, then build the wrong thing
> well.* The plan phase makes you earn a clear spec first.

- **`grill-me` / `grill-with-docs`** — interrogate the intent (and the docs)
  until the real requirement surfaces, instead of latching onto the first framing.
- **`to-prd`** — turn the sharpened intent into a short PRD issue.
- **`to-issues`** — slice the PRD into atomic issues, or a wave anchor with
  child slices when it's bigger than one PR.
- **`board-to-waves`** — cluster an existing backlog into themed campaigns when
  you need to *find* the next wave rather than start fresh.
- **`triage`** — keep the inbox sane with a consistent label vocabulary.
- **`spec-self-critique`** — red-team your own spec before you commit to building it.

### 2. Execute — build it right, not just fast

> *"Make the tests pass" drifts into untested, sprawling, hard-to-review change.*
> The execute phase keeps the diff disciplined.

- **`tdd`** — a strict red → green → refactor loop; the test is written first
  and must fail for the right reason.
- **`prototype`** — spike a throwaway when the path is genuinely unclear, so the
  real implementation is informed.
- **`diagnose`** — a disciplined root-cause hunt for bugs (reproduce → isolate →
  fix → prove), not a guess-and-patch.
- **`zoom-out` / `improve-codebase-architecture`** — step back from the diff to
  the structure when a change is fighting the codebase.

### 3. Land — ship without surprises

> *The risky part is the merge: half-checked PRs, broken hooks, context lost at
> handoff.* The land phase puts mechanical gates in front of the commit.

- **`git-guardrails` / `setup-pre-commit`** — install the guardrails and a
  pre-commit gate so secrets and broken builds can't slip through.
- **`wrapup`** — the pre-PR closeout: live-verify the outcome, write the PR body,
  reconcile the board, and surface anything still open.
- **Helper scripts** — `pr-body-check.py`, `execute-ready-check.py`, and
  `board-sync.py` keep the PR and the issue tracker honest (see Configuration).

### 4. Learn — compound the lessons instead of repeating them

> *The same mistake recurs because nothing captured it.* The learn phase turns
> friction into config.

- **`retro`** — an in-session post-mortem that proposes concrete changes to your
  rules, skills, or hooks, each with per-patch approval.
- **`write-a-skill`** — turn a move you keep repeating into a reusable skill.

### Optional: cross-model review (via Codex)

An independent second model is a cheap way to catch what one model rationalizes.
**`grill-me-codex` / `grill-with-docs-codex`** run the grill through Codex, and
**`codex-review`** gets a second-opinion code review. These need the Codex CLI.

## Configuration

The skills ship the *how*; your repo supplies the *what*. `init` only lays down
empty stubs — **`/setup-workflow` fills them**. It's a guided, idempotent skill
(not a script): it explores your repo, confirms with you section by section, and
writes:

| It writes | So that |
|---|---|
| `docs/agents/issue-tracker.md` | `to-issues` / `triage` know whether to call `gh`, `glab`, or follow your flow |
| `docs/agents/triage-labels.md` | triage uses *your* label vocabulary |
| `docs/agents/domain.md` | the domain skills find your `CONTEXT.md` / ADR layout |
| `docs/agents/board-sync.md` | the board scripts get your GitHub Projects field IDs (the **board profile**) |
| `## Agent skills` + `## Prod` in `CLAUDE.md` / `AGENTS.md` | the agent knows your skills and deploy target |

Each generated file carries a `setup-workflow` sentinel on its first line, so a
re-run only fills what's missing and **never overwrites content you've filled in**.

### The board profile

The board helper scripts carry **no hard-coded IDs**. They read everything
board-specific from a single fenced `json` block in `docs/agents/board-sync.md`,
marked `<!-- board-sync:profile -->`:

```json
{
  "repo": "<owner>/<repo>",
  "project": { "number": 1, "owner": "<owner>", "nodeId": "<project-node-id>" },
  "fields": {
    "status": {
      "id": "<status-field-id>",
      "options": { "Spec": "<option-id>", "In Progress": "<option-id>", "Done": "<option-id>" }
    },
    "wave": "<wave-field-id>",
    "cluster": "<cluster-field-id>",
    "specPath": "<field-id>",
    "planPath": "<field-id>"
  },
  "labels": { "readyForAgent": "ready-for-agent", "typePrefix": "type:", "clusterType": "type:cluster" },
  "branchPrefixes": ["feat", "fix", "chore", "docs"],
  "prMarkers": { "partOf": "Part of", "retroMarker": "**Retro:**", "retroValues": ["done", "skipped"] },
  "headings": { "vorBau": "To clarify before building" }
}
```

`/setup-workflow` discovers these values for you from `gh project field-list`;
you rarely touch this by hand. Point a script at an alternate profile with the
`BOARD_SYNC_PROFILE` environment variable. Labels, branch prefixes, and headings
are *yours* to rename — the scripts read whatever the profile says.

### What's yours vs. the kit's

`init` records a sha256 of every file it installs. That's the line between the
two: **edit any skill or script freely** — `update` detects your edits and backs
them up rather than clobbering them. Your **project layer** (`docs/agents/*`, the
board profile, `CLAUDE.md`) is created once and never touched by `update`.

## Updating & removing

```sh
npx github:iKon85/agent-workflow-kit diff        # preview an update (dry run, writes nothing)
npx github:iKon85/agent-workflow-kit update      # apply it
npx github:iKon85/agent-workflow-kit uninstall   # remove kit-installed files
```

`update` is a three-way reconcile against the hashes `init` recorded:

- a file you **didn't** touch fast-forwards to the new version;
- a file you **did** edit is kept — the incoming version is backed up with a
  timestamp and a diff is printed, never silently overwritten;
- a file removed upstream is offered for deletion (a hook still referenced by your
  `settings.json` is kept regardless);
- new skills are added.

`uninstall` removes what the kit installed and retains anything you edited or
still reference. Flags: `--force` (overwrite pre-existing files on `init`),
`--yes` / `-y` (non-interactive).

## What's in the box

**21 skills** (Plan: grill-me, grill-with-docs, to-prd, to-issues, board-to-waves,
triage, spec-self-critique · Execute: tdd, prototype, diagnose, zoom-out,
improve-codebase-architecture · Land: git-guardrails, setup-pre-commit, wrapup ·
Learn: retro, write-a-skill · Setup: setup-workflow · Codex review: grill-me-codex,
grill-with-docs-codex, codex-review), installed for both surfaces — `.claude/skills`
(Claude Code) and `.agents/skills` (Codex).

**Helper scripts** — `board_config.py` (profile loader), `board-sync.py`,
`execute-ready-check.py`, `pr-body-check.py`, a handoff drift-guard hook, and a
wave-anchor template.

## Requirements

- **Node ≥ 20** to run the installer.
- **Claude Code** or **Codex** to run the skills.
- **GitHub `gh` CLI** for the board scripts (optional — skip if you don't use a
  GitHub Projects board).
- **Codex CLI** for the `-codex` review skills (optional).

## Credits

- Many skills are adapted from **Matt Pocock's skills**
  (https://github.com/mattpocock/skills), MIT — each carries a
  `THIRD-PARTY-NOTICES.md` with its upstream path.
- The `grill-*-codex` / `codex-review` cross-model review is by **Chase AI**
  (https://github.com/chaseai-yt/grill-me-codex), MIT.
- `retro`, `wrapup`, `spec-self-critique`, `board-to-waves` are original work.

Full origin + license of every skill is in [PROVENANCE.md](PROVENANCE.md).

## License

MIT — see [LICENSE](LICENSE).

## A note on language

Some skill prose is still German — these conventions grew up in a German-speaking
project. The mechanics are language-neutral (the project layer drives everything),
so the skills work as-is; an English pass over the prose is a planned follow-up.
