---
name: setup-workflow
description: "Scaffolds the project layer the portable workflow skills assume — issue tracker, triage labels, domain-doc layout, board field IDs, spec seeds, workflow overview, optional census choice, and deploy target. Writes `docs/agents/*`, `docs/conventions/spec-completeness.md`, and the `## Workflow` / `## Agent skills` / `## Prod` blocks in CLAUDE.md/AGENTS.md. Idempotent: a re-run reconciles per file/section and never overwrites filled content. Run once after installing the skills (or `npx <pkg> init`), or when a skill reports missing project-layer context. Adapted from Matt Pocock's `setup-matt-pocock-skills` (MIT)."
disable-model-invocation: true
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill setup-workflow --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

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
| `docs/agents/skills/orchestrate-wave.md` | `orchestrate-wave` project layer (setup / commands / verify / login / landing) the wave-landing skill probes at runtime (Section E) |
| `docs/conventions/spec-completeness.md` | a valid `## Self-Critique-Check` convention seed (Section E) |
| `docs/agents/code-review.md` | Standards-source pointers + adjacent-review-tooling notes the `code-review` skill's Standards axis reads (Section I) |
| `## Workflow` in CLAUDE.md **and** AGENTS.md | generic entry-point map seeded from [workflow-overview.md](./workflow-overview.md) (Section F + Write) |
| `## Agent skills` + `## Prod` in CLAUDE.md **and** AGENTS.md | one-line pointers + deploy target (Sections C/G + Write) |
| `.github/workflows/agent-workflow-kit-update.yml` | optional tested Kit update pull request for GitHub consumers (Section A2) |
| `docs/agents/census.md` | optional-census choice, paths, state, and safe disable contract seeded from [census.md](./census.md) (Section A3) |
| `docs/agents/workflow-capabilities.json` + capability assets | consumer-owned Worktree Lifecycle, Memory Lifecycle, Workflow Advisories, and Safety Guardrails choices (Sections A4–A7) |
| `.claude/settings.json` | additive activation of the advisory kit-origin Edit/Write hint (Section A8) |
| user-local routing profile | familiar agent surfaces + switching autonomy (Section A9; never package- or repository-owned) |

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
- **CLAUDE.md / AGENTS.md carry no sentinel** (they are not ours) → reconcile **per section** via the block headers `## Workflow` / `## Agent skills` / `## Prod`: add a missing block, never overwrite an existing one or surrounding user content.
- **Never overwrite filled content.** A re-run only fills what is missing/stub. End with a report: `<file>: created · filled · skipped (already filled / legacy / not-applicable)`.

## Universal Project skill extensions

Every shipped skill can consume an additive Project extension at
`docs/agents/skills/<skill>.md`. A newly created extension starts with this
identity and schema marker (after the optional setup-workflow sentinel):

```md
<!-- agent-workflow-kit: project-extension/v1; skill=<skill> -->
```

The marker's `<skill>` must match the filename and a canonical or locally
registered skill identity. Existing non-empty files without a marker remain
supported as legacy v0 and are never rewritten merely to add the marker.
Setup and update preserve every extension byte-for-byte unless a future,
declared schema migration explicitly includes it.

Use an extension for Project language, commands, policy, and capability data
that the Core skill already knows how to apply. It is additive and cannot
weaken Core user gates, safety, ownership, or validation. Changes to parsing,
migration, evaluation, or other executable Core semantics require an
Explicit fork with a separate identity and update line.

## Process

### 1. Explore

Read the current state; don't assume. For every target file, read its first line to classify it per the idempotency contract (missing / stub / filled / not-applicable / legacy).

- `git remote -v` and `.git/config` — GitHub? GitLab? Which owner/repo?
- `CLAUDE.md` and `AGENTS.md` at the repo root — which exist? Do they already have a `## Workflow` / `## Agent skills` / `## Prod` block?
- `CONTEXT.md`, `CONTEXT-MAP.md`, `docs/adr/` — domain-doc layout.
- `docs/agents/`, `docs/agents/skills/`, `docs/conventions/` — prior output of this skill.
- `docs/agents/census.md`, `.census/profile.json`, `.census/active.json` — an existing census choice or consumer-owned census to adopt.
- `docs/agents/workflow-capabilities.json`, `.claude/settings.json`, `git config --get core.hooksPath` — existing capability choices/profile plus Worktree Lifecycle, Workflow Advisories, Safety Guardrails, and kit-origin hint wiring to adopt.
- `.memory/active/`, `.memory/archive/`, and `.memory/receipts/` — consumer-owned Memory Lifecycle policies or recovery evidence to adopt without normalization.
- The Kit routing-profile preflight — adopt a valid user-local choice without
  printing or copying it into the repository. Never infer personal routing
  policy from instruction files, credentials, or package-owned metadata.
- `gh auth status` (if GitHub) — is `gh` authenticated, and with which scopes?

### 2. Section A — Issue tracker

> The "issue tracker" is where issues live for this repo. Skills like `to-issues`, `triage`, and `to-prd` read from and write to it — they need to know whether to call `gh`, `glab`, write markdown under `.scratch/`, or follow a workflow you describe.

Default posture: these skills were designed for GitHub. If a `git remote` points at GitHub, propose GitHub; at GitLab, propose GitLab. Otherwise offer:

- **GitHub** — GitHub Issues (`gh` CLI)
- **GitLab** — GitLab Issues (`glab` CLI)
- **Local markdown** — files under `.scratch/<feature>/` (solo projects / no remote)
- **Other** (Jira, Linear, …) — ask the user to describe the workflow in one paragraph; record it as freeform prose.

Seed `docs/agents/issue-tracker.md` from the matching template in this folder: [issue-tracker-github.md](./issue-tracker-github.md), [issue-tracker-gitlab.md](./issue-tracker-gitlab.md), [issue-tracker-local.md](./issue-tracker-local.md). For "other", write it from the user's description.

### 2a. Automatic Kit update pull requests (GitHub tracker only)

> A short scheduled check can keep the installed Kit current by opening one
> normal pull request after the candidate passes the built-in Kit invariant
> validator. It runs no Consumer package script and never merges the pull
> request for you.

Only after the user has confirmed a **GitHub tracker**, ask in plain language:
*"Should GitHub check weekly for a verified Agent Workflow Kit update and keep
one update pull request ready?"* Offer these explicit choices:

Before offering **Enable**, explain that the update command uses the same
built-in Kit invariant validator as manual and agent-driven updates. There is
no Consumer package script, lockfile, configurable verification profile, or
legacy test fallback prerequisite.

Also read the repository Actions policy before enabling:

```bash
gh api repos/<owner>/<repo>/actions/permissions/workflow
```

The response must report `"can_approve_pull_request_reviews": true`; this is GitHub's **Allow GitHub Actions to create and approve pull requests** gate used by the stable PR upsert. If it is false, or the policy cannot be read, do not seed the workflow yet. Guide the user to **Settings → Actions → General → Workflow permissions**, enable that checkbox, and rerun `setup-workflow`.

If the user prefers `gh`, first show the exact mutation and obtain **explicit confirmation**; never change repository settings merely because setup was invoked. After confirmation, preserve the currently reported `default_workflow_permissions` value (`read` or `write`) and set the gate with:

```bash
gh api --method PUT repos/<owner>/<repo>/actions/permissions/workflow \
  -f default_workflow_permissions=<current-read-or-write> \
  -F can_approve_pull_request_reviews=true
```

Read the policy back and offer **Enable** only after the field is actually true.

- **Enable** — seed `.github/workflows/agent-workflow-kit-update.yml` from [assets/agent-workflow-kit-update.yml](./assets/agent-workflow-kit-update.yml).
- **Opt out** — do not create a GitHub workflow, branch, or pull request.
- **Ask later** — do not create a GitHub workflow, branch, or pull request; explain that re-running `setup-workflow` can offer it again.

This workflow opt-in has its own file-level idempotency rule: if the destination is already present, leave it byte-for-byte unchanged and report `skipped (already present)`. On repeated setup runs, do not prompt again when it exists. The workflow consumes the scoped `@ikon85/agent-workflow-kit` release and its existing parity-checked transactional update command; do not reproduce either mechanism in setup prose or shell steps.

For GitLab, local, other, or an unknown provider, give only a provider-neutral explanation that automatic updates require provider-specific CI and pull-request support; **do not create a GitHub workflow**. Setup itself never creates the update branch or pull request — only an opted-in workflow run may do that later.

**Conditional board-write note (only when the GitHub tracker uses a managed board):** if Section D ends with `board-sync.md` at `mode: github-projects-v2`, add one line to `issue-tracker.md`: *"Board writes (item-add, status/wave/cluster field edits, sub-issue links) go through the board-sync helper, not bare `gh issue create`/`gh project item-*`."* Do **not** add this for GitLab, local, other, or `mode: none`.

### 2b. Section A3 — Optional project census

> A project census is an optional, consumer-owned map that counts product
> surfaces and lists behavior families separately. It can make later plans and
> handoffs more complete, but setup cannot honestly claim coverage before the
> repository has been scanned and verified.

Read [census.md](./census.md) in full before presenting the choice. If
`docs/agents/census.md` already records `yes`, `later`, or `no`, adopt that
choice and do not prompt again on an ordinary setup rerun. Also adopt an
existing, explicitly documented census path. If no choice exists, ask in plain
language: *"Should setup prepare the optional project census now?"* Offer
exactly:

- **Yes** — create or adopt the project layer and minimal enabled profile, run
  only the shipped self-test, and report the honest `bootstrap` / "not yet
  meaningful" state. Do not scan, activate, or install a hook or gate.
- **Later** — record a deferral. Create no census profile, hook, or gate; a
  later explicit `census-update` invocation may activate without setup.
- **No** — record the opt-out as `disabled`. Create no census profile, hook, or
  gate and do not prompt again unless the user explicitly changes the choice.

Use the complete `missing / yes / later / no / existing / explicit-enable /
disable` matrix in the seed. A later explicit `census-update` invocation may
activate without rerunning setup. Disable enforcement first, but retain every
consumer-owned profile, scanner, test, and active snapshot unless the user
separately approves deletion. Repeated runs are no-ops after reconciliation.

### 2c. Section A4 — Optional Worktree Lifecycle

> Worktree Lifecycle is one consumer capability for isolated setup, shared
> branch/worktree facts, enforcement, handoff, and safe cleanup. The profile is
> tracked and consumer-owned; hook wiring activates only after an explicit yes.

Read [worktree-lifecycle.md](./worktree-lifecycle.md) in full. Reconcile the
complete `yes / later / no / existing / disable` matrix from its structured
contract. If no choice exists, ask: *"Should setup activate the portable
Worktree Lifecycle for this repository?"* Offer exactly **Yes**, **Later**, and
**No**.

- **Yes** — create or deepen only the `worktreeLifecycle` section in
  `docs/agents/workflow-capabilities.json`, preserve every other section and
  unknown key, and reconcile only the exact kit-owned hook commands listed in
  the seed.
- **Later / No** — record the choice in the tracked profile without installing
  hook wiring. Ordinary reruns do not ask again.
- **Existing** — adopt the current section and wiring without normalizing
  consumer-owned values.
- **Disable** — remove only the exact kit-owned hook commands first, then set
  `enabled: false`; retain the profile, setup policy, and unknown keys.

The default setup entry is
`python3 scripts/worktree-lifecycle/setup.py`; a proven consumer-native helper
may remain the configured `setupEntry` for parity. The handoff advisory always
reads that configured entry and never hardcodes a project script.

### 2d. Section A5 — Optional Memory Lifecycle

> Memory Lifecycle keeps project memories inside consumer-owned roots and makes
> restore operations previewable, collision-safe, and reversible. The policy
> templates become fully consumer-owned after their first seed.

Read the `memoryLifecycle` section of
`docs/agents/workflow-capabilities.json` before offering anything. Missing or
disabled configuration remains unchanged on an ordinary setup rerun. An
existing enabled section is adopted byte-for-byte; preserve unknown profile
keys, placement/retention settings, restore grants, and consumer-specific memory
rows.
If no section exists, explain the capability and offer an explicit opt-in. Only
an affirmative consumer decision may run:

```bash
node scripts/memory-lifecycle/setup.mjs --enable
```

That command adds the minimal enabled section while preserving every existing
top-level profile key, sets restore and pruning approval to `false` unless the
consumer already recorded values, and seeds
`meta_decision_layer_choice.md` plus `meta_memory_lifecycle.md` into the
configured active root exactly once. Existing files are adopted and never
overwritten. The profile's `templatesSeeded` marker transfers full ownership:
later setup runs do not recreate a template the consumer edited, moved, or
deleted.
Choosing later, declining, or merely running `init`, `update`, or ordinary
`setup-workflow` performs no Memory Lifecycle write and never changes
activation, roots, retention, restore, or pruning grants. Template files have
no kit-managed or `append-managed` region; a future bounded-region contract
requires a separate decision.

### 2e. Section A6 — Optional Workflow Advisories

> Workflow Advisories provides non-blocking, low-noise hints and
> affected-surface checks around large reads, first-impacting edits, refactors,
> and Stop. Paths, commands, thresholds, timeouts, and output budgets remain
> consumer-owned.

Read [workflow-advisories.md](./workflow-advisories.md) in full. Reconcile its
complete `yes / later / no / existing / disable` matrix. If no choice exists,
ask: *"Should setup activate the portable Workflow Advisories for this
repository?"* Offer exactly **Yes**, **Later**, and **No**.

- **Yes** — reconcile only `workflowAdvisories` in the shared capability
  profile and only the exact kit-owned hook commands named by the seed.
- **Later / No** — record the choice without hook wiring.
- **Existing** — adopt profile and wiring byte-safely.
- **Disable** — remove exact kit-owned commands first, then set `enabled:
  false`; preserve every profile value and unknown key.

### 2f. Section A7 — Optional Safety Guardrails

> Safety Guardrails is a counted group of seven independently selectable
> protections: four agent-tool guards and three repository-security
> capabilities. Setup stages and validates the chosen profile plus wiring
> before activation; disabled rows remain exact no-ops.

Read [safety-guardrails.md](./safety-guardrails.md) in full. Reconcile its
complete `yes / later / no / existing / disable` matrix. If no choice exists,
ask: *"Should setup configure the portable Safety Guardrails for this
repository?"* Offer exactly **Yes**, **Later**, and **No**.

- **Yes** — ask which of the seven counted rows to enable, then reconcile only
  `safetyGuardrails`, exact selected Agent-hook commands, and the selected
  native Git-hook path. Report `N of 7 enabled`.
- **Later / No** — record the choice without Agent- or Git-hook wiring.
- **Existing** — adopt profile and wiring byte-safely; preserve unknown keys
  and consumer-specific policies.
- **Disable** — remove only exact kit-owned Agent commands and Git wiring
  first, then set `enabled: false`.

The seed's reference consumer uses the parity-on profile. Other consumers are
opt-in/manual: never copy its package-manager, path, shim, surface, or outage
decisions without repository evidence and user confirmation.

### 2g. Section A8 — Advisory kit-origin edit hint (non-interactive)

> The shipped kit-origin hook asks the upstream-or-own question before an agent
> Edit/Write changes a file recorded with `origin: "kit"` in the consumer
> manifest. It is advisory only: it never blocks, reads the manifest once, uses
> no network, and silently fails open when the manifest cannot be read. Shell
> redirection, formatters, and IDE edits are knowingly outside its coverage; the
> skills remain the rule's primary carrier.

Activate the shipped hook by reconciling this exact entry into
`.claude/settings.json`:

```json kit-origin-edit-hook-settings
{
  "matcher": "Edit|Write",
  "hooks": [
    {
      "type": "command",
      "command": "python3 \"$CLAUDE_PROJECT_DIR/.claude/hooks/kit-origin-edit-hint.py\""
    }
  ]
}
```

This is an additive, idempotent settings edit, not a settings rewrite:

1. Missing settings → create `{ "hooks": { "PreToolUse": [<entry>] } }`.
2. Existing valid settings → preserve every consumer key, matcher, command,
   hook event, ordering, and formatting byte-for-byte; append only `<entry>` to
   `hooks.PreToolUse`.
3. If any existing hook already contains the exact command above, do nothing,
   regardless of its surrounding matcher. A rerun must be byte-identical.
4. Unreadable/invalid settings, or a non-object `hooks` / non-array
   `PreToolUse`, are consumer-owned conflicts: leave the file untouched and
   report the skipped activation. Never replace or normalize them.

### 2h. Section A9 — Agent surfaces and switching autonomy

> Routing setup asks which familiar agent apps you use and whether the Kit may
> switch between them. Surface adapters establish providers, transports,
> selectors, and enforcement capabilities; the default interview never asks
> the user to describe those technical facts.

Read the versioned agent-surface registry and detection result. Show its
multi-select labels with detected entries preselected; never embed a separate
list in prompt prose. Then ask only one plain-language autonomy question:

- **Switch automatically** — record `automatic`.
- **Ask before switching** — record `ask`.
- **Stay in the current app** — record `current-surface-only`.

When exactly one surface is selected, skip the autonomy question and use
`current-surface-only`. Show an activation summary with explicit **Back**,
**Advanced**, **Approve**, and **Safe current surface** actions. Back revisits
the simple choices. Advanced is the only flow that may collect model
preferences or optimization overrides, but those values remain a draft and
return to the activation summary; Advanced alone never writes. Only a later
Approve or Safe current surface action activates the draft. Safe current
surface activates the selection with `current-surface-only`.

Store the answer through `src/lib/routingProfile.mjs` in its user-local state
location, outside the consumer repository and package manifest. Never print
credentials or derive personal choices from detected transports. A valid
existing profile is terminal and reports `still valid`; do not prompt again.
Missing or invalid profiles receive one migration interview. Reconcile a
materially stale profile, a removed route, or a newly detected meaningful
surface with a typed delta that names only the changed choice and preserves
unaffected surfaces, autonomy, and advanced values. Re-read the profile before
activation and use its fingerprint plus the exclusive profile lock; a
concurrent user-local change blocks activation and remains byte-preserved.

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

**Map the status roles (`fields.status.roles`):** the seeded map carries the recommended English stage names (`Idea/Triaged/Spec/In Progress/Review/Done`). Reconcile it against the **discovered** Status option names: an exact (case-sensitive) match keeps its seeded entry; for every role whose seeded name is NOT among the discovered options, ask the user which of their actual option names plays that role (a stage they don't have may be omitted from the map — say so). Never guess a mapping from similarity. Finish with a validation pass: every role value in the map MUST appear in `fields.status.options`, else fix before writing `state=filled`.

**Fallback (the single catch-all — no board / >1 / ambiguous / scope error / read failure):** do **not** auto-create a board (`gh project create` alone cannot provision the Status options + workflow fields a board needs). Write `board-sync.md` with `state=stub`, `mode=github-projects-v2`, and inline **instructions**: which fields the workflow profile needs (a Status single-select with your stage options; optionally a Wave number, a Cluster text, a Spec-Path / Plan-Path text), how to create the board in the GitHub UI / `gh`, and "then run `/setup-workflow` again — it will discover and fill the IDs." Retryable.

**Optional — Phase field + saved Views (Program route only):** never
auto-discovered or auto-created, unlike the fields above — a Phase field's
option set is plan-specific. If this project plans to use the Program route
(`scale-check` → `to-issues` with explicit Program identity → internal graph
validation), point the user at the seeded [board-sync.md](./board-sync.md)'s
"Optional: the Program route" section for the `gh project field-create`
command, the optional `fields.phase` / `labels.programType` profile keys, and
the two saved Views to create by hand.

### 6. Section E — Spec-layer seeds (non-interactive)

These are **structured-but-empty** crusts that `/retro` grows; do not ask the user to fill them now.

- `docs/agents/skills/spec-self-critique.md` — seed the 12 per-point headings from [spec-self-critique-seed.md](./spec-self-critique-seed.md) so `/retro` has stable append anchors and `spec-self-critique` finds its project layer (suppressing the "layer absent" warning) without inventing project content.
- `docs/agents/skills/orchestrate-wave.md` — seed the named `§`-section headings from [orchestrate-wave-seed.md](./orchestrate-wave-seed.md) so the `orchestrate-wave` skill's Phase-0 probe finds its project layer. The sections ship **empty** (the exact commands / tunnel / login can't be guessed) → the skill treats an unfilled seed as "layer absent" and runs its generic fallback until the project fills them. A filled section is a manual project-maintenance edit, not something this run invents.
- `docs/conventions/spec-completeness.md` — seed **one valid** `## Self-Critique-Check` block (Trigger/Check/Korrektur) from [spec-completeness-seed.md](./spec-completeness-seed.md). A convention file *without* a valid block makes `spec-self-critique` point 8 warn — an empty file is worse than none.

> **Handoff drift-guard (`.claude/hooks/drift-guard.py`).** The repo ships a PreToolUse hook that blocks a `.handoff/*.md` Write when the linked issue's rooted graph is not execute-ready (it delegates all coherence to `scripts/execute-ready-check.py --mode handoff`). It self-filters to `.handoff/*.md` and fires **only once handoff docs exist** — a freshly scaffolded project carries the guard but has nothing to guard yet (silently inoperative until the first `.handoff/` write). This scaffold only **documents** the interplay; it does **not** build new mechanics. Once the project starts emitting handoffs, writes land in `.handoff/` and the guard activates automatically.

### 7. Section F — Workflow overview

> The workflow overview is a short entry-point map: which skill to start with for a feature, ready plan, bug, implementation slice, or finished branch. It should stay generic; the detailed mechanics live in the individual skills and the project-layer docs.

Seed `## Workflow` from [workflow-overview.md](./workflow-overview.md) when the target CLAUDE.md/AGENTS.md file has no `## Workflow` block. If a `## Workflow` block already exists, leave it untouched and report `skipped (already present)`; it is likely repo-specific.

### 8. Section G — Deploy target

> `wrapup` and live-verify reference where this project deploys (host, command, URL). It lives in the `## Prod` block of CLAUDE.md/AGENTS.md, not a separate file.

First run `node scripts/readiness.mjs check --skill wrapup --json`. If
`prodTarget` is `ready`, adopt the evidence, clear any superseded pending
decision with `node scripts/readiness.mjs decision clear prodTarget`, and do
not ask again. Malformed or divergent `## Prod` evidence is `invalid`: leave
all instruction files untouched, show the conflict, and stop this section
until the user resolves it.

For a missing or pending target, ask where this ships, how it is deployed, and
what the live URL is. Offer only the bounded choices permitted by the readiness
catalog:

- **Configure now** — collect a non-empty host/platform, deploy command or
  trigger, and live URL. Preview the exact local `## Prod` replacement for
  every applicable existing Claude/Codex instruction surface and obtain
  approval before writing it. Any external mutation retains its own separate
  preview and approval; approving the local block never approves repository,
  hosting, DNS, or deployment changes.
- **Configure later** — run
  `node scripts/readiness.mjs decision set prodTarget pending`; create or alter
  no `## Prod` block, and report exactly:
  `wrapup.deployReport omitted (prodTarget pending)`.
- **Not applicable** — offer only when the manifest catalog entry has
  `allowNotApplicable: true`; record it with `readiness.mjs decision set` and
  deactivate the dependent block (or the whole skill when the declaration
  requires the capability). `prodTarget` does not permit this choice, so never
  offer it for Prod.

Ready and terminal `not-applicable` choices are not re-asked. A pending choice
remains deliberately retryable so a later `setup-workflow` run can take the
Configure-now path. Never invent a deploy target.

### 8b. Section H — Size-Profil (optional LoC-offender gate, non-interactive)

> **Optional, opt-in.** The kit ships a LoC-offender drive gate (`scripts/loc_offender_gate.py`) — a stdlib-only helper that flags files over a line threshold (e.g. wire it into a pre-push hook). It reads a **single threshold SSOT**: `maxLines` in `max-lines-allowlist.json` at the repo root. Seeding that file is harmless even if you never wire the gate; without it the gate has no profile to read. (The SSOT repo additionally enforces the same threshold as a project-specific test-runner fitness check — that check is **not** shipped; the portable gate is the Python helper above.)

Seed `max-lines-allowlist.json` **only if absent** (never overwrite — its `offenders` array is curated debt):
```json
{
  "maxLines": 300,
  "vendored": [],
  "offenders": []
}
```
Adjust `maxLines` only if the consumer asks for a different line limit. `vendored` = permanently-exempt third-party primitives; `offenders` = the shrinking known-debt set (files already over the limit at adoption). Report `created · skipped (already present)`.

### 8c. Section I — Code-review project layer (non-interactive)

> The `code-review` skill's Standards axis reads a project layer for exactly which docs count as this repo's conventions, and how the method relates to any other review tooling already running here. Seed it so the skill resolves that directly instead of guessing at the repo root.

Seed `docs/agents/code-review.md` from [code-review.md](./code-review.md) — the same structured-but-empty philosophy as Section E: the two headings ("Standards sources in this repo" / "Adjacent review tooling") ship complete, but filling in this repo's real values is a manual edit (or a later pass), not something this run invents. Write at `state=filled` — the scaffold itself is the finished deliverable; nothing is pending from `/setup-workflow`'s side.

### 8. Write

For each `docs/...` file: obey the idempotency contract (the "Idempotency contract" section). Prepend the sentinel with the resolved `state` (and `mode` for board-sync).

For `docs/agents/census.md`, seed [census.md](./census.md), prepend the normal
sentinel, and record the selected choice directly below it as
`<!-- census: choice=<yes|later|no> -->`. On adoption, also record the discovered
repository-relative profile and active-snapshot paths. Never overwrite a
pre-existing consumer-owned census file. `yes`, `later`, `no`, and an adopted
existing census are terminal for ordinary setup reruns. Only an explicit user
request changes a recorded choice.

For `docs/agents/workflow-capabilities.json`, reconcile only each selected
capability section. Never replace the whole file: Project Release, Memory
Lifecycle, Worktree Lifecycle, Workflow Advisories, Safety Guardrails, future sections, and
unknown consumer keys share this profile. Apply the transition and hook
ownership rules from [worktree-lifecycle.md](./worktree-lifecycle.md),
[workflow-advisories.md](./workflow-advisories.md), and
[safety-guardrails.md](./safety-guardrails.md) transactionally.

For Memory Lifecycle, use only the deterministic setup helper from Section A5.
Do not copy templates with shell commands or edit the capability profile by
hand. Report `seeded · adopted · skipped`; do not print memory contents or
receipt contents.

For `.claude/settings.json`, run the Section A8 reconciliation on fresh and
already-initialized consumers. Report `activated · already active · skipped
(consumer-owned conflict)`. Do not make the hook conditional on an optional
capability choice: its self-filtering, fail-open behavior keeps it inert except
for matching kit-origin Edit/Write events.

For the **`## Workflow`**, **`## Agent skills`**, and **`## Prod`** blocks, reconcile per section in **both** CLAUDE.md and AGENTS.md that exist:

- If **both** files exist → write/update the block in **both** (keep them coherent — Codex is a first-class surface).
- If **one** exists → that one.
- If **neither** exists → ask the user which surface(s) to create (**default `CLAUDE.md`**), then write there.
- If a `## Workflow` block already exists → skip it; this block is often repo-specific.
- If an `## Agent skills` / `## Prod` block already exists → update its contents in-place; never duplicate or clobber surrounding user content.
- For Configure now, apply the approved `## Prod` preview to every applicable
  existing surface as one coherent local change. Preserve each file's
  `## Workflow` and `## Agent skills` blocks byte-for-byte, including spacing,
  and leave all unrelated setup blocks untouched. Re-read every written Prod
  body and run `node scripts/readiness.mjs check --skill wrapup --json`; all
  surfaces must agree and `activeBlocks` must be exactly `["deployReport"]`.
  Only then clear a prior `prodTarget` decision. A partial write is not ready:
  restore the previewed surface set before reporting the section complete.

`## Workflow` block:

Use [workflow-overview.md](./workflow-overview.md) verbatim as the generic seed.

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

`## Prod` block (only if Section G's Configure-now path produced a deploy target):

```markdown
## Prod

[host / platform], deployed via [command/trigger]. Live: [URL].
```

### 9. Done

Report the per-file outcome (`created · filled · skipped`), which surface(s) you wrote the blocks to, and which skills now read the layer. Note the user can edit `docs/agents/*.md` directly later, and that `/retro` grows the spec-layer seeds over time. Re-running this skill only fills what is missing or `state=stub`.
