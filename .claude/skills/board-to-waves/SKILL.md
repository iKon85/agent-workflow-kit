---
name: board-to-waves
disable-model-invocation: false
description: >-
  Use when sweeping/grooming the GitHub backlog board to cluster open issues
  into thematic waves (Wellen) — "lass uns das Board durchgehen", "was ist
  offen und passt zusammen", "clustern wir den Backlog", "welche Wellen stecken
  da drin" — or to spot candidate waves before planning. Reads all open issues,
  groups them by the Gate+Booster+Splitter heuristic, estimates size/risk +
  grill-needed per candidate, and after the user confirms creates
  cluster/Wave-less candidate STUB issues with a To-Do checklist. STOPS at
  stubs: no PRD, no slicing, no sub-issue links, no promotion (downstream:
  to-prd matures the stub, to-issues slices + promotes). NOT for
  maturing/slicing ONE already-chosen candidate (to-prd/to-issues), NOT for
  per-issue triage labelling (triage), NOT for code comprehension (zoom-out) —
  this is board-WIDE thematic affinity grouping, not per-issue and not
  code-reading.
---

# board-to-waves

**Survey the board → cluster open issues by theme → anchor stub issues.** Systematizes how Welle F came about: first look at what's open and what fits together, then form thematic waves. Result lands durably as an anchor issue on the board (GitHub = SSOT), not as a chat list.

## Pipeline Position

```
board-to-waves   Board → candidate STUB issues (cluster/wave-less, size + grill-needed flag)   ← HERE
                         ↓ (<maintainer> picks waves)
[optional]       dedicated grill-with-docs session — only if the flag fires
                         ↓
to-prd           matures the stub into a Draft PRD (Mode B)
                         ↓
to-issues        slices + promotes (sets type:cluster + Wave at ≥2 slices)
```

**Stops at stubs.** No slice plan, no PRD, no sub-issue link, no promotion. Whether/when a stub becomes a real wave = separate step (`to-prd → to-issues`), <maintainer>'s call.

Model: **strongest available reasoning model for board-wide judgment calls** (survey/plan/brainstorm — cross-board judgment, <maintainer>'s table).

## Wave Numbering & Registry

**Format:** `Welle <N> — <Thema>` (hybrid: number orders, topic gives context). **The wave number is only assigned at `to-issues` promotion** — the board-to-waves candidate stub is cluster/wave-less and carries **no** `Welle <N> —` prefix in the title yet (`to-issues` sets it on promote).
**Carrier = Wave field (number)** on the **anchor** (mandatory — source of truth + board sort key, set at promotion). NOT the title string, NOT the `wave:*` label (both deprecated for waves). Member/sub-issues get the Wave field + native parent link at `to-issues` promotion (not yet at clustering time): the parent link carries the assignment semantically, the Wave field makes it board-filterable — without the Wave field an assigned issue wrongly shows up in the "wave-less" view (`is:open no:wave -label:"type:cluster"`).
**N = monotonic auto-increment ID:** `max(assigned wave numbers) + 1`. Ascending, never reused, never letters, never retroactively resorted (like issue numbers). Gaps are fine. `to-issues` pulls the next free number at promotion via the shared board-sync helper (`scripts/board-sync.py` `next-wave`) — board-to-waves itself assigns **no** wave.

**Registry = board-native, no doc file:** view filter `type:cluster`, sort `Wave` ascending, columns Status + sub-issues progress. The anchor issues + Wave field **are** the registry. Active wave = `type:cluster` + status `In Arbeit`. Wave field ≠ `Cluster (G-number)` field (roadmap G-cluster, orthogonal). No milestones (progress comes from the sub-issue rollup).

## Clustering Heuristic — Gate + Booster + Splitter

**🚦 Gate (mandatory — without it, no wave, just a pile):** shared **through-line / outcome**. The issues must serve *one* product outcome (e.g. "market/partner readiness" = Welle F).

**➕ Boosters (the more that fire, the clearer a wave):**
| # | Criterion | Board signal |
|---|---|---|
| B1 | Code proximity / change coupling | same files/paths in issue bodies; historically co-changed (`git log`) |
| B2 | Type homogeneity | same `type:*` / `dimension:*` labels |
| B3 | Dependency chain | `blocked` label, "blocked by" / mutual refs |
| B4 | Shared verify surface | same page/surface live-testable |

**✂️ Splitters (separate DESPITE affinity):**
- **S1 Too big** — > ~7 slices / not shippable in a manageable sequence → split into two waves.
- **S2 Foreign parent** — issue already hangs under another wave (GitHub 1-parent; `to-issues` link check is the final word).
- **S3 "Same type alone" ≠ wave** — type is a booster, never a gate. Otherwise "all refactors" becomes a junk drawer.

**Rule:** issue → candidate X if **Gate(X) satisfied AND ≥1 booster fires** and no splitter applies. Otherwise: own candidate or leftover bucket "unclustered / standalone issue".

**Sequencing WITHIN a wave** (belongs to `to-issues`, noted here only): WSJF-lite — visible+low-risk → logic/backend → cleanup; dependencies force order.

> References: Atlassian/Mountain Goat (epics/themes), CodeScene/Tornhill (change coupling), SAFe (WSJF), ProductPlan/Asana (affinity/batching).

## Size + `grill-needed` (per candidate)

- **Size + risk** as a rough effort estimate (no fixed time commitment): rough slice count, backend yes/no, model mix, risk level (race/cache/forecast/migration → high).
- **`grill-needed` flag** — fires when: many slices OR fuzzy (members are `type:idea`/`type:research`, undecided) OR cross-subsystem OR open product decisions. = low decision maturity.
  - **"this session"** when manageable, **"own session"** when too big/fuzzy to do on the side. Recommendation goes into the stub, **<maintainer>'s call**.

## Procedure

### 1. Read the board
```bash
gh issue list --repo <owner>/<repo> --state open --limit 500 \
  --json number,title,labels,body
```
`--limit 500` (item/issue-list caps **silently**, `docs/agents/board-sync.md`). Already-parented issues get recognized later at link time — title/labels/body suffice here.

### 2. Cluster
Apply the heuristic. Per candidate, capture: topic (gate outcome), members (#…), firing boosters, splitter checks, size+risk, `grill-needed`+when. Issues that reach no gate+booster → leftover bucket, **do not** force-cluster.

### 3. Propose candidates (<maintainer> chooses)
Concise list, per candidate **which criteria fired** visible (rationale):
```
Candidate A "<Outcome>": #a #b #c
  Gate=<Outcome> · B1 all frontend · B2 all type:refactor
  Size ~4 slices, risk low · grill-needed: no
Candidate B "<Outcome>": #x #y …
  … · grill-needed: yes (own session — cross-subsystem)
Rest (unclustered): #m #n …
```
**<maintainer> confirms** which become real waves. Only confirmed → step 4.

### 4. Create candidate stubs (per confirmed candidate)
Body from `docs/agents/wave-anchor-template.md` **stage 1** (header + cluster origin + to-do checklist; slice table empty). Body **always** via `--body-file` (`gotchas_gh_body_file`).

**All board write mechanics (create stub, attach to board, stamp status) go through the shared board-sync helper** `scripts/board-sync.py` — no bare `gh issue create`/`gh project item-*` in this prose (enforced by lint; board constants live in `docs/agents/board-sync.md`).

**Idempotency — stub marker + search-before-create (mandatory, BEFORE `create`).** Re-runs of board-to-waves must **not** produce duplicate stubs (a duplicate stub would confuse Mode-B identity in `to-prd`). Mirrors the `to-prd` pattern:
- **Stable stub marker** `<!-- wave-stub-source: <topic-slug> -->` as the **first body line** of every stub. `<topic-slug>` = kebab-case slug of the gate outcome; set on the **first** run, **never** changed after (identity ≠ content — the slug stays findable even if members/size change later).
- **search-before-create** per candidate **before** the `create`. **No** reliance on GitHub search (doesn't index HTML comments) — bounded, local:
  ```bash
  gh issue list --repo <owner>/<repo> --state open --limit 500 --json number,body,labels
  # locally filter on `wave-stub-source: <topic-slug>` → 1 match ⇒ skip + report (stub exists); >1 ⇒ STOP + report; 0 ⇒ create
  ```

**Create the candidate stub (cluster/wave-less)** — issue **without** `type:cluster` and **without** `--wave` (exactly one `type:*` + one `priority:*`; title **without** a `Welle <N>` prefix, since the wave number is only assigned at promotion), **with `--wave-stub`** (a searchable "awaiting planning" filter — the HTML marker above is only locally greppable, GitHub doesn't index it), attach to the board, status `Triaged` (clustered, not yet planned). `to-prd` then matures the stub (Mode B) into a Draft PRD, `to-issues` promotes it to an anchor (sets `type:cluster` + Wave then, **strips `wave-stub`** — the stub leaves the planning list):
```bash
python3 scripts/board-sync.py create \
  --title "<Outcome/Thema>" \
  --body-file <stub.md> \
  --label "type:feature" --label "priority:medium" \
  --wave-stub \
  --status Triaged
```
Outputs `#<STUB_NUM> <URL>`. `--dry-run` shows the `gh` calls without writing. (Fuzzy/undecided candidate → `type:research` instead of `type:feature`.)

**Search open stubs** (= "what still needs planning"): `gh issue list --label wave-stub --state open` or board filter `is:open label:wave-stub`. At `to-issues` promotion (wave) **or** atomic publish (`add --bucket`), `wave-stub` is stripped automatically — no manual edit.

**Member issues:** list in the stub body (#…). **No** wave stamp and **no** native parent link yet at clustering time — `to-issues` sets both at promotion. That members show up in the "wave-less" view (`is:open no:wave`) until then is **correct**: a candidate isn't a committed wave yet.

### 5. Output
```
Clustered: <N> wave candidates, <M> confirmed → cluster/wave-less stubs created.
  Candidate <X> #<STUB_NUM> — #a #b #c · ~4 slices · grill: no
  Candidate <Y> #<…>       — #x #y   · ~8 slices · grill: own session
Rest (unclustered): #m #n …
Next step (<maintainer>'s call, separate): grill → to-prd (matures the stub) → to-issues (slices + promotes) per chosen candidate.
```

## Notes
- **Stops at stubs.** Never write the PRD, slice, link, promote, or call `to-prd`/`to-issues` yourself.
- Boundary: `triage` = per-issue state machine; `zoom-out` = code comprehension; `board-to-waves` = board-wide thematic affinity. Different altitudes.
- A leftover bucket is OK and intentional — not every issue belongs in a wave. Force-clustering dilutes the gate.
- Size/risk are a rough estimate, not a commitment. <maintainer> can override the stub's "when to grill" recommendation at any time.
