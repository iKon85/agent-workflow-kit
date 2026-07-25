---
name: to-issues
description: "Break a Feature or Program plan, spec, or PRD into independently-grabbable issues on the project issue tracker. This is the single public Planning facade: explicit Feature identity uses tracer-bullet decomposition; explicit Program identity delegates to the internal graph engine."
---

<!-- project-extension:protocol-v1:start -->
## Project extension

Before applying this Core skill, run `node scripts/project-skill-extension.mjs inspect --skill to-issues --json` from the Project root. When it returns `active`, read the returned `path` and apply it as additive Project instructions. When it returns `inactive`, continue with Core only. When it returns `blocked`, stop and report its diagnostic.

Project extensions may specialize Project details, but cannot weaken Core user gates, safety, ownership, or validation. A contradiction blocks and requires an Explicit fork.
<!-- project-extension:protocol-v1:end -->

# To Issues

> **Skill identity (don't get confused):** the folder `to-issues` + invocation `/to-issues` map to Matt Pocock's upstream skill **`to-tickets`**. Upstream merged `to-issues` + the short-lived `to-plan` into `to-tickets` (v1.1.0); we deliberately keep the folder name `to-issues` (invocation stability, and issues are this workflow's vocabulary). Content remains our fork, compared against upstream `to-tickets` @ `d574778`. Provenance/rename ledger: `docs/agents/provenance.md` (§Re-Sync-Log), at the project root.

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

<!-- readiness:required-preflight:start -->
## 0. Required readiness preflight

This is the first executable workflow step. From the project root, before any remote write or other `gh`/`board-sync.py` command, run this read-only check:

```bash
node scripts/readiness.mjs check --skill to-issues --json
```

- `verdict=ready`: continue with the existing workflow without announcing the check. **Ready is silent.**
- `verdict=blocked`: `STOP` before any mutation. Report every required capability as `<capability>=<state>` so `issueTracker`, `managedBoard`, and `specCompleteness` failures — including distinct `missing`, `pending`, and `invalid` states — stay visible, then give exactly one recovery path: **Run `/setup-workflow`, then rerun `/to-issues`.** Do not fall back to bare tracker or board commands.
- `managedBoard=not-applicable`: `STOP` and report that `/to-issues` is **inapplicable** for a project that deliberately has no managed board. This is a terminal project decision, not invalid evidence and not a partially active mode.
<!-- readiness:required-preflight:end -->

## Planning facade — select by explicit identity only

`to-issues` is the **single public Planning facade**. After the readiness
preflight and before any remote write, classify the source from its explicit PRD
identity:

- **Feature identity → `planning-mode=feature`.** The body carries
  `<!-- prd: awaiting-decomposition -->` and its one `type:*` label is not the
  configured Program type. Run the existing Feature decomposition path below:
  one slice stays ATOMIC; two or more slices PROMOTE to a wave anchor.
- **Program identity → `planning-mode=program`.** The body carries
  `<!-- prd: program -->` and its one `type:*` label is the board profile's
  `labels.programType` value. Preserve the source and delegate to the internal
  `to-waves` graph engine. That engine still validates the graph, shows the
  complete Program preview, waits for the single explicit approval, and performs
  zero remote writes before approval.

**Missing or contradictory identity is a hard stop before a remote write.**
Missing means neither marker is present, including a raw issue, file bundle, or
external PRD without an explicit identity. Contradictory means both markers are
present, the marker disagrees with the `type:*` label, or the source carries
multiple type labels. Report the observed markers and type labels, then ask the
user to establish exactly one identity. A cold-entry source may receive a
Feature or Program identity only after that explicit choice; rerun this
classification before any normalization or publication.

**Size, prose, and model judgment never select the mode.** A `## Wellenplan`
heading, estimated file count, wording such as “large program”, or an agent's
inference may validate or contradict an already explicit identity, but none may
create or switch it. A Program identity without the graph grammar is a blocking
contract error, not a fallback to Feature. A Feature identity with Program-only
graph grammar is likewise contradictory and stops.

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
- **Seam ownership (Fix A):** a PRD decision that **replaces / unifies / retires a central mechanism** ("replaces the X special-path", "unifies Y", "retires Z") MUST become its **own slice**, marked 🧊 **grill-needed** (HITL) — **never** folded implicitly into a behavior-preserving naming/tweak leaf. A behavior-preserving slice (byte-neutral, seed-preserving) does **NOT** discharge a seam replacement. Sister rule to "new architecture layer = first-class slice" (CLAUDE.md ## Workflow). *(Incident: a central seam hid inside a "naming" leaf of a broadly-grilled epic → a full re-plan at a leaf.)*
</vertical-slice-rules>

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a DB column, retype a shared symbol, move a helper — whose **blast radius** fans across the whole tree, so a single edit breaks call sites everywhere at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand → contract**. An expand→contract sequence is inherently **≥2 slices → PROMOTE to a wave anchor** (§5), never one atomic leaf:

- **Expand** (first slice, blocks all the rest) — add the new form beside the old so nothing breaks yet; both coexist.
- **Migrate** (one slice per batch, sized by blast radius — per package, per directory) — move the call sites onto the new form, each batch **blocked by** the expand slice. CI stays green batch to batch because the old form still exists. Each migrate-batch PR says **`Part of #<anchor>`, never `closes`** (Backlog-Workflow) — a `closes` would shut the anchor before the sequence finished.
- **Contract** (final slice, **blocked by every migrate batch**) — delete the old form once no caller remains.

When even a single batch can't stay green on its own, keep the sequence but let the batches share an **integration branch** that they all block, feeding a final **integrate-and-verify** slice — green is promised only there, and that final slice's PR is the one that merges the branch. The migrate batches are precisely how a wide refactor answers the §3b **blast-radius threshold**: the batch boundaries ARE the split. A batch that still lands deliberately large records its "why indivisible" one-liner in the issue body per §3b — a mechanical migrate batch stays AFK (`ready-for-agent`), it is not made HITL just for its file count.

### 3b. Verify slice completeness (gate — do NOT skip on a pre-cut table)

Even when the slices were already cut upstream (a grill/PRD slice table), do NOT rubber-stamp them — re-derive and verify. Check each slice against your project's spec conventions — from the project root, `docs/conventions/spec-completeness.md` §Vertical-Slice-Completeness (if absent → `/setup-workflow`):

- Every user-facing slice is a tracer-bullet outcome sentence, not a layer name.
- Every byte-neutral/prep slice names its deferred half + the slice that closes it.
- For the FIRST outcome slice after any prep slices, trace one concrete value through ALL layers against the code (`grep`/Read) — do not trust an abstraction like "config-driven resolver replaces the FIELD_MAPs". A missing layer = carve a new slice BEFORE publishing.
- **Seam ownership check (Fix A):** does any slice **replace/unify/retire a central mechanism**? If yes, it MUST be its own 🧊 grill-needed slice — NOT hidden in a behavior-preserving naming/tweak leaf. A byte-neutral slice does not discharge the seam.
- **Blast-radius threshold:** for each slice, estimate the blast radius (~N files, from recon/grep — not a guess; workflow slices count SKILL.md + adapter mirrors + tests). **≥ 10 estimated files OR not estimable → check for a split.** If the slice stays deliberately large, it MUST be 🧊 **grill-needed** (HITL) with a "why indivisible" justification **in the issue body** — a guideline, not a hard block, but the deviation lives in the body, not in the agent's head. (Incident: a slice cut too coarse ballooned to 34 prod files at execute-recon, an emergency in-build split — no gate at the cut existed.) (Terminology note: this blast radius is a **slice estimate** — ~N files for this one cut — not a project-owned rollout-completeness census (e.g. an-style, code-derived "X of Y" census over all surfaces of a cross-cutting concept, if your repo runs one).)
<!-- mirror-xform:start codex-escalation -->
- **Gate type + sequencing (Retro):** every slice that is **not** a clean AFK build gets a gate tag — 🧭 **Design Grill** (a decision with alternatives, hard-to-reverse, ADR-worthy → `grill-with-docs`), 🔬 **Verify Spike** (a pure fact question, read-only), 📐 **Trade-off/Research** (a concrete trade-off choice OR "needs more research", **below** the grill threshold — read-only research + a documented trade-off in the issue), 📝 **Review Note** (a finding, **not** a build slice). A gate slice (🧭/🔬/📐) is cut as its **own slice**, sequenced **before** its dependent build slice, and blocks it (gate-before-build — published as a **native blocking edge** (§5a step 5), visible in the mirrored "Blocked by" section + table order). "Needs a decision / open call / research gap" while cutting → gate slice, **never** a blind AFK `/implement`. (🔬 **Verify Spike** runs via the `verify-spike` skill — read-only fact question, throwaway harness, verdict as ADR/comment, the throwaway deleted. 📐 **Trade-off/Research** runs via the `decision-gate` skill — options + criteria, read-only research/measurement, a documented trade-off table, a reasoned decision as ADR/comment; throwaway measurement code deleted.)
<!-- mirror-xform:end -->
- **🧭-vs.-📐 discriminator:** if the decision replaces/unifies/retires a **central seam**, is a **one-way door** (hard/costly to reverse), or a **schema migration** → 🧭 Design Grill (ADR-worthy, see Seam Ownership above). Otherwise — a **bounded choice between concrete options**, easily revised → 📐 Trade-off/Research.
- **Absence-before-build (Retro):** a slice cut as "build feature/page/endpoint/flow X" (or a gate "X gap unclear") MUST cite an **existence grep** — *absent* (`grep <pattern> = 0` across route **and** UI **and** repo) OR *partial* (`exists @<file>, gap = <Y>`). A hedge ("current state unclear → verify during build") is **not** a valid slice state: the check is cheap (minutes), so it happens **at the cut**, not deferred into a gate. (Incident: a gate was cut for a feature that greps already showed built — the gap was deferred instead of resolved.)
- **Gate discipline:** a 🔬/📐 gate is only legitimate **after** the cheap read-only check fails to resolve it — the gate slice states one line "why the check wasn't enough". A gate is not a parking lot for recon that never ran.

- **`## Offene Punkte` from the source → downstream HITL:** if the source artefact (e.g. a `to-prd` PRD with non-derivable sections) carries a non-empty **`## Offene Punkte`** section, `to-issues` **must** either **stop + ask** OR publish the affected slice(s)/leaf as **HITL** with the `headings.vorBau` heading (§5c) — the open questions never disappear silently (a Draft-PRD itself has no bucket; that only lives on the child/leaf, §5c).

The table is only "done" when every user-facing row passes the trace. **Incident:** a custom-field read-path fell between a byte-neutral resolver slice and a "UI" slice — owned by neither, caught a slice too late.

#### 3b variant for workflow/skill-doc slices (no schema/API/UI)

When the slices change **workflow markdown** (skills, hooks, conventions) instead of app code, the schema→API→UI layers don't exist — but the gate does NOT get weaker. Map the trace onto the four layers a workflow behavior actually has:

1. **Contract prose** — the `SKILL.md`/convention rule that prescribes the behavior.
2. **Mechanism** — the command/hook/helper that *enforces* it (e.g. `scripts/board-sync.py`, a lint fixture, a hook). If a behavior genuinely has no machinery, write the explicit notation **`Mechanism: n/a because <reason>`** — never silently omit it.
3. **Test/fixture** — *if your repo runs a test layer for workflow scripts* (e.g. `scripts/test_*.py`): the test that proves it. Otherwise the explicit notation **`Test: n/a because <reason>`** (e.g. no script-test harness in the consumer repo) — never silently omit it.
4. **Adapter mirror** — *if your skill is dual-surface* (Claude + Codex): the `.agents/skills/…` copy, kept via `codex-adapter-sync`. Otherwise the explicit notation **`Mirror: n/a because project-private / single-surface`**.

Trace ONE concrete behavior (e.g. "a HITL child never carries `ready-for-agent`") through all four: prose says it → helper guard rejects it → test asserts the rejection → mirror carries the same prose. A missing layer = carve a slice before publishing; an `n/a` layer (3/4) is a deliberate, named exemption, not a gap. *(This trace is checklist discipline in prose; mechanically enforced are only the Test/Mirror **existence** via lint — not the full four-layer trace, and never for a layer marked `n/a`.)*

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
<!-- mirror-xform:start codex-escalation -->
- **Gate**: `—` (clean AFK build) · 🧭 Design Grill (`grill-with-docs`, ADR-worthy) · 🔬 Verify Spike (read-only fact question) · 📐 Trade-off/Research (trade-off choice OR research below the grill threshold, read-only + documented trade-off) · 📝 Review Note (not a build slice). A gate slice (🧭/🔬/📐) is placed **before** its dependent build slice (gate-before-build) + blocks it.
<!-- mirror-xform:end -->
- **🧭-vs.-📐:** central seam / one-way door / schema migration → 🧭; a bounded choice between concrete options → 📐 (criterion: §3b).
- **Blast-Radius**: ~N estimated files (from recon/grep, not a guess — workflow slices count SKILL.md + adapter mirrors + tests). Flags the §3b threshold at the cut.
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

**Program batch handoff.** When the internal Program graph engine invokes this
skill for a Stufe-1p stub,
the complete Program preview has already shown and approved every wave's slice
contract. Reuse that approval when this pass preserves the approved cut: do not
pause again merely because the internal pipeline crossed a skill boundary. Run
the normal contract in full — maturity is not a reduced mode — and reconcile the
stub's existing leaves instead of duplicating them. A new structural choice or a
newly discovered gate invalidates the inherited approval and returns to §4.

### 5. Publish — promote-or-atomic (contract)

**Cluster/Wave discriminator (identical wording — `to-prd` §2 / `to-issues` §5):** `type:cluster` (label) always stops. A Wave number also stops, **unless** the target carries the `wave-stub` label — a Wave-stamped `wave-stub` issue is a **Stufe-1p Program-stub** (`to-waves`-published, native parent = a Program-PRD) and remains a **valid target**. A Wave-stamped issue **without** `wave-stub` (an already-assigned leaf, or a drifted item) is still a hard stop.

The canonical Feature source is a **Draft-PRD** issue from `to-prd` (carries
`plan_revision`, `<!-- prd: awaiting-decomposition -->`, exactly one `type:*` +
one `priority:*`, **no** `type:cluster`, and no Wave **unless** the
discriminator's `wave-stub` exception applies — a Program-stub's per-wave-start
content pass writes this same shape into an already Wave-stamped stub, `to-prd`
§2). The facade is provenance-independent but not identity-optional: it
re-derives readiness from the **artefact** (§3b), never from which tool produced
it, only after the explicit identity classification above selected the mode.

**Cold entry on an already-existing issue.** The source can also be a **raw
issue**, an **external PRD embedded in an issue**, or a **mechanical file
bundle** — without the `to-prd` markers. That absence first triggers the
facade's identity hard stop above. Only after the user explicitly establishes
Feature identity may this **cold-entry preflight apply before anything is
mutated:**
- **Hard-stop per the discriminator above** — `type:cluster` always; Wave only when the issue is **not** a `wave-stub` (the exception is already an intended promote target — `promote` reuses its pre-stamped Wave number, §5a below).
- **Normalize labels** (mirroring `to-prd`'s normalization): exactly **one `type:*` + one `priority:*`**; `needs-info`/`ready-for-agent` **stripped** until the final bucket assignment (§5c).
- **Synthesize missing `to-prd` markers in place** (never assume them): `plan_revision r1` at the body head, render the Tier-2 anchor body from the template. Surface `source`/`synthesized` in the §7 audit.
- **§4 user approval also applies here** — the synthesized slice table is shown + iterated, **never** published silently (see §4).

How it is published depends on the decomposition test (applies to **every** source):

- **≥2 independently mergeable slices → PROMOTE.** The source issue *becomes the anchor*.
- **exactly 1 slice → ATOMIC.** The source issue *stays a leaf*; the single PR `closes` it. *(A mechanical bundle with only one sensible slice does **not** become an anchor.)*

**`wave-stub` strip is automatic — no manual edit.** If the source was a `board-to-waves` candidate stub (`label:wave-stub`), **both** publish mechanics remove the label idempotently: `promote` (§5a) **and** `add --bucket` (§5b atomic). This takes it off the "awaiting planning" list (`is:open label:wave-stub`), regardless of whether it becomes a wave or an atomic leaf. Never help it along with a bare `gh issue edit --remove-label wave-stub` — the helper is the only label writer (see box below).

**Lane D — mechanical bundle (file list/refactor).** It may **skip** the domain grill — **only** if: blast radius is *estimable* **and** `<10 files` **and** *no* seam is replaced (§3b Seam Ownership/Blast Radius still apply). Otherwise → **HITL** with the `headings.vorBau` heading (structural questions / why-indivisible), as §3b/§5c require. No `headings.vorBau` heading needed if nothing is open.

**All board writes go through `scripts/board-sync.py` only** — never a bare `gh issue create`/`project item-add`/`item-edit`/`addSubIssue`, and never a workflow-state label edit (`gh issue edit --add-label ready-for-agent|needs-info|type:cluster`). The helper owns the one-parent-check, preview header, field IDs, and the HITL guard.

#### 5a. PROMOTE (≥2 slices)

```bash
# 1. allocate the Wave number — needed for BOTH title + body render. An ordinary
#    board-to-waves stub (Stufe 1, cluster/Wave-less) gets a FRESH one; a Stufe-1p
#    Program-stub was already stamped with one by to-waves at publish — reuse
#    it, never re-allocate (promote's mismatch guard refuses a DIFFERENT number):
CURRENT=$(python3 scripts/board-sync.py field-value --issue <prd#> --field wave)
if [ "$CURRENT" = "unset" ]; then
  WAVE=$(python3 scripts/board-sync.py next-wave)   # Stufe-1 stub — allocate fresh
else
  WAVE="$CURRENT"                                    # Stufe-1p Program-stub — reuse
fi

# 2. Fill /tmp/anchor-template.md from docs/agents/wave-anchor-template.md (Tier 2):
#    body header `**Welle $WAVE — <Topic>**`, anchor-owned markers at the head,
#    filled Slices table, and the To-Do checklist collapsed to one line. Save the
#    unchanged source PRD body as /tmp/source-prd.md. The renderer reads only those
#    two files and writes only stdout: no GitHub/network call and no mutation.
python3 scripts/render-anchor.py --template /tmp/anchor-template.md \
  --prd /tmp/source-prd.md --document anchor > /tmp/anchor.md
python3 scripts/render-anchor.py --template /tmp/anchor-template.md \
  --prd /tmp/source-prd.md --document archive > /tmp/prd-archive.md
```

The anchor output is the filled template byte-for-byte. The archive starts with
the stable `📄 Full PRD` marker and strips every canonical marker line
(`plan_revision`, `prd-source-id`, `prd-content-fp`, `<!-- prd: … -->`) only
from the source body's head block. Marker-looking text in a quote, fence, or
later section is content and remains untouched.

Promotion uses the remote issue itself as its journal. Classify four
observations before every resume. Before transition 1, `S=yes|no` compares a
freshly fetched remote body byte-for-byte with `/tmp/source-prd.md`, the source
snapshot that produced both rendered outputs. Once `B=yes`, that source
snapshot is no longer active and `S=n/a`. `B=yes|no` says whether the fetched
issue body is byte-identical to `/tmp/anchor.md`.
`C=0|exact-1|wrong-1|duplicates(<ids>)` classifies stable-marker comments:
none; exactly one whose whole body is byte-identical to
`/tmp/prd-archive.md`; exactly one with different bytes; or multiple matches
with every comment ID retained. `P=absent|complete|partial` classifies only
promotion-owned board state. `P=absent` accepts either an
ordinary pre-state (no `type:cluster`, Wave unset, no `Welle` title prefix) or a
valid Stufe-1p pre-state (`wave-stub` present, no `type:cluster`, and the
pre-stamped Wave/title match `$WAVE`). `P=complete` requires `type:cluster`, the
expected Wave/title, and no remaining `wave-stub`. Every other combination —
including a different Wave — is `P=partial`. Fetch comments with the paginated
API, never the first page alone:

```bash
gh api --paginate --slurp \
  "repos/<owner>/<repo>/issues/<prd#>/comments?per_page=100"
```

Flatten every returned page, retain the comment `id`, and exact-match the
start-of-body marker. The four valid states and their sole resume action are:

<!-- promotion-board-observation-table:start -->
| Scenario | Observable board facts | P classification |
|---|---|---|
| `ordinary-prestate` | no cluster; Wave unset; no Wave title | `absent` |
| `stufe-1p-prestate` | wave-stub; no cluster; expected Wave/title | `absent` |
| `promoted` | cluster; expected Wave/title; no wave-stub | `complete` |
| `cluster-only` | cluster; Wave/title missing | `partial` |
| `wrong-wave` | any different Wave value | `partial` |
<!-- promotion-board-observation-table:end -->

<!-- promotion-state-table:start -->
| State | Observable predicates | Resume action |
|---|---|---|
| `initial` | `S=yes`, `B=no`, `C=0`, `P=absent` | render + write body |
| `body-written` | `S=n/a`, `B=yes`, `C=0`, `P=absent` | reconcile + write archive comment |
| `comment-written` | `S=n/a`, `B=yes`, `C=exact-1`, `P=absent` | promote board state |
| `promoted` | `S=n/a`, `B=yes`, `C=exact-1`, `P=complete` | no-op; continue publish audit |
<!-- promotion-state-table:end -->

Each transition is idempotent and has an explicit contract:

1. **Write body (`initial → body-written`).** Pre: `S=yes`, `B=no`, `C=0`,
   `P=absent`. Fetch the remote body again immediately before the command and
   recompute `S`; a prior fetch is not sufficient.
   Run `gh issue edit <prd#> --body-file /tmp/anchor.md`, refetch the body, and
   require a byte match. Post: `S=n/a`, `B=yes`, `C=0`, `P=absent`.
2. **Write archive (`body-written → comment-written`).** Pre: `S=n/a`, `B=yes`,
   `C=0`, `P=absent`. Re-run the pagination-aware lookup immediately before
   create; if it now yields `C=exact-1`, classify as `comment-written` and do
   not create. `C=wrong-1` or `C=duplicates(<ids>)` is drift and enters repair,
   never create. Only `C=0` runs `gh issue comment <prd#> --body-file
   /tmp/prd-archive.md`, then immediately paginate and reconcile again. Post:
   `S=n/a`, `B=yes`, `C=exact-1`, `P=absent`.
3. **Promote (`comment-written → promoted`).** Pre: `S=n/a`, `B=yes`,
   `C=exact-1`, `P=absent`. Run `python3 scripts/board-sync.py promote --issue <prd#> --wave
   "$WAVE"`, refetch body, comments, labels, Wave, and title. Post: `S=n/a`,
   `B=yes`, `C=exact-1`, `P=complete`. Re-running `promote` with the same Wave
   is the repair for `P=partial`; a different Wave remains a hard stop.

Any other predicate combination is drift, not a fifth state. Repair it
explicitly, then reclassify. `S=no` before transition 1 means **STOP**: report
the diff between the fresh remote body and `/tmp/source-prd.md`, never write the
stale render, re-fetch the remote body into a reviewed source snapshot, and
rerender both outputs before recomputing `S`. `B=no` outside the valid `initial` tuple
means **STOP**, report the body diff against `/tmp/anchor.md`, and require
an explicit operator decision to restore the rendered anchor or adopt the remote
edit and rerender both outputs; never overwrite remote journal evidence automatically.
Only transition 1 performs the approved source-to-anchor body write without
this drift gate. `C=wrong-1` → report its ID and explicitly update it to the
rendered archive; `P=complete` with `C=0` → create/reconcile the archive without
demoting. For `P=partial`, a different Wave is a hard stop; otherwise rerun
same-Wave `promote`. `C=duplicates(<ids>)` always means **STOP and report every
comment ID**. An operator must choose and explicitly delete/update the
duplicates, then rerun the paginated lookup; never select the first match or
silently discard one. No local operation journal is written: these
observations are the journal.

```bash
# 3. Continue only from the `promoted` state.

# 4. create each child (dependency order), then link it under the anchor — BEFORE the §7 exit audit,
#    so the checker sees the anchor's children (a childless type:cluster anchor mis-reads as a leaf)
python3 scripts/board-sync.py create --title "Welle $WAVE / Slice 1a — <outcome>" \
  --body-file /tmp/slice-1a.md --label type:feature --label priority:medium \
  --status-role spec --wave "$WAVE"       # AFK: append --label ready-for-agent
                                          # HITL: pass --hitl, never ready-for-agent
python3 scripts/board-sync.py link --parent <prd#> --child <new#>

# 5. set every blocking edge NATIVELY — one `dep-add` per "Blocked by" relation in
#    the slice table (gate-before-build edges from §3b/§5c included). Native issue
#    dependencies are the blocking SSOT where the tracker supports them; the helper
#    also writes the `## Blocked by` body section as the machine mirror (on a
#    tracker without native dependencies the body section is the primary record):
python3 scripts/board-sync.py dep-add --issue <blocked#> --blocked-by <blocker#>
# → the promoted anchor graph is audited at exit (§7, execute-ready --mode audit, non-blocking)
```

- The anchor body comes from **`docs/agents/wave-anchor-template.md` (Tier 2)** — lean: filled Slices table (`# | Status | Slice | Sub-Issue | Gate | closes/refs`), NO embedded PRD, NO per-slice handoff blocks. The full PRD (markers stripped: `plan_revision`/`prd-source-id`/`prd-content-fp`/`awaiting-decomposition`) is **issue comment #1**; each slice's paste-ready handoff is **self-contained in its leaf** (§5d).
- Promoted children carry the title prefix **`Welle N / Slice X — <outcome>`**.
- Fresh children each have exactly one parent → the one-parent constraint is never violated. `link` refuses a foreign-parent re-parent (exits non-zero — drift, never silent).
- **Member reconcile when promoting a stub (mandatory — Retro, corrected by; extended to the top-down origin).** The pipeline never runs directly `board-to-waves → to-issues` — it always goes through the intermediate step `board-to-waves` (stub) → [optional grill] → `to-prd` (Draft-PRD) → `to-issues` (publish); the top-down origin is `scale-check → grill → to-prd (program mode) → to-waves` (stub) → `to-issues` (publish). **The reconcile input is the union of the member issues listed in the stub-body `#…` list AND `children-of <stub#>`** (read the body, e.g. `gh issue view <anchor#> --json body`, plus `python3 scripts/board-sync.py children-of <stub#>`) — covering both origins: a bottom-up `board-to-waves` stub sets **no** native sub-issue link at clustering time, so `children-of` finds nothing before this promotion and only the body list matters; a top-down Stufe-1p Program-stub **already** has native children — the slice leaves `to-waves` pre-created at publish (`to-waves` SKILL.md §4) — which `children-of` returns even before this promotion, on top of any body-listed **adopted** references (`to-waves`'s Adopt Path). These members MUST be reconciled during the publish pass, or they end up sitting next to the fresh slices → **duplicates + execute-ready `DENY`** (the anchor's child set must equal the slice set; a legacy member without `plan_revision`/bucket denies the §7 audit). Rule per member:
  - **1:1 mapping (member ⇒ exactly one slice)** → **reuse the member issue as the slice** (lift its body to the slice contract, **then** set `link` if it doesn't exist yet — a Stufe-1p member's `link` already exists from `to-waves`'s publish, so this is a no-op there, not a fresh `link` call), **not** create-fresh + close-old. **Reuse finalization — three things in the SAME publish pass, not a follow-up:** (1) stamp the `**Part of:** Welle <N> · Anchor #<prd#>` line into its body (§5d template); (2) apply the Wave field stamp if not already set (a bottom-up member has none yet; a Stufe-1p member already carries it from `to-waves`'s publish — idempotent no-op there); (3) finalize its bucket (`add --bucket afk|hitl`, §5c).
  - **Split/merge (member ⇒ multiple slices, or multiple members ⇒ one slice) OR a fresh slice with no member** → close the superseded member(s) as **"superseded by Slice #<n>"** (mapping comment); if a member exceptionally already carries a native link (e.g. from an earlier partial run of the same promotion), first `unlink` it via `python3 scripts/board-sync.py unlink --parent <anchor#> --child <member#>` (parent-checked + idempotent; **never** bare `gh api removeSubIssue`), then `gh issue close <member#> -c "…"`.
  - **Before publishing**, read the member issues listed in the stub body and decide the reuse-vs-close branch per member — not reactively at the §7 audit DENY. (Incident Retro: 12 slices were created fresh before 8 members with 1:1/1:N mappings were reconciled after the fact; `board-sync unlink` didn't exist yet then, it does now.)
- **Program-PRD status flip (first promotion only).** If the promoted stub's native parent is a Program-PRD (`<!-- prd: program -->` marker or the `labels.programType` label, distinct from `<prd#>` above — call its issue number `<program-prd#>`) still at the spec-role status, this is the program's **first** wave promotion — flip the Program-PRD's Status to the in-progress role alongside the stub's own promote (`python3 scripts/board-sync.py add --issue <program-prd#> --status-role inProgress`). A Program-PRD already at the in-progress status (a later wave's promotion) needs no further flip — check-then-set, idempotent, monotone forward only (mirrors the Wellenplan `Status` column's own monotone regeneration in `program-sync`).

#### 5b. ATOMIC (1 slice)

The Draft-PRD stays the executable leaf. Edit its body: **remove** `<!-- prd: awaiting-decomposition -->`, keep `type:*`+`priority:*` (**no** `type:cluster`/Wave, **no** `Welle N` title prefix), stamp the leaf `plan_revision`, add the `## Handoff Start Command`. The single PR `closes #<prd#>`.

**Program-batch atomic exception.** A Stufe-1p stub already represents one named
wave under a Program-PRD. When its approved cut contains exactly one slice, keep
the stub itself as the atomic executable wave leaf: preserve its existing Wave and Phase,
`Welle N — …` title, native Program parent, and source marker; write the complete
atomic contract and bucket, then remove only `wave-stub`. Do not erase Program
navigation by applying the ordinary Wave-less atomic normalization.

On a delta re-run, a legacy or interrupted preliminary child may already be linked
under that atomic stub. Lift any still-relevant content into the stub, unlink the
child with `board-sync.py unlink`, and close it with the mapping comment
`superseded by atomic wave leaf #<stub>`. Scan both `children-of` and the Program's
`program-leaf-source` markers: the **matching source marker remains discoverable after unlink**.
Resume idempotently — unlink only when still linked; close only when still open;
an already completed step is a no-op. The final atomic wave has no child set.

Then set the bucket via the helper — the leaf already exists, so the workflow-label write goes through `board-sync.py add --bucket` (§5a forbids a bare `gh issue edit --add-label ready-for-agent`):

```bash
# AFK (buildable now): set ready-for-agent
python3 scripts/board-sync.py add --issue <prd#> --bucket afk
# HITL (grill first): strip ready-for-agent + the body carries the `headings.vorBau` heading (§5c)
python3 scripts/board-sync.py add --issue <prd#> --bucket hitl
```

`--bucket hitl` strips the label mechanically (a HITL leaf is never buildable — same invariant `create --hitl` enforces by rejecting). Bucket semantics + the `headings.vorBau` heading requirement → §5c (the authority is `execute-ready-check.py`).

#### 5c. HITL/AFK — label + body (`ready-for-agent` is the discriminator)

Every child **and** the atomic leaf sits in **exactly one** bucket:

| Bucket | `ready-for-agent` | Status | Body |
|---|---|---|---|
| **AFK** (buildable now) | **present** | `Spec` | complete What + AC |
| **HITL** (grill first) | **absent** | `Spec` | mandatory `headings.vorBau` heading (board profile `docs/agents/board-sync.md`; <project> currently `## Vor Bau zu klären`) with the open questions known from the macro-grill |

Status alone cannot discriminate (both are `Spec`) — the **label** does. The helper's `--hitl` flag rejects a `ready-for-agent` label mechanically. Authority = `scripts/execute-ready-check.py` (`parse_bucket`) — the checker wins on a mismatch.

**A mandatory human or external setup action is never AFK.** Cut it as a HITL gate
slice (or an explicitly named planning wave), place it before the dependent build
slice, and set the native blocked-by edge. Never hide a maintainer configuration,
credentialless console action, approval, or design response inside a leaf carrying
`ready-for-agent`, even when the remaining code work could run unattended.

**Gate slices (🔬/📐) are AFK.** A `🔬` Verify-Spike or `📐` Trade-off/Research gate slice is **read-only** (a fact question, or a bounded trade-off + read-only research) — an agent can run it solo, so it carries `ready-for-agent` like any other AFK slice; the **native blocked-by edge** on its dependent build slice (set at publish, §5a step 5) is what protects the gate-before-build ordering (§3b/§4), not the HITL bucket. Only a `🧭` Design-Grill gate slice is HITL (it needs the human in the grill). A gate slice's **placement** — which altitude/layer it lands on — follows `decision-gate`'s placement rule (owned there, referenced here).

#### 5d. Issue body template (each child / atomic leaf)

<issue-template>
<!-- slice-id: <stable-kebab-id> -->
<!-- parent-prd: #<prd#> -->   <!-- omit for an atomic leaf -->
**plan_revision:** r<N>        <!-- child mirrors the anchor's revision; atomic leaf carries its own -->

**Part of:** Welle <N> · Anchor #<prd#>   <!-- visible child→anchor link (bare #N, not a /issues/ URL); omit for an atomic leaf -->

## Blast-Radius
**Primary:** <files this slice directly rebuilds — comma-separated>
**Transitive:** <indirectly touched/read files, "—" if none>
<!-- structured (Primary/Transitive), NOT a scalar "~N files": board-sync intersects Primary∪Transitive
     with the known LoC-offender baseline → loc-offender marker (Phase 1, early warning). An optional
     pre-push LoC gate (`scripts/loc_offender_gate.py`, opt-in) is the enforcing authority (Phase 2).
     Recon estimate at the cut: the build session checks the stamped estimate against its own finding,
     real >2× → STOP, re-cut at the anchor. -->

## What to build
End-to-end behavior of this vertical slice (not layer-by-layer). Avoid file paths/snippets (stale fast).

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by
Reference the blocking ticket(s), or "None - can start immediately".
<!-- machine-written MIRROR since: publish sets the edges natively (dep-add,
     §5a step 5) and the helper maintains this section — never hand-edit it; on
     conflict the native dependency API is the truth. Tracker without native
     dependencies → this section is the primary record (kit fallback). -->

## Vor Bau zu klären   <!-- heading = board profile `headings.vorBau` (docs/agents/board-sync.md); HITL only — the open decisions; omit for AFK -->
- <open question 1>

## Verification Question   <!-- 🔬 Verify Spike only — omit otherwise -->
**Question (Yes/No):** <exactly one falsifiable question>
**Scope/Version:** <Lib@version / Runtime / DB / platform context>
**YES looks like:** <concrete output/evidence>
**NO looks like:** <concrete output/evidence>
**Verdict sink:** <ADR / this body / follow-up slice #N>

## Trade-off   <!-- 📐 Trade-off/Research only — omit otherwise -->
**Options:** <competing approaches>
**Criteria:** <decision axes, e.g. complexity / blast radius / reversibility / fit>
**Trade-offs:** <table of options × criteria, each cell backed by evidence (`file:line` / measurement / doc) — no adjectives>
**Decision:** <chosen option + why it wins on the criteria that matter + what was consciously traded off>
**Verdict sink:** <ADR / this body / follow-up slice #N>

## Handoff Start Command
<!-- SELF-CONTAINED: scope + live-verify live HERE, never as a "see anchor
     handoff" pointer — the anchor carries no per-slice handoff blocks anymore, and a
     leaf→anchor→leaf reference loop made every build session read both. -->
<!-- mirror-xform:start codex-escalation -->
```
Welle <N> · Slice <X> (<closes #x | refs #<prd#>, Parent #<prd#>>). Read #<prd#> for decisions.
Start skill: 🧭 Design Grill → /grill-with-docs · 🔬 Verify Spike → /verify-spike · 📐 Trade-off/Research → /decision-gate · AFK → /implement · HITL → /grill-me → /implement.
Routing intent: `routing-intent: <judgment | development | mechanical>` · `reasoning-intent: <deep | balanced | light>`. The dispatching surface resolves the current executable route; never persist that provider route here.
Worktree: your project's worktree helper, or `git worktree add`
Scope (<N> files) — REQUIRED FIELD, blast-radius estimate at cut time; the build session checks it against its own recon findings, >2x deviation → STOP:
- <concrete file + change>
Live-verify: <user outcome, DB/UI value with comparison>
PR: <closes #x | Part of #<prd#> — NEVER closes on the anchor>.
```
<!-- mirror-xform:end -->

At execution time, consume that provider-neutral intent only through
`src/lib/routeDispatcher.mjs` and its shared spawn guard. The active Claude or
Codex adapter must produce Dispatch receipt v2 with requested/applied route,
model/effort enforcement, precedence, and catalog/access/policy revisions
before an AFK subagent starts; the durable issue never claims that proof.
</issue-template>

**Blast-radius reconciliation (build session):** the stamped `**Blast-Radius:**` is the estimate *at the cut* — the build session compares it against its own recon finding. A real finding **> 2× the estimate → STOP + report** (re-cut at the anchor), do NOT keep building silently.

### 6. Idempotent reconcile (re-run)

A re-run (or a re-grill that re-enters the pipeline) must leave the affected sub-graph coherent. **Mutation is one top-down pass rooted at the resolved anchor:**

```bash
# entered from a child? lift to its anchor, then enumerate all siblings
PARENT=$(python3 scripts/board-sync.py parent-of <child#>)        # FREE = atomic leaf
python3 scripts/board-sync.py children-of "$PARENT"              # the full child set to reconcile
```

- Diff each child against the anchor; update bodies; stamp `plan_revision` on **every** child (mirrors the anchor's revision — coherence = `child.rev == parent.rev`) and on the atomic leaf (its own fingerprint, like `to-prd`). Missing/malformed `plan_revision` → treat as `r1` + warn.
- **Never silently mutate across a boundary:** a foreign-parent child (`link` conflict), a cross-anchor dependency, or an **atomic↔promoted flip** is **reported as drift and stopped**, not auto-restructured. On a flip (a 1-slice PRD that now needs ≥2, or vice-versa), stop with an instruction — confirm the promote/demote, then spin the old scope into a child — because auto-demoting a PRD that may already have an open `closes` PR is exactly the silent structural mutation that closes anchors prematurely.

### 7. Execute-ready exit assertion + audit (non-blocking)

After publishing/reconciling, run the shared checker (the same logic the **blocking** Drift-Guard uses at handoff):

```bash
python3 scripts/execute-ready-check.py --issue <anchor-or-leaf#> --mode audit
```

It asserts, for the rooted local graph:
- every child + the atomic leaf is in **exactly one** bucket (AFK: `ready-for-agent` + complete · HITL: no `ready-for-agent` + the `headings.vorBau` heading, §5c);
- `plan_revision` stamped and coherent (child == anchor, leaf own); no stale in-between;
- Parent↔Child consistent (anchor carries no bucket / no `ready-for-agent`);
- ** Anchor shape** (`## Origin`/`## Decisions`/`## Slices` + body header line — legacy German anchors' `## Herkunft`/`## Entscheidungen`/`**Welle N —**` satisfy it too) — as **`shape_warnings`** (purely non-blocking, **never** flows into `deny_recommended`).

If the source was a `wave-stub` stub, briefly confirm the label is gone (the publish mechanic strips it automatically — see §5): `gh issue view <anchor-or-leaf#> --json labels -q '.labels[].name'` shows **no** `wave-stub`. (Not part of `execute-ready-check.py` — its own quick check.)

`--mode audit` is **non-blocking** — a mismatch is a **loud warning** here; the
**hard block** is `.claude/hooks/drift-guard.py` at handoff-creation. Emit a
visible audit that names the selected facade mode:

```
to-issues: planning-mode=feature anchor=#<X> mode=<promote|atomic> slices=<n> rev <old>→<new>
  source=<draft-prd|raw-issue|external-prd|bundle>  synthesized=<marker-list | none>
  AFK=[#a #b] HITL=[#c] · drift=<none | …>  shape=<ok | warn:…>
```

The Program graph engine emits `planning-mode=program` in its own counted audit
after the complete preview gate; the facade relays that audit unchanged.

Do NOT close or modify any parent issue beyond the promote stamp.
