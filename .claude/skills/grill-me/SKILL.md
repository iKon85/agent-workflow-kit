---
name: grill-me
disable-model-invocation: true
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time.

If a question can be answered by exploring the codebase, explore the codebase instead.

## Coherence is the default — the grill locks only the deltas

A feature that builds on existing features inherits the existing building blocks by default, across **every** layer: the UI renders the same components, the backend calls the same services and calculations, data flows through the same paths, conventions carry over. Do not interview the user about how such a feature should look or behave where an existing counterpart exists — that is already decided. Lock only:

1. **The deltas:** what is intentionally excluded, restricted, or different (navigation, filters, actions, person data, write access, …). Every delta is an explicit decision with a reason.
2. **The consumer walk-through:** who consumes the result and what they see/get — walked through from the consumer's side, not the owner's.

A parallel rebuild of something that exists — a simplified UI stand-in, a re-implemented calculation, a second data path — is a defect to surface, never a silent shortcut. (Incident: a share feature shipped rebuilt, simplified renderers across 6 pages because "looks like the page minus chrome" was treated as open design space instead of the default; half the implementation was replaced.)

## Querschnitts-Weiche — Muster vs. Konzept (vor Plan-Lock)

Ist die Änderung **querschnittig** (neues Muster/Pattern ODER neue Datenstruktur/Domänen-Unterscheidung, betrifft ≥3 Stellen, ODER „überall / X von Y unterscheiden / migrieren")? Dann **während des Grills** klassifizieren — nicht in die Post-Spec-Self-Critique vertagen (sonst reviewt Codex einen Plan ohne sie):

- **Muster** (Alt→Neu, z.B. TanStack-Query ersetzt manuelles Laden): der Nenner ist **grep-bar** → in den Plan: Census aller Alt-Stellen + ein `*.guard.test.ts`, der rot bleibt, solange Alt-Stellen außerhalb einer schrumpfenden Allowlist existieren.
- **Konzept** (neue Unterscheidung, z.B. Projekt↔Kampagne): `grep` findet die **Abwesenheit** eines Konzepts nicht → in den Plan: eine **code-abgeleitete** Flächen-Liste (Routen/Seiten/Exporte/Auswertungen) × **fachliches Verdikt pro Fläche** (zählt / N/A / offen); „zählt"-Zeilen werden getrackte Items.

„vollständig" nie aus Plan/Gedächtnis behaupten — Nenner frisch zählen, `X von Y` melden. Substanz, Trigger-Schwelle + Guard-Template → die Projekt-Konvention-Datei `docs/conventions/spec-completeness.md` (falls vorhanden), §Querschnitts-Weiche.

## Plan-Lock — PLAN.md schreiben

Sind alle Entscheidungen getroffen (Plan gelockt, vor Sign-off/Übergang) und läuft die Session in einem **Worktree** → den gelockten Plan als `PLAN.md` in den Worktree-Root schreiben (gitignored seit, reist nicht über git — Konsistenz mit CLAUDE.md „im Worktree planen"). So überlebt der gelockte Plan einen Session-Schnitt und `to-prd` findet seine Default-Quelle. Same-session-Weiterarbeit **ohne** Worktree bleibt erlaubt (Konversation = Quelle); aber bei beabsichtigtem **Session-Schnitt** vor `to-prd` ist die `PLAN.md` Pflicht. (Die `-codex`-Variante schreibt die `PLAN.md` ohnehin schon.)

## Re-Grill Reconcile — execute-ready (Welle 26)

Greift, wenn du ein **bereits existierendes Issue re-grillst** (ein Leaf eines gegrillten Epics oder ein Kind eines Ankers) — der häufigste Re-Grill-Pfad, weil Kampagnen-HITL-Slices über `/grill-me → /tdd` routen. Ziel: der gewurzelte Teilgraph tritt **execute-ready** aus, nie stiller Drift. (grill-me hat keinen Doku-Layer — CONTEXT.md/ADR entfallen; Kern-Regeln identisch zu grill-with-docs §„Re-Grill Reconcile".)

1. **Parent-Anker-Entscheidungen ZUERST lesen** — Anker-Body + dessen PRD/Key-Decisions holen, die Seam-Entscheidung **von dort** nehmen. Architektur **nicht** aus dem Leaf neu herleiten (Lehre: ein Leaf, dessen zentrale Entscheidung nie gelesen wurde, wurde durch Frage-Runden re-litigiert). Atomar-Leaf → eigener Body/PRD ist die Referenz.
2. **Leaf auf inneren Widerspruch prüfen**: ein Body, der sich selbst („kein neues UI" + „baue Namensfeld") oder die Anker-Entscheidung widerspricht → **kein Execute**. Ebenso ein Leaf, das *„finaler Schnitt hängt an #X"* via `<!-- final-cut-depends-on: #X -->` sagt, wo **#X geschlossen** ist, ohne den Schnitt aufzulösen.
3. **Bei Drift/Widerspruch:** betroffene Issue(s) updaten, `plan_revision` neu stempeln, korrekten Bucket setzen. Innerer Widerspruch → Leaf auf **HITL**: `ready-for-agent` strippen via `python3 scripts/board-sync.py add --bucket hitl --issue <n>` (Helper bleibt Owner der Workflow-Labels — kein bares `gh issue edit --add-label`), `## Vor Bau zu klären` ergänzen. Der Drift-Guard blockt dann den Build-Handoff über `target_buildable` — der Widerspruch fließt durch bestehende Mechanik, keine Heuristik im Hook.
4. **Audit, non-blocking:** `python3 scripts/execute-ready-check.py --issue <n> --mode audit` → sichtbarer Zweizeiler. Das **blockierende** Netz ist der Drift-Guard am Handoff (`.claude/hooks/drift-guard.py`).

**Marker** (HTML-Kommentare, grep-bar): `<!-- guard-ack: #<n> r<N> reason:<text> by-user -->`, `<!-- final-cut-depends-on: #<n> -->`, `<!-- handoff-intent: build|grill -->`, `<!-- guard-legacy -->`. Kanonische Tabelle aller Marker: Modul-Docstring von `scripts/execute-ready-check.py`.
