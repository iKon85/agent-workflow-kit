---
name: retro
disable-model-invocation: false
description: Use when the user explicitly asks for a retro after a session with PR-activity. Analyzes session friction and proposes concrete config mutations (Memory/Skill/CLAUDE.md/Hook) with per-patch approval. No file is written — findings live in the mutated config.
---

# Retro — In-Session Deep-Dive

Trigger: user types `/retro` (optionally with a PR/Issue number, e.g. `/retro 274`).

## What this skill does

A retro is a session-contained vehicle for surfacing friction and turning it into concrete config improvements. The retro itself is NOT a persistent artifact — the artifact is the **change** to Memory, Skill, CLAUDE.md, or a Hook. If nothing should change, nothing is persisted.

## Symmetry Principle (mandatory)

**Retro input = user friction + agent friction. Both equally weighted.**

The user describes their pains in plain language. The executing agent contributes its own session pains from the tool-call trace in parallel. **Both** go through the analysis pipeline. The agent analyzes (root cause + config component) and proposes measures. The user votes per patch.

The retro is never just "agent asks user about friction". That would be the wrong entry point — the user often only sees symptoms, while the agent sees the real tool-call failures, memory stalls, hook misses, and skill conflicts in the trace.

## Why this exists

Two purposes:

1. **Feature-level learning** — capture friction while it is fresh so the same trap is not stepped into next session.
2. **Config-health surveillance** — accumulate evidence that a CLAUDE.md rule, Skill, Memory note, or Hook is outdated, missing, or actively in the way. Each retro is the trigger source for incremental config cleanup.

The previous file-based workflow (`pr-retro-stub.py` hook + filled retro files in `.claude/retros/` + batch-PR) was removed because filed retros are read by no one — only the config mutations matter.

## Process

### 1. Detect PR context

Two signals:

- **Branch-Pattern:** Run `git branch --show-current`. If it matches `feat/<N>-…` / `fix/<N>-…` / `chore/<N>-…` / `docs/<N>-…`, the issue number is `<N>`.
- **Skill-Argument:** if the user typed `/retro <num>`, that number wins over the branch.

If neither yields a number, ask the user:

> "No PR context detected — run the retro anyway? If yes, give me the issue/PR number or say 'none'."

User may skip (silent exit), give a number, or say "none" (proceed without a PR/issue anchor).

### 2a. User friction probe (one question, outcome language)

Ask exactly:

> "Was there friction in the session? If yes, in 1-2 sentences: what was it?"

A plain-language description is expected ("worktree setup is annoying", "LSP is acting up"). It is the **agent's job** to derive the technical root cause + config component from it — the agent should NEVER ask the user for that.

### 2b. Agent friction self-probe (mandatory, parallel to 2a)

The executing agent scans the session itself for friction. Mandatory checklist:

- Which tool calls failed or had to be retried? (permission denials, edit-before-read errors, bash-pipe aborts)
- Which memories turned out to be stale on inspection? (content contradicts today's code)
- Which pre-commit/hook checks needed workarounds?
- Which skill steps contradicted CLAUDE.md? (e.g. a plugin skill says npm install, CLAUDE.md says pnpm)
- Which bash calls ran with CWD drift / sequential permission approval / missing absolute path?
- Which `<system-reminder>` spam patterns recurred?

Mark own findings explicitly as **"<Agent>-Finding: …"** in the output, on equal footing with user findings. Examples: **"Codex-Finding: …"** on Codex, **"Claude-Finding: …"** on Claude.

### 2c. Memory sweep probe (mandatory if threshold breached — only if a memory directory exists)

First check existence — consumers without Claude auto-memory (e.g. a pure Codex install) have no memory directory. Derive the path portably (project slug = absolute main-tree path with `/`→`-`; worktree-safe via the git common dir, fallback `pwd`):

```bash
PROJ_ROOT=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | xargs -r dirname)
MEMDIR="$HOME/.claude/projects/$(printf '%s' "${PROJ_ROOT:-$(pwd)}" | tr '/' '-')/memory"
test -d "$MEMDIR" && echo present || echo absent
```

Directory missing → one sentence in the output: "Memory sweep probe: no memory directory (no Claude auto-memory) — skipped." No patch proposal, step counts as satisfied. Otherwise continue:

Count empirically — active memory set + index size:

```bash
ls -1 "$MEMDIR/"*.md | grep -v '/MEMORY\.md$' | wc -l
wc -l "$MEMDIR/MEMORY.md"
```

Threshold trigger (either is enough):
- Active memory set ≥ 65 files (sweep trigger above the CLAUDE.md target "active set <35" — fires only on real bloat, not a healthy-but-full set; tuned across retros)
- MEMORY.md > 120 lines

If the trigger is breached:
- One sentence in the output: "Memory sweep probe: N active memory files, X lines MEMORY.md — over the token-hygiene target (<35 files)."
- Include a config patch proposal in step 3:
  "Patch X — memory set over <35. Identify + delete stale/completed memories (prune-on-touch). Check content before every deletion; move deleted memory files to `archive/` (instead of hard-deleting) so recovery stays possible. **Affects:** memory · **Weight:** low (hygiene, isolated)."
  Like every step-4 patch, this one also carries the `Affects / Weight` line (3b/step 4).

If 0 triggers:
- One-liner in the output: "Memory sweep ok (N files / X lines)."
- No patch proposal.

**Skip allowance:** only when the memory directory is missing (see above) — otherwise none, the sweep probe runs on every retro.

**Why here (mandatory step, not just memory):** memory is passive (only fires if the agent thinks of it); `/retro` runs routinely after PR activity and is the natural enforcement vehicle. The entry must happen BEFORE the symmetric analysis so it can flow into the process as a patch proposal if needed.

**Threshold tuning:** sweep trigger = ≥65 files / >120 lines MEMORY.md (target stays "active set <35", trigger sits with headroom above it so healthy-full sets don't fire on every retro); threshold tuned upward across retros — raise further on the next empty-handed hit.

### 3. Symmetric analysis (agent, on its own)

For **every** friction point (user-reported AND self-found), the agent analyzes:

- **Root cause:** which tool call / memory / hook / skill was concretely involved?
- **Config component:** which mutation would prevent it next time? (memory / skill / CLAUDE.md / hook / helper script / issue / nothing)
- **Repeatable or one-off?** One-off incidents → no patch needed.

If the user's description in step 2a is ambiguous, the agent may ask **ONE** clarifying outcome question — e.g. "where was it most annoying — during setup, mid-work, or during cleanup?". Never multiple-choice with memory names, hook paths, or config classes.

### 3b. Determine target + weight (threshold ladder)

Before formulating a patch in step 4, place **every** friction point on the threshold ladder. **Weight** = how durable/far-reaching the rule is (drives the visible patch line in step 4 + the user's approval depth). **Target** = where the patch physically goes.

| Weight | Target (tier) | When |
|---|---|---|
| **high** | CLAUDE.md / hard rule (or durable hook) | durable + cross-cutting + **incident-backed**; applies **across all phases** (even without a spec — during build, git, deploy) |
| **medium** | `spec-self-critique` (project check) | recurring **spec-structural** defect, **catchable from the spec before building** |
| **low** | Memory | isolated infra/domain gotcha (a fact to recall, not a pattern) |
| **minimal** | Inline note / "nothing" | one-off, no pattern, no durable config artifact |

**Domain/glossary gap** (the defect sits in the **grill input**, not the spec structure — a term was fuzzy/missing before a spec even existed) → target `CONTEXT.md` / `docs/adr/`, **weight medium**. This way learning findings reach the **plan START** (what `grill-with-docs` reads) for the first time, not just the spec gate. Boundary to `spec-self-critique` (also medium): that one holds a **structural** spec defect; this one a **substantive** domain/term gap.

**Borderline high vs medium — two-stage test (CLAUDE.md vs `spec-self-critique`):**
1. **Phase reach first:** "Would looking at the SPEC *before* building have prevented the friction?" → **Yes** = spec quality hole → `spec-self-critique` (medium). → **No, applies always/cross-phase** → CLAUDE.md candidate.
2. **Incident gate for the high tier:** CLAUDE.md / hard rule **only** if durable + cross-cutting + **went wrong for real at least once** (incident-backed). A pure one-off observation without recurrence → downgrade to memory/inline, **not** a hard rule.

**Borderline medium vs low:** when in doubt, **medium** wins (an active spec gate beats passive memory recall) — a spec-structural finding mis-routed to `low`/memory sits in passive recall and **never** fires again at the next spec, while a medium finding in the `spec-self-critique` layer fires guaranteed.

**Tier says roughly where, class says which file.** For a **skill** target, the class routing in step 4 ("class first") decides **which** file — e.g. a "medium → `spec-self-critique`" patch (published class) lands in the **project layer** `docs/agents/skills/spec-self-critique.md`, not the scaffolding.

**A GitHub issue is NOT a weight tier.** A real follow-up = work to track → `python3 scripts/board-sync.py create` (step-4 table), **orthogonal** to the ladder; its "weight" follows the follow-up scope. The ladder classifies **config patches**, not "turn it into a ticket".

**Kit-repo routing target (always ask; never automatic).** When a finding lands on a kit-shipped file (a consumer-manifest entry with kit origin), ask whether the improvement is generic or project-specific. For a generic improvement, offer to file a lightweight issue against the public kit repo: a title plus a short body that states the finding, affected file, and why it is generic. For a project-specific improvement, recommend `own` (keep it consumer-owned). The consumer user does not need to be the kit maintainer.

Before any `gh issue create --repo iKon85/agent-workflow-kit` runs, show the user a **sanitized preview** of the exact title and body with consumer identifiers and secrets stripped. Create the issue only after the user explicitly approves that exact text; if the title or body changes, show the revised preview and ask again. This approval is additional to the per-patch approval in step 5.

**Target missing in the project — separate two cases cleanly:**
- **(a) Tier skill missing entirely** (e.g. a foreign project without `spec-self-critique`): no durable spec-time gate exists. **Memory is NOT a substitute** — passive recall doesn't catch a recurring spec defect before building. Report honestly: *"this project has no durable target for this tier"* + propose a `/setup-workflow` follow-up. **No fake guard via memory.**
- **(b) Skill exists, project-layer file missing** (`docs/agents/skills/<skill>.md`): **create / append** — that is the normal retro-sink behavior that `spec-self-critique` step 0 expects anyway. **No** downgrade.

### 4. Patch proposals (concrete recommendation, no multiple-choice with tech refs)

**Generalization check FIRST (mandatory, before formulating) — class, not symptom.** Before cutting a patch, abstract one level up: *"What is this incident an EXAMPLE of?"* The patch covers the **class / principle** (every scenario where the same mechanism bites) — the concrete incident is only the **example**, not the scope. Symptom-tight patches (exactly-this-one-trigger) miss the next variant of the same class, forcing the user to steer again. **BUT class ≠ speculation:** only include **verified** members of the class (verify-first), structure it **extensibly** instead of stuffing in unproven patterns — too broad (unverified) is the same mistake as too narrow, just inverted. (retro: an over-narrow symptom patch was widened to the correct class, while an unverified pattern was deliberately left out.)

For every friction point: the agent formulates **one concrete recommendation** with a short rationale in plain language. Format:

> **Patch X — [one line: what].**
> **Why:** [one line, why it removes the friction].
> **What changes:** [one line, visible effect].
> **Affects:** [target in plain language] · **Weight:** [high / medium / low / minimal] — [short rationale from the ladder (3b)].

**Every patch carries the `Affects / Weight` line** (from 3b) — including the memory-sweep patch from step 2c (Affects: memory · Weight: low). The weight drives approval depth: "high / CLAUDE.md" = durable always-on rule, worth more scrutiny; "minimal / inline" = throwaway. Wording in plain language (no tech jargon in the user-facing view).

Optionally present the diff/script/edit as a code block (for visual review), but NOT as a multiple-choice option with tech vocabulary.

Possible mutation targets (internal for Claude, do NOT list in user-facing output):

| Mutation type | Where |
|---|---|
| New/changed memory note | `~/.claude/projects/<project>/memory/<slug>.md` (plus update the `MEMORY.md` index) |
| CLAUDE.md rule adjustment | `CLAUDE.md` (Hard Rules section) |
| Skill improvement (generic/portable) | `.claude/skills/<skill>/SKILL.md` |
| Project-specific skill lore (`generic`/`vendored` skill) | `docs/agents/skills/<skill>.md` (project layer) |
| New/changed hook | `.claude/hooks/<name>.py` + test |
| New helper script | `scripts/<name>.sh` (+ tracked `.claude/settings.json` allowlist —: `.local.json` doesn't propagate to worktrees) |
| New GitHub issue | `python3 scripts/board-sync.py create` |
| "Do nothing" | one-off incident, no recurrence risk |

**Skill patch routing (class first).** If a patch targets a skill, FIRST read `.claude/skills/skill-manifest.json` **best-effort**. Published classes (`generic`/`vendored`): **project-specific** lore → `docs/agents/skills/<skill>.md` (project layer), **generic/portable** improvement → `.claude/skills/<skill>/SKILL.md`. `project-private`: the skill dir is fine. **Manifest missing** (foreign install) → safe default: lore goes to `docs/agents/skills/<skill>.md`, NEVER into a published skill dir. (Keeps published skills self-contained; e.g. `spec-self-critique` is `generic` → its project-specific checks belong in the project layer, not the scaffolding.)

### 5. Per-patch approval (yes / no / modify)

Per patch:

> "Patch X — [what line]. Apply? (Yes / No / Modify)"

<!-- mirror-xform:start codex-user-input-mechanism -->
Use `AskUserQuestion` with ≤3 options. Option labels in plain language, **never memory slugs or hook paths in the labels**. On "Modify", ask in plain language what should be different.
<!-- mirror-xform:end -->

### 6. Implementation

For each approved patch, execute the mutation immediately (Edit / Write / Bash). Do NOT batch — apply one at a time so the user can interrupt.

### 7. Exit

The retro is **opt-in** (user triggers `/retro`); it is **offered before PR creation**, never enforced. If done, it happens before the PR (not after merge). After all patches:

1. Summarize in 2-3 sentences what changed + what was deferred.
2. Fold a **`## Retro / Meta-Findings` section into the PR body** — into the PR still to be created, or via `gh pr edit` if already open: the honest friction analysis (user **and** agent findings) + the applied patches.
3. Repo file patches (CLAUDE.md/hook/skill/script) get **committed as part of the slice PR**; memory patches are filesystem-only (not in the PR).

Never create a file in `.claude/retros/`.

## What NOT to do

- **Do NOT create files in `.claude/retros/`.** The directory is historical archive only.
- **Repo file patches belong in the slice PR** (the retro runs BEFORE PR creation) — commit them + add findings as a meta section in the PR body. Only memory/filesystem patches stay uncommitted.
- **Do NOT skip the friction probe.** If you don't ask explicitly, you may silently invent friction that wasn't there.
- **Do NOT propose patches without user approval.** Every config mutation gets explicit yes/no.

## Format conventions

- German prose for user-facing questions and summaries (project convention).
- Correct umlauts (ä, ö, ü, ß — never ae/oe/ue/ss in prose).
- File links as `[name](path)`, clickable in <maintainer>'s VS Code.
