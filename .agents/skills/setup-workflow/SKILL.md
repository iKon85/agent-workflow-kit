---
name: setup-workflow
description: "Scaffolds the project layer the portable workflow skills assume — issue tracker, triage labels, domain-doc layout, GitHub-Projects board field-IDs, spec-self-critique + spec-completeness seeds, and the deploy target. Writes `docs/agents/*`, `docs/conventions/spec-completeness.md`, and the `## Agent skills` + `## Prod` blocks in CLAUDE.md/AGENTS.md. Idempotent: a re-run reconciles per file/section and never overwrites filled content. Run once after installing the skills (or `npx <pkg> init`), or when a skill reports missing project-layer context. Adapted from Matt Pocock's `setup-matt-pocock-skills` (MIT)."
disable-model-invocation: true
---

# Setup Workflow

Scaffold the **project layer** the portable workflow skills (`to-prd`, `to-issues`, `triage`, `spec-self-critique`, `retro`, `wrapup`, …) read at runtime. The generic skills ship the *how*; this skill writes the project-specific *what* into the consumer repo, where `retro`/`wrapup` then grow it over time.

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write — **one section at a time**, never dump everything at once. Assume the user does not know what these terms mean; each section opens with a short plain explainer.

## Targets

| File / block | What |
|---|---|
| `docs/agents/issue-tracker.md` | where issues live + how to read/write them (Section A) |
| `docs/agents/triage-labels.md` | the triage label vocabulary (Section B) |
| `docs/agents/domain.md` | `CONTEXT.md`/ADR layout the domain skills read (Section C) |
| `docs/agents/board-sync.md` | GitHub-Projects field-IDs + board profile — **only meaningful for a GitHub tracker** (Section D) |
| `docs/agents/skills/spec-self-critique.md` | per-point enrichment skeleton; `/retro` appends here (Section E) |
| `docs/conventions/spec-completeness.md` | a valid `## Self-Critique-Check` convention seed (Section E) |
| `## Agent skills` + `## Prod` in CLAUDE.md **and** AGENTS.md | one-line pointers + deploy target (Sections C/F + Write) |

## Idempotency contract — read before writing anything

Every project-layer file this skill (or `npx init`) creates begins with **one sentinel line as its very first line**:

```
<!-- setup-workflow: state=<stub|filled|not-applicable>[; mode=<github-projects-v2|none>] -->
```

- `state=stub` — placeholder, awaiting fill (retryable). `state=filled` — populated, done. `state=not-applicable` — complete *by design* (e.g. board-sync for a non-GitHub tracker); never re-prompt. `mode=` appears **only** in `board-sync.md`.
- **Per-file decision** when this skill runs:
  - File missing → create it (write body + sentinel).
  - First line is `state=stub` → fill it, flip the sentinel to `filled` (or `not-applicable`).
  - First line is `state=filled` / `state=not-applicable` → **skip** (only the *first line* counts — a later mention of "setup-workflow" in the body does not).
  - File exists, **non-empty, no sentinel** (legacy / pre-existing) → treat as **legacy-filled**, **skip**, report it.
  - File exists but empty/whitespace, no sentinel → treat as fillable.
- **CLAUDE.md / AGENTS.md carry no sentinel** (they are not ours) → reconcile **per section** via the block headers `## Agent skills` / `## Prod`: add a missing block, never overwrite an existing one or surrounding user content.
- **Never overwrite filled content.** A re-run only fills what is missing/stub. End with a report: `<file>: created · filled · skipped (already filled / legacy / not-applicable)`.

## Process

### 1. Explore

Read the current state; don't assume. For every target file, read its first line to classify it per the idempotency contract (missing / stub / filled / not-applicable / legacy).

- `git remote -v` and `.git/config` — GitHub? GitLab? Which owner/repo?
- `CLAUDE.md` and `AGENTS.md` at the repo root — which exist? Do they already have an `## Agent skills` / `## Prod` block?
- `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/` — domain-doc layout.
- `docs/agents/`, `docs/agents/skills/`, `docs/conventions/` — prior output of this skill.
- `gh auth status` (if GitHub) — is `gh` authenticated, and with which scopes?

### 2. Section A — Issue tracker

> The "issue tracker" is where issues live for this repo. Skills like `to-issues`, `triage`, and `to-prd` read from and write to it — they need to know whether to call `gh`, `glab`, write markdown under `.scratch/`, or follow a workflow you describe.

Default posture: these skills were designed for GitHub. If a `git remote` points at GitHub, propose GitHub; at GitLab, propose GitLab. Otherwise offer:

- **GitHub** — GitHub Issues (`gh` CLI)
- **GitLab** — GitLab Issues (`glab` CLI)
- **Local markdown** — files under `.scratch/<feature>/` (solo projects / no remote)
- **Other** (Jira, Linear, …) — ask the user to describe the workflow in one paragraph; record it as freeform prose.

Seed `docs/agents/issue-tracker.md` from the matching template in this folder: [issue-tracker-github.md](./issue-tracker-github.md), [issue-tracker-gitlab.md](./issue-tracker-gitlab.md), [issue-tracker-local.md](./issue-tracker-local.md). For "other", write it from the user's description.

**Conditional board-write note (only when the GitHub tracker uses a managed board):** if Section D ends with `board-sync.md` at `mode: github-projects-v2`, add one line to `issue-tracker.md`: *"Board writes (item-add, status/wave/cluster field edits, sub-issue links) go through the board-sync helper, not bare `gh issue create`/`gh project item-*`."* Do **not** add this for GitLab, local, other, or `mode: none`.

### 3. Section B — Triage labels

> When `triage` processes an incoming issue it applies labels (or your tracker's equivalent). It needs strings you've actually configured, or it creates duplicates.

Present the canonical roles from [triage-labels.md](./triage-labels.md); each role's string defaults to its name. Ask whether to override any. Seed `docs/agents/triage-labels.md` from the template.

### 4. Section C — Domain docs

> Some skills read `CONTEXT.md` for domain language and `docs/adr/` for past decisions. They need to know whether the repo has one global context or several.

- **Single-context** — one `CONTEXT.md` + `docs/adr/` at the root (most repos).
- **Multi-context** — `CONTEXT-MAP.md` at the root pointing to per-context `CONTEXT.md` files (typically a monorepo).

Seed `docs/agents/domain.md` from [domain.md](./domain.md).

### 5. Section D — Board field-IDs (GitHub tracker only)

> A GitHub-Projects board stores its fields (Status, and any workflow fields like a wave/cluster/spec-path) under opaque GraphQL IDs. The board-managed skills need those IDs. They differ per board and can't be typed by hand, so this skill discovers them.

**Skip entirely if Section A is not GitHub** → write `board-sync.md` with `state=not-applicable`, `mode=none`, a one-line "this project does not use a GitHub-Projects board" note. Terminal; never re-prompts.

**Preflight:** `gh auth status`. If `project`/`read:project` scope is missing, surface the exact remedy: `gh auth refresh -s project,read:project`, then fall through to the stub path below.

**Discover (the success path):** `gh project list --owner <remote-owner> --format json`. If **exactly one** project clearly belongs to this repo's owner, read its fields: `gh project field-list <number> --owner <owner> --format json`. Record each field's `id`, `name`, `dataType` (single-select / number / text), and for single-selects the option `id`s. Write `board-sync.md` with `state=filled`, `mode=github-projects-v2`, the project node id + repo + the discovered field/option IDs, seeded from [board-sync.md](./board-sync.md). Fill the `<!-- board-sync:profile -->` **JSON block** (the machine SSOT `scripts/board_config.py` parses) — replace each `<…>` placeholder under `repo`/`project`/`fields` with the discovered value; leave the convention values (`labels`/`branchPrefixes`/`prMarkers`/`headings`) at their seeded defaults unless this project's conventions differ.

**Fallback (the single catch-all — no board / >1 / ambiguous / scope error / read failure):** do **not** auto-create a board (`gh project create` alone cannot provision the Status options + workflow fields a board needs). Write `board-sync.md` with `state=stub`, `mode=github-projects-v2`, and inline **instructions**: which fields the workflow profile needs (a Status single-select with your stage options; optionally a Wave number, a Cluster text, a Spec-Path / Plan-Path text), how to create the board in the GitHub UI / `gh`, and "then run `/setup-workflow` again — it will discover and fill the IDs." Retryable.

### 6. Section E — Spec-layer seeds (non-interactive)

These are **structured-but-empty** crusts that `/retro` grows; do not ask the user to fill them now.

- `docs/agents/skills/spec-self-critique.md` — seed the 12 per-point headings from [spec-self-critique-seed.md](./spec-self-critique-seed.md) so `/retro` has stable append anchors and `spec-self-critique` finds its project layer (suppressing the "layer absent" warning) without inventing project content.
- `docs/conventions/spec-completeness.md` — seed **one valid** `## Self-Critique-Check` block (Trigger/Check/Korrektur) from [spec-completeness-seed.md](./spec-completeness-seed.md). A convention file *without* a valid block makes `spec-self-critique` point 8 warn — an empty file is worse than none.

> **Handoff drift-guard (`.claude/hooks/drift-guard.py`).** The repo ships a PreToolUse hook that blocks a `.handoff/*.md` Write when the linked issue's rooted graph is not execute-ready (it delegates all coherence to `scripts/execute-ready-check.py --mode handoff`). It self-filters to `.handoff/*.md` and fires **only once handoff docs exist** — a freshly scaffolded project carries the guard but has nothing to guard yet (silently inoperative until the first `.handoff/` write). This scaffold only **documents** the interplay; it does **not** build new mechanics. Once the project starts emitting handoffs, writes land in `.handoff/` and the guard activates automatically.

### 7. Section F — Deploy target

> `wrapup` and live-verify reference where this project deploys (host, command, URL). It lives in the `## Prod` block of CLAUDE.md/AGENTS.md, not a separate file.

Ask for the deploy target in plain terms (where does this ship, how is it deployed, what's the live URL?). Record it for the `## Prod` block (Write step). If the user has no deploy target, skip — do not invent one.

### 8. Write

For each `docs/...` file: obey the idempotency contract (the "Idempotency contract" section). Prepend the sentinel with the resolved `state` (and `mode` for board-sync).

For the **`## Agent skills`** and **`## Prod`** blocks, reconcile per section in **both** CLAUDE.md and AGENTS.md that exist:

- If **both** files exist → write/update the block in **both** (keep them coherent — Codex is a first-class surface).
- If **one** exists → that one.
- If **neither** exists → ask the user which surface(s) to create (**default `CLAUDE.md`**), then write there.
- If an `## Agent skills` / `## Prod` block already exists → update its contents in-place; never duplicate or clobber surrounding user content.

`## Agent skills` block:

```markdown
## Agent skills

### Issue tracker
[one-line summary]. See `docs/agents/issue-tracker.md`.

### Triage labels
[one-line summary]. See `docs/agents/triage-labels.md`.

### Domain docs
[one-line summary — single- or multi-context]. See `docs/agents/domain.md`.
```

`## Prod` block (only if Section F produced a deploy target):

```markdown
## Prod

[host / platform], deployed via [command/trigger]. Live: [URL].
```

### 9. Done

Report the per-file outcome (`created · filled · skipped`), which surface(s) you wrote the blocks to, and which skills now read the layer. Note the user can edit `docs/agents/*.md` directly later, and that `/retro` grows the spec-layer seeds over time. Re-running this skill only fills what is missing or `state=stub`.
