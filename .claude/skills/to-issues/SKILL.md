---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues on the project issue tracker using tracer-bullet vertical slices. Use when user wants to convert a plan into issues, create implementation tickets, or break down work into issues.
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

The issue tracker and triage label vocabulary should have been provided to you — run `/setup-workflow` if not.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it from the issue tracker and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Issue titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be 'HITL' or 'AFK'. HITL slices require human interaction, such as an architectural decision or a design review. AFK slices can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
- Title each user-facing slice as an OUTCOME ("<user action> → <visible result>"), never as a layer ("Config UI", "Backend resolver"). A layer-only title hides whether the full vertical is covered.
- A slice MAY be a deliberate PREP / byte-neutral slice (refactor, infra, schema seed) that is NOT end-to-end — but then it MUST name which user-facing half it defers AND which later slice closes it. A deferred half with no named closing slice is a gap: the connective path becomes owned by no slice.
- **Seam-Ownership (Fix A):** a PRD decision that **replaces / unifies / retires a central mechanism** ("ersetzt den X-Sonderpfad", "vereinheitlicht Y", "retired Z") MUST become its **own slice**, marked 🧊 **grill-needed** (HITL) — **never** folded implicitly into a behavior-preserving naming/tweak leaf. A behavior-preserving slice (byte-neutral, seed-preserving) does **NOT** discharge a seam replacement. Sister rule to "Neuer Architektur-Layer = First-Class-Slice" (CLAUDE.md ## Workflow). *(Incident: a central seam hid inside a "Naming" leaf of a broadly-grilled epic → a full re-plan at a leaf.)*
</vertical-slice-rules>

### 3b. Verify slice completeness (gate — do NOT skip on a pre-cut table)

Even when the slices were already cut upstream (a grill/PRD slice table), do NOT rubber-stamp them — re-derive and verify. Check each slice against your project's spec conventions — from the project root, `docs/conventions/spec-completeness.md` §Vertikal-Slice-Vollständigkeit (if absent → `/setup-workflow`):

- Every user-facing slice is a tracer-bullet outcome sentence, not a layer name.
- Every byte-neutral/prep slice names its deferred half + the slice that closes it.
- For the FIRST outcome slice after any prep slices, trace one concrete value through ALL layers against the code (`grep`/Read) — do not trust an abstraction like "config-driven resolver replaces the FIELD_MAPs". A missing layer = carve a new slice BEFORE publishing.
- **Seam-Ownership check (Fix A):** does any slice **replace/unify/retire a central mechanism**? If yes, it MUST be its own 🧊 grill-needed slice — NOT hidden in a behavior-preserving naming/tweak leaf. A byte-neutral slice does not discharge the seam.
- **Blast-Radius-Schwelle:** for each slice, estimate the blast radius (~N files, from recon/grep — not a guess; workflow slices count SKILL.md + adapter mirrors + tests). **≥ 10 estimated files OR not estimable → check for a split.** If the slice stays deliberately large, it MUST be 🧊 **grill-needed** (HITL) with a "why indivisible" justification **in the issue body** — a guideline, not a hard block, but the deviation lives in the body, not in the agent's head. (Incident: "DAL Rest" cut as 1 slice → 34 prod files / ~155 call-sites at execute-recon, an emergency in-build split. No gate at the cut existed.)

- **`## Offene Punkte` aus der Quelle → downstream HITL:** trägt das Quell-Artefakt (z.B. eine `to-prd`-PRD mit nicht-ableitbaren Sektionen) eine nicht-leere **`## Offene Punkte`**-Sektion, **muss** `to-issues` entweder **stoppen + nachfragen** ODER die betroffene(n) Slice(s)/den Leaf als **HITL** mit `## Vor Bau zu klären` publishen — die offenen Punkte verschwinden nie still (eine Draft-PRD hat selbst keinen Bucket; der lebt erst auf Kind/Leaf, §5c).

The table is only "done" when every user-facing row passes the trace. **Incident:** a custom-field read-path fell between a byte-neutral resolver slice (1a) and a "UI" slice — owned by neither, caught a slice too late.

#### 3b-Variante für Workflow-/Skill-Doku-Slices (kein schema/API/UI)

When the slices change **workflow markdown** (skills, hooks, conventions) instead of app code, the schema→API→UI layers don't exist — but the gate does NOT get weaker. Map the trace onto the four layers a workflow behavior actually has:

1. **Contract-Prosa** — the `SKILL.md`/convention rule that prescribes the behavior.
2. **Mechanik** — the command/hook/helper that *enforces* it (e.g. `scripts/board-sync.py`, a lint fixture, a hook). If a behavior genuinely has no machinery, write the explicit notation **`Mechanik: n/a weil <reason>`** — never silently omit it.
3. **Test/Fixture** — the `scripts/test_*.py` that proves it.
4. **Adapter-Mirror** — the `.agents/skills/…` copy (codex side), kept in sync via `codex-adapter-sync`.

Trace ONE concrete behavior (e.g. "a HITL child never carries `ready-for-agent`") through all four: prose says it → helper guard rejects it → test asserts the rejection → mirror carries the same prose. A missing layer = carve a slice before publishing. *(This trace is checklist discipline in prose; mechanically enforced are only the Test/Mirror **existence** via lint — not the full four-layer trace.)*

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
- **Blast-Radius**: ~N estimated files (from recon/grep, not a guess — workflow slices count SKILL.md + adapter mirrors + tests). Flags the §3b threshold at the cut.
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

### 5. Publish — promote-or-atomar (Contract)

The canonical source is a **Draft-PRD** issue from `to-prd` (carries `plan_revision`, `<!-- prd: awaiting-decomposition -->`, exactly one `type:*` + one `priority:*`, **no** `type:cluster`/Wave). But `to-issues` is **provenance-independent**: it re-derives readiness from the **artefact** (§3b), never from which tool produced it.

**Kalt-Einstieg auf einem schon existierenden Issue.** Quelle kann auch ein **rohes Issue**, eine **externe-PRD-in-Issue** oder ein **mechanisches Datei-Bündel** sein — ohne die `to-prd`-Marker. Dann gilt ein **Cold-Entry-Preflight, bevor irgendetwas mutiert wird:**
- **Hard-Stop** wenn das Issue schon `type:cluster` **oder** eine Wave trägt → es ist bereits ein Anker, gehört nicht in einen frischen Promote (melden + abbrechen).
- **Label normalisieren** (Spiegel der `to-prd`-Normalisierung): genau **ein `type:*` + ein `priority:*`**; `needs-info`/`ready-for-agent` **strippen** bis zur finalen Bucket-Zuweisung (§5c).
- **Fehlende `to-prd`-Marker in-place synthetisieren** (nicht voraussetzen): `plan_revision r1` an den Body-Kopf, Stufe-2-Anker-Body aus dem Template rendern. `source`/`synthesized` im §7-Audit ausweisen.
- **§4-User-Approval gilt auch hier** — die synthetisierte Slice-Tabelle wird gezeigt + iteriert, **nie** still publishen (s. §4).

How it is published depends on the decomposition test (gilt für **jede** Quelle):

- **≥2 independently mergeable slices → PROMOTE.** The source issue *becomes the Anker*.
- **exactly 1 slice → ATOMAR.** The source issue *stays a leaf*; the single PR `closes` it. *(Ein mechanisches Bündel mit nur einer sinnvollen Slice wird **nicht** zum Anker.)*

**Lane-D — mechanisches Bündel (Datei-Liste/Refactor).** Es darf den Domänen-Grill **überspringen** — **nur** wenn: Blast-Radius *schätzbar* **und** `<10 Dateien` **und** *kein* Seam ersetzt (§3b Seam-Ownership/Blast-Radius bleiben). Sonst → **HITL** mit `## Vor Bau zu klären` (strukturelle Fragen / why-indivisible), wie §3b/§5c es verlangen. Kein `## Vor Bau zu klären` nötig, wenn nichts offen ist.

**All board writes go through `scripts/board-sync.py` only** — never a bare `gh issue create`/`project item-add`/`item-edit`/`addSubIssue`, and never a workflow-state label edit (`gh issue edit --add-label ready-for-agent|needs-info|type:cluster`). The helper owns the one-parent-check, preview header, field IDs, and the HITL guard.

#### 5a. PROMOTE (≥2 slices)

```bash
# 1. allocate an explicit Wave first (no in-promote race) — needed for BOTH title + body render
WAVE=$(python3 scripts/board-sync.py next-wave)

# 2. render the Stufe-2 Anker body from docs/agents/wave-anchor-template.md into /tmp/anchor.md:
#    body header `**Welle $WAVE — <Thema>**`, **plan_revision:** r<N> at top (before the first
#    heading), the FILLED Slices table (you know the cut), the full grilled PRD in a collapsible
#    <details>, and the stale `<!-- prd: awaiting-decomposition -->` marker REMOVED. The issue
#    TITLE is rewritten to `Welle N — <Thema>` by the promote step below (step 3) — do NOT set it
#    here; promote prepends the wave prefix (and strips any `fix:`/`feat:` prefix) idempotently.
#    Rewrite the PRD body via skill-prose gh (body-fill is issue CONTENT, NOT a board write — the
#    helper owns board state only; cf. test_plan_body_fill_is_not_a_board_sync_op; gh-lint allows a
#    non-workflow-label `gh issue edit`). Content-edit FIRST so a failure stops before board mutation:
gh issue edit <prd#> --body-file /tmp/anchor.md

# 3. set the board state (type:cluster + Wave). If THIS fails AFTER the body edit, the title/body are
#    already rewritten → STOP, report "Board-State unvollständig (Body/Titel bereits geändert)", and
#    re-run the idempotent promote (do not leave a silent partial state):
python3 scripts/board-sync.py promote --issue <prd#> --wave "$WAVE"   # sets type:cluster + Wave + title `Welle N — …`

# 4. create each child (dependency order), then link it under the Anker — BEFORE the §7 exit audit,
#    so the checker sees the anchor's children (a childless type:cluster anchor mis-reads as a leaf)
python3 scripts/board-sync.py create --title "Welle $WAVE / Slice 1a — <outcome>" \
  --body-file /tmp/slice-1a.md --label type:feature --label priority:medium \
  --status Spec --wave "$WAVE"            # AFK: append --label ready-for-agent
                                          # HITL: pass --hitl, never ready-for-agent
python3 scripts/board-sync.py link --parent <prd#> --child <new#>
# → the promoted anchor graph is audited at exit (§7, execute-ready --mode audit, non-blocking)
```

- The Anker body comes from **`docs/agents/wave-anchor-template.md` (Stufe 2)** — filled Slices table + collapsible PRD; the stale `<!-- prd: awaiting-decomposition -->` marker is **removed** (the post-promote audit flags it otherwise). Reference output.
- Promoted children carry the title prefix **`Welle N / Slice X — <outcome>`**.
- Fresh children each have exactly one parent → the one-parent constraint is never violated. `link` refuses a foreign-parent re-parent (exits non-zero — drift, never silent).

#### 5b. ATOMAR (1 slice)

The Draft-PRD stays the executable leaf. Edit its body: **remove** `<!-- prd: awaiting-decomposition -->`, keep `type:*`+`priority:*` (**no** `type:cluster`/Wave, **no** `Welle N` title prefix), stamp the leaf `plan_revision`, add the `## Handoff-Startbefehl`. The single PR `closes #<prd#>`.

Then set the bucket via the helper — the leaf already exists, so the workflow-label write goes through `board-sync.py add --bucket` (§5a forbids a bare `gh issue edit --add-label ready-for-agent`):

```bash
# AFK (buildable now): set ready-for-agent
python3 scripts/board-sync.py add --issue <prd#> --bucket afk
# HITL (grill first): strip ready-for-agent + the body carries `## Vor Bau zu klären`
python3 scripts/board-sync.py add --issue <prd#> --bucket hitl
```

`--bucket hitl` strips the label mechanically (a HITL leaf is never buildable — same invariant `create --hitl` enforces by rejecting). Bucket semantics + the `## Vor Bau zu klären` requirement → §5c (the authority is `execute-ready-check.py`).

#### 5c. HITL/AFK — Label + Body (`ready-for-agent` is the discriminator)

Every child **and** the atomar leaf sits in **exactly one** bucket:

| Bucket | `ready-for-agent` | Status | Body |
|---|---|---|---|
| **AFK** (buildable now) | **present** | `Spec` | complete What + AC |
| **HITL** (grill first) | **absent** | `Spec` | mandatory `## Vor Bau zu klären` with the open questions known from the macro-grill |

Status alone cannot discriminate (both are `Spec`) — the **label** does. The helper's `--hitl` flag rejects a `ready-for-agent` label mechanically. Authority = `scripts/execute-ready-check.py` (`parse_bucket`) — bei Abweichung gilt der Checker.

#### 5d. Issue body template (each child / atomar leaf)

<issue-template>
<!-- slice-id: <stable-kebab-id> -->
<!-- parent-prd: #<prd#> -->   <!-- omit for an atomar leaf -->
**plan_revision:** r<N>        <!-- child mirrors the Anker's revision; atomar leaf carries its own -->
**Blast-Radius:** ~N Dateien   <!-- recon estimate at the cut; the build session checks it against its own recon -->

**Part of:** Welle <N> · Anker #<prd#>   <!-- visible child→anchor link (bare #N, not a /issues/ URL); omit for an atomar leaf -->

## What to build
End-to-end behavior of this vertical slice (not layer-by-layer). Avoid file paths/snippets (stale fast).

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by
Reference the blocking ticket(s), or "None - can start immediately".

## Vor Bau zu klären   <!-- HITL only — the open decisions; omit for AFK -->
- <open question 1>

## Handoff-Startbefehl
Scope + Live-Verify + start skill (HITL → `/grill-me → /tdd`, AFK → `/tdd`).
</issue-template>

**Blast-Radius-Abgleich (Bau-Session):** the stamped `**Blast-Radius:**` is the estimate *at the cut* — the build session compares it against its own recon befund. A real befund **> 2× the estimate → STOP + report** (re-cut at the Anker), do NOT keep building silently.

### 6. Idempotenter Reconcile (re-run)

A re-run (or a re-grill that re-enters the pipeline) must leave the affected sub-graph coherent. **Mutation is one top-down pass rooted at the resolved Anker:**

```bash
# entered from a child? lift to its Anker, then enumerate all siblings
PARENT=$(python3 scripts/board-sync.py parent-of <child#>)        # FREI = atomar leaf
python3 scripts/board-sync.py children-of "$PARENT"              # the full child set to reconcile
```

- Diff each child against the Anker; update bodies; stamp `plan_revision` on **every** child (mirrors the Anker's revision — coherence = `child.rev == parent.rev`) and on the atomar leaf (its own fingerprint, like `to-prd`). Missing/malformed `plan_revision` → treat as `r1` + warn.
- **Never silently mutate across a boundary:** a foreign-parent child (`link` conflict), a cross-Anker dependency, or an **atomar↔promoted flip** is **reported as drift and stopped**, not auto-restructured. On a flip (a 1-slice PRD that now needs ≥2, or vice-versa), stop with an instruction — confirm the promote/demote, then spin the old scope into a child — because auto-demoting a PRD that may already have an open `closes` PR is exactly the silent structural mutation that closes anchors prematurely.

### 7. Execute-ready exit assertion + audit (non-blocking)

After publishing/reconciling, run the shared checker (the same logic the **blocking** Drift-Guard uses at handoff — Slice 1g shipped it):

```bash
python3 scripts/execute-ready-check.py --issue <anker-or-leaf#> --mode audit
```

It asserts, for the rooted local graph:
- every child + the atomar leaf is in **exactly one** bucket (AFK: `ready-for-agent` + complete · HITL: no `ready-for-agent` + `## Vor Bau zu klären`);
- `plan_revision` stamped and coherent (child == Anker, leaf own); no stale in-between;
- Parent↔Child consistent (Anker carries no bucket / no `ready-for-agent`);
- ** Anker-Shape** (`## Herkunft`/`## Entscheidungen`/`## Slices` + Body-Kopfzeile) — als **`shape_warnings`** (rein non-blocking, fließt **nie** in `deny_recommended`).

`--mode audit` is **non-blocking** — a mismatch is a **loud warning** here; the **hard block** is `.claude/hooks/drift-guard.py` at handoff-creation. Emit a visible audit two-liner:

```
to-issues: anchor=#<X> mode=<promote|atomar> slices=<n> rev <old>→<new>
  source=<draft-prd|raw-issue|external-prd|bundle>  synthesized=<marker-liste | none>
  AFK=[#a #b] HITL=[#c] · drift=<none | …>  shape=<ok | warn:…>
```

Do NOT close or modify any parent issue beyond the promote stamp.
