---
name: to-prd
disable-model-invocation: true
description: Turn a locked plan (PLAN.md in the worktree, conversation context, or an externally-authored spec) into a Draft-PRD issue on the project board, then run spec-self-critique. Use after a grill (grill-me / grill-with-docs / their -codex variants) when you want to publish the PRD. Two modes — create fresh, or reuse an existing cluster/Wave-less issue. Does NOT decompose into slices (that is to-issues) and does NOT set type:cluster / Wave (that is to-issues promotion).
---

# to-prd — Draft-PRD aufs Board

Nimmt einen **schon-gelockten Plan** und publiziert ihn als **Draft-PRD-Issue**. **Erfindet keine Requirements** — synthetisiert nur, was schon entschieden ist. Pipeline: `board-to-waves → grill(-with-docs) → to-prd → to-issues`. Der **Grill sitzt davor**; to-prd schreibt die PRD nach dem Grill. **Zerlegung in Slices + Promotion zum Anker (cluster/Wave, Kind-Link) = `to-issues`** (künftig), nicht hier.

Board-Konstanten (Project-Node, Field-/Status-IDs) + Helper liegen **consumer-seitig**: vom Projekt-Root `docs/agents/board-sync.md` lesen + den Helper `scripts/board-sync.py` nutzen (fehlen sie → `/setup-workflow` scaffoldet den Projekt-Layer). Issue-Body **immer** `--body-file` (inline `--body` mit Backticks/Klammern crasht bash).

## 1. Eingang — quellen-agnostisch

to-prd liest den gelockten Plan, egal woher:
- **Default: `PLAN.md` im aktuellen Worktree** — was die `-codex`-Grills (`grill-me-codex` / `grill-with-docs-codex`) immer schreiben (Codex-Review-Akt braucht die Datei); `grill-me` / `grill-with-docs` schreiben `PLAN.md` nur konditional (bei Worktree-/Session-Schnitt).
- **Fallback: Konversations-Kontext** (same-session, ohne PLAN.md).
- **Extern übergeben:** anderswo erstellte Spezifikation (z.B. Claude Web/Codex), in den Kontext gereicht.

Liegt eine `PLAN.md` im Worktree, ist sie die Quelle; sonst Konversation/extern.

**Kalt-Einstieg = extract-or-synthesize, nicht assume-or-fail.** `to-prd` ist der **universelle Normalisierer** für lose Artefakte (Plan/Doc/externe PRD ohne Board-Issue): die PRD-Template-Sektionen werden **aus dem Vorhandenen extrahiert**, statt einen vorherigen Grill vorauszusetzen. `to-prd` **mandatet keinen** Grill und **keinen** Codex — die Tiefe ist die Wahl der einsteigenden Person.
- **Nicht-ableitbare Pflicht-Sektion ≠ stiller „complete"-Platzhalter:** lässt sich eine Pflicht-Sektion (z.B. „Testing Decisions") aus dem Input **nicht** herleiten, wandert der offene Inhalt in eine **`## Offene Punkte (nicht aus Input ableitbar)`**-Sektion — die PRD ist dann ehrlich *offen* statt fälschlich *vollständig*. `spec-self-critique` (Schritt 5) bleibt Pflicht.
- **Downstream-Vertrag:** ein nicht-leeres `## Offene Punkte` zwingt `to-issues`, die betroffenen Slices als **HITL** (`## Vor Bau zu klären`) zu publishen oder vorher nachzufragen — die offenen Punkte verschwinden nie still (s. `to-issues` §3b).

## 2. Modus erkennen — neu vs bestehendes Issue

Kein User-Flag — auto:
- **Modus A (frisch):** kein Ziel-Issue → to-prd legt eine neue Draft-PRD an.
- **Modus B (Wiederverwendung):** ein **cluster/Wave-loses** Issue existiert schon (frühere Draft-PRD beim Re-Lauf, oder ein entkernter `board-to-waves`-Kandidat-Stub) → to-prd schreibt die PRD **in dieses Issue** (kein Duplikat).

**Hard-Stop vor jedem Write:** trägt das Ziel-Issue `type:cluster` (Label) ODER eine Wave-Nummer → **abbrechen** und melden: „cluster/Wave-Anker ist kein to-prd-Ziel — gehört in den Wave-Modell-/`to-issues`-Pfad". to-prd **setzt nie** cluster/Wave und **strippt sie nie** — es arbeitet ausschließlich auf cluster/Wave-losen Issues. Wave lebt im Projects-v2-**Feld**, nicht als Label → vor dem Write das Board-Item lesen:
```bash
gh project item-list 1 --owner <owner> --limit 500 --format json   # Wave-/cluster-Zugehörigkeit des Ziels prüfen
```

## 3. Ziel-Identität — Identität ≠ Inhalt

- **Modus B:** Ziel-Issue-Nummer **explizit** (übergeben/aus Kontext). Branch-Ableitung `feat/<#>-…` **nur**, wenn die Operation ausdrücklich „dieses Issue updaten" sagt — der Slice-Branch ist **nicht** automatisch die PRD.
- **Modus A — Idempotenz über zwei getrennte Marker im Body:**
  - **Stabile Source-Identität** `<!-- prd-source-id: <id> -->` — ändert sich **nie** über Plan-Inhalts-Änderungen hinweg (sonst verfehlt search-before-create den geänderten Re-Lauf → Duplikat). **Default-Regel** für `<id>` (Identität ≠ Inhalt; beim **ersten** to-prd-Lauf gesetzt, danach **nie** geändert — der Slug steht ab dann im Issue-Body und ist via search-before-create auffindbar): kebab-case-Slug des Plan-Themas. Priorität: **(1)** explizit übergebene ID / durable Issue-Nr → **(2)** bestehender Slug aus früherem Lauf (per search-before-create gefunden) → **(3)** neuer kebab-case-Slug aus dem Plan-/Titel-Thema. Der `PLAN.md`-Pfad ist nur **sekundärer Hinweis** (nicht stabil über Worktrees; externe Specs haben keinen), **nie** die ID selbst.
  - **Separater Content-Fingerprint** `<!-- prd-content-fp: <hash> -->` — nur für Diff/Audit/Bump-Entscheidung, **nicht** für Identität.
- **search-before-create:** **kein** Verlass auf GitHub-Search (indexiert HTML-Kommentare nicht). Bounded lokal:
  ```bash
  gh issue list --repo <owner>/<repo> --state open --limit 500 --json number,body,labels
  # lokal auf `prd-source-id: <id>` filtern → 1 Treffer ⇒ update; >1 ⇒ STOP+melden; 0 ⇒ create
  ```

## 4. Draft-PRD schreiben (Deliverable)

1. Repo/Code verstehen (falls noch nicht), Domänen-Glossar + ADRs respektieren. Deep Modules skizzieren, mit dem User abgleichen (welche getestet).
2. PRD nach dem Template unten schreiben.
3. **Board-Sync (Pflicht):**
   - **Status `Spec`**, genau **ein** `type:*` (Default `type:feature`; reiner Prozess/Workflow-Scope → `type:followup`/`type:research` nach Intent) **plus** ein `priority:*` (Pflicht-Vokabular „type+priority"). **Kein** `type:cluster`, **keine** Wave, **kein** `ready-for-agent` — eine Draft-PRD ist noch **nicht baubar**, sie wartet auf `to-issues`-Zerlegung.
   - Board-Sync via Helper:
     ```bash
     python3 scripts/board-sync.py create --title "<PRD-Titel>" --body-file <prd.md> \
       --label type:feature --label priority:medium --status Spec        # Modus A
     # Modus B: gh issue edit <ziel> --body-file <prd.md>  +  board-sync.py add --issue <ziel> --status Spec
     ```
   - **Modus B — Status-Flip explizit:** Schreibst du die PRD in einen `board-to-waves`-Stub, flippt `board-sync.py add --issue <ziel> --status Spec` den Board-Status **Triaged → Spec** (der Stub stand auf Triaged; eine Draft-PRD steht auf Spec).
4. **Body-Marker (im PRD-Body, oben):**
   - `**plan_revision:** r1`
   - `<!-- prd: awaiting-decomposition -->` — durabler Distinguishability-Marker: macht „PRD wartet auf `to-issues`" board-auffindbar **ohne** neues Label (Status `Spec` allein deckt auch geplante Anker/andere Specs).
   - `<!-- prd-source-id: <id> -->` + `<!-- prd-content-fp: <hash> -->` (s. Schritt 3).
5. **Modus-B-Label-Normalisierung:** trägt das wiederverwendete Issue falsche/mehrfache `type:*`, fehlende `priority:*`, `ready-for-agent` oder `needs-info` → **auf den PRD-Vertrag normalisieren** (genau ein `type:*`, ein `priority:*`, kein `ready-for-agent`/`needs-info`). Ausnahme `type:cluster`/Wave → **kein** Normalisieren, **Hard-Stop** (Schritt 2).

## 5. `spec-self-critique` — verpflichtender nächster Schritt

to-prd hat `disable-model-invocation: true` und kann kein Skill literal aufrufen. **Nach** dem PRD-Write **muss** der Agent `spec-self-critique` auf die Draft-PRD laufen lassen; dessen sichtbarer Zwei-Zeiler (`Self-Critique abgeschlossen — N Korrekturen: …` bzw. `…keine Korrekturen nötig`) ist Pflicht-Output **vor** der User-Review-Frage.

## 6. Idempotenter Reconcile (Re-Lauf)

- **`plan_revision`-Parse:** Counter `r<N>`; fehlend/malformed → als `r1` behandeln + Warnung. **Body-ändernd** = nicht-leerer Diff über die **kanonischen PRD-Sektionen** (Problem/Solution/User-Stories/Implementation-Decisions/Testing), **exklusive** Metadata-Marker, Kind-Drift-Sektion und Critique-Output. Identischer Plan-Re-Lauf bumpt **nicht**.
- **R1 — keine Kinder:** Body updaten statt duplizieren; `plan_revision` bumpen nur bei body-änderndem Lauf; Critique neu.
- **R2 — Kinder/Cluster existieren:** Body updaten + bumpen + **durabel flaggen** — eine **`## Kind-Drift (Stand r<N>)`-Sektion im Body** (kein ephemerer Chat-Output) listet Kinder + deren Revision. **Keine** Kind-Mutation (= `to-issues`/1d), **kein** blockierender Guard (= 1g).
- **Kind-Discovery:** native Sub-Issues (via `python3 scripts/board-sync.py parent-of <#>` / Rollup) sind die autoritative Menge; Mismatch native-vs-Body-gelistet in der Drift-Sektion melden.

## 7. Execute-ready-Assertion (Exit)

- **Vor dem Write (Gate):** Ziel trägt cluster/Wave → **fail before write** (Hard-Stop, Schritt 2) — nie „nach dem Write reconcilen".
- **Nach dem Write:** assertieren, dass die Draft-PRD **als Board-Item existiert** (Status-Write = `Spec`), genau **ein** `type:*` + **ein** `priority:*`, **kein** `ready-for-agent`, **kein** `type:cluster` + **keine** Wave (defensiv gegen versehentliche Mutation), trägt `plan_revision` + `awaiting-decomposition` + `prd-source-id`, Body vollständig (Critique lief). = eindeutiger „PRD-awaiting-decomposition"-Zustand (weder AFK-Leaf noch HITL-Child — das entscheidet `to-issues`).

## 8. Audit-Block (sichtbarer Output)

```
to-prd: mode=<A|B> target=#<n> <created|updated> rev <old>→<new>
  status=Spec  labels=<type:*, priority:*>  cluster/Wave=none
  source=<plan|conversation|external>  synthesized=<marker-liste | none>  readiness=<ok | offene-punkte>
  child-drift=<none | #a(r1) #b(r1) …>
```
`source` = woher der Input kam (Kalt-Einstieg sichtbar machen). `synthesized` = welche Marker `to-prd` frisch gesetzt hat (z.B. `prd-source-id`). `readiness=offene-punkte` ⇔ die PRD trägt eine nicht-leere `## Offene Punkte`-Sektion.

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>
