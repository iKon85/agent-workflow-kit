---
name: audit-skills
disable-model-invocation: true
description: "Audit the project's own skills for drift from code/doc reality and fix it — the anti-drift learn step. Run at retro, periodically, or when a drift-hint warns a skill's declared source moved since its last touch. Fans out one read-only research subagent per skill, re-verifies each reported drift before editing (the auditor produces false positives), and fixes by content type. Triggers: audit the skills, skill drift, stale skill, skill points at a dead path or renamed symbol."
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill audit-skills --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# audit-skills — Skill freshness audit (anti-drift)

A reusable recipe for checking the project's own skills against code/doc reality
and keeping them fresh. Skills rot in every repo: a refactor moves a file, a
symbol is renamed, a line number shifts — and the SKILL.md that named it now
lies. This is the **learn** step of the plan → execute → land → learn line: the
skills the other steps rely on drift, and nothing fixes them unless a recipe does.

## When to run

- At `/retro` (a periodic hygiene point).
- When the SessionStart drift-hint hook (`.claude/hooks/skill-drift-hint.py`)
  warns that a declared source moved in git since the skill's last touch.
- Ad-hoc, when a skill you just reached for points at a dead path or a renamed
  symbol.

Not for: rewriting a domain skill's content on demand (that is the skill itself),
or auditing application code (a code review or a diagnosis does that).

## Readiness preflight — first

<!-- readiness:optional-preflight:start -->
Before enumerating skills, launching research subagents, or editing any skill,
run this once from the project root:

```bash
node scripts/readiness.mjs check --skill audit-skills --json
```

- `ready`: continue silently with the generic audit and the active
  `projectChecks` block.
- `degraded`: keep the generic audit active, omit only `projectChecks`, and emit
  exactly one concise summary: `Readiness degraded — inactive block
  projectChecks (auditSkillsLayer: <state>). Run /setup-workflow, configure
  docs/agents/skills/audit-skills.md, then rerun this skill.`
- `blocked`: stop before continuing and report the non-ready required capability
  plus the exact `/setup-workflow` recovery path.
- Invalid evidence is always visible in that one summary; never interpret it as
  an opt-out or invent project checks.
<!-- readiness:optional-preflight:end -->

<!-- readiness:block projectChecks -->
When `projectChecks` is active, read
`docs/agents/skills/audit-skills.md` and apply its concrete class assignments,
project-specific guard commands, and drift checks in addition to the generic
recipe below.
<!-- readiness:end -->

## Standing guards (run without this audit)

Two automatic nets catch the most common drift classes before an audit — this
recipe complements them, it does not replace them:

1. **A skill-sync test** — for any un-guessable enumeration a skill documents (a
   status→bucket map, a design-token list), a test parses the value out of the
   SKILL.md and asserts equality with the code constant. Drift breaks the build.
   Run the concrete tests available in the repository.
2. **The drift-hint hook** (`.claude/hooks/skill-drift-hint.py`) + a per-skill
   `SOURCES.txt`: at SessionStart it flags any skill whose declared source file
   is newer in git than its SKILL.md.

**Core insight:** test-covered values do NOT drift silently — only un-tested
prose refs (paths, line numbers, cross-refs, memory keys) rot. So: test-cover the
high-value un-guessable enumerations (guard 1); audit everything else
periodically (this recipe).

## The SOURCES.txt convention

Each drift-prone skill declares its code/doc anchors in a co-located
`SOURCES.txt` next to its `SKILL.md`:

- one repo-relative source path per line;
- `#` comments and blank lines are ignored;
- the drift-hint hook compares each source's last-commit time against the
  SKILL.md's — a source committed *after* the skill means the skill may be stale;
- committing (touching) the SKILL.md resets the signal — that is how you
  acknowledge that you re-checked it.

When a confirmed fix introduces a new source file or replaces an old one, update
that skill's `SOURCES.txt` in the same change — otherwise the hook keeps pointing
at dead anchors, or misses the new source.

## Recipe

### 1. Enumerate the skills — three audit classes

Do NOT hardcode a skill list (it rots on every new skill; a newly added skill
stays blind). Derive it from the skill manifest (`.claude/skills/skill-manifest.json`)
plus the `SOURCES.txt` files. Sort every skill into one of three classes:

1. **Code-drift — subagent-audited, drift-hook-netted.** Every skill with a
   `SOURCES.txt`. The hook already watches these; run a full step-2 subagent
   audit over each file/symbol/line claim.
   ```bash
   ls .claude/skills/*/SOURCES.txt   # → the drift-netted skills
   ```
2. **Project-layer drift — against docs, not code.** Published/genericized skills
   carry their project crust in a project-layer doc, not in code. Lighter check:
   do the inline pointers still resolve to existing project-layer files, and do
   the cited field/status names still match the profile.
3. **Script-coupled, un-netted — checked by hand every audit.** Skills coupled to
   scripts or hooks with no `SOURCES.txt` and no hook net. No hook warns, so
   re-check them manually each audit.

Derive each concrete skill's class from the manifest, its `SOURCES.txt`, and the
repository surfaces — a completeness gate catches the next new skill that would
otherwise stay invisible.

### 2. Audit in parallel — one subagent per skill

Before dispatch, resolve a provider-neutral Routing intent — an explicit intent
block first, otherwise the workflow classifier — and authorize the whole run
once through a Dispatch plan whose hash binds every unit, intent, route and
reason. Dispatch only through `src/lib/routeDispatcher.mjs`, and require a
Dispatch receipt from the shared spawn guard that carries the authorization id
the plan recorded. A detected transport is not authorization; AFK dispatch
stops unless requested/applied route, model/effort enforcement, environment
precedence, and catalog/access/policy revisions are proved.

Run **one read-only research subagent per skill** — several in parallel in a
SINGLE message (they are independent and read-only, so they don't contend for the
git index). Per subagent prompt:

- name the repo root, insist **read-only**, "propose no fixes";
- list **each concrete SKILL.md claim** separately: file path, symbol name, line
  number, code example, cross-ref, memory key;
- ask for a verdict table back — `TRUE / FALSE / PARTIAL` + the CURRENT real
  path/symbol/signature — in compact `file:line` form (far fewer tokens than
  inline reads).

### 3. Re-verify before every edit — mandatory

**The auditor produces false positives.** Treat every reported drift as a
hypothesis, not a fact: re-verify it at the edit itself (`grep` / read the file)
before changing anything. Never take the auditor's list blind — and an empty
`grep` result is not proof either, so anchor the search frame (path from the repo
root, grep the import line, try a second pattern variant). On low-confidence
findings, re-audit the whole skill rather than trusting the list. This
false-positive discipline is the single most important rule of the recipe.

### 4. Fix only what's confirmed — by content type

- **Line number** → reference the symbol (function / constant); keep a line only
  when unavoidable.
- **Dead path** → the correct path, OR a pointer to the single source of truth.
- **Cross-ref** → a stable name (verify the target still exists first).
- **Stale "must still fix" state-claim** → move it into a "historical" block
  (keep the lesson, don't present it as current) or delete it.
- **Real code finding** (the skill is right, the code drifted) → a **separate
  issue**, NOT fixed inside the docs change.
- **Test-covered values** → leave untouched (guard 1 already secures them).

### 5. Catch up the SOURCES.txt

If a confirmed fix introduced a new source file or replaced an old one, update
the affected skill's `SOURCES.txt` in the same change (see the convention above).

### 5b. Sync any second surface

If your skills are published to more than one surface (for example a Codex mirror
alongside the Claude source), sync the mirror in the **same** change — otherwise
the second surface rots silently. Mirror the body, but preserve each surface's
own frontmatter: a mirror's `description` may be deliberately condensed, so never
blind-copy the whole file over it. A `SOURCES.txt` is a plain anchor list and can
be mirrored verbatim. Use the repository's declared surfaces and exact transform.

## Done

- **Enumeration completeness:** every skill from the manifest is assigned to one
  of the three §1 classes — this catches the next new skill that would otherwise
  stay invisible to the audit.
- Every reported drift is either fixed (with re-verify proof) or dismissed as a
  false positive (with proof the skill was right).
- Real code findings filed as their own issues, not folded into the docs change.
- Any second surface synced (body-parity; each surface's frontmatter preserved).
- The skill-sync guard and the drift-hint smoke test pass.
- A pure docs / test / hook change needs no application live-verify.
