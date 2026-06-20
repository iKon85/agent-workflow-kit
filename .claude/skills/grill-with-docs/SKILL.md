---
name: grill-with-docs
disable-model-invocation: true
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation (CONTEXT.md, ADRs) inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions.
---

<what-to-do>

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing.

If a question can be answered by exploring the codebase, explore the codebase instead.

</what-to-do>

<plan-lock>

## Plan-Lock — PLAN.md schreiben

Sind alle Entscheidungen getroffen (Plan gelockt, vor Sign-off/Übergang) und läuft die Session in einem **Worktree** → den gelockten Plan als `PLAN.md` in den Worktree-Root schreiben (gitignored seit, reist nicht über git — Konsistenz mit CLAUDE.md „im Worktree planen"). So überlebt der gelockte Plan einen Session-Schnitt und `to-prd` findet seine Default-Quelle. Same-session-Weiterarbeit **ohne** Worktree bleibt erlaubt (Konversation = Quelle); aber bei beabsichtigtem **Session-Schnitt** vor `to-prd` ist die `PLAN.md` Pflicht. (Die `-codex`-Variante schreibt die `PLAN.md` ohnehin schon.)

</plan-lock>

<supporting-info>

## Domain awareness

During codebase exploration, also look for existing documentation:

### File structure

Most repos have a single context:

```
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

If a `CONTEXT-MAP.md` exists at the root, the repo has multiple contexts. The map points to where each one lives:

```
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/                          ← system-wide decisions
├── src/
│   ├── ordering/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                 ← context-specific decisions
│   └── billing/
│       ├── CONTEXT.md
│       └── docs/adr/
```

Create files lazily — only when you have something to write. If no `CONTEXT.md` exists, create one when the first term is resolved. If no `docs/adr/` exists, create it when the first ADR is needed.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update CONTEXT.md inline

When a term is resolved, update `CONTEXT.md` right there. Don't batch these up — capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

`CONTEXT.md` should be totally devoid of implementation details. Do not treat `CONTEXT.md` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

### Coherence is the default — the grill locks only the deltas

A feature that builds on existing features inherits the existing building blocks by default, across **every** layer: the UI renders the same components, the backend calls the same services and calculations, data flows through the same paths, conventions carry over. Do not interview the user about how such a feature should look or behave where an existing counterpart exists — that is already decided. Lock only:

1. **The deltas:** what is intentionally excluded, restricted, or different (navigation, filters, actions, person data, write access, …). Every delta is an explicit decision with a reason.
2. **The consumer walk-through:** who consumes the result and what they see/get — walked through from the consumer's side, not the owner's.

A parallel rebuild of something that exists — a simplified UI stand-in, a re-implemented calculation, a second data path — is a defect to surface, never a silent shortcut. (Incident: a share feature shipped rebuilt, simplified renderers across 6 pages because "looks like the page minus chrome" was treated as open design space instead of the default; half the implementation was replaced.)

### Querschnitts-Weiche — Muster vs. Konzept (vor Plan-Lock)

Ist die Änderung **querschnittig** (neues Muster/Pattern ODER neue Datenstruktur/Domänen-Unterscheidung, betrifft ≥3 Stellen, ODER „überall / X von Y unterscheiden / migrieren")? Dann **während des Grills** klassifizieren — nicht in die Post-Spec-Self-Critique vertagen (sonst reviewt Codex einen Plan ohne sie):

- **Muster** (Alt→Neu, z.B. TanStack-Query ersetzt manuelles Laden): der Nenner ist **grep-bar** → in den Plan: Census aller Alt-Stellen + ein `*.guard.test.ts`, der rot bleibt, solange Alt-Stellen außerhalb einer schrumpfenden Allowlist existieren.
- **Konzept** (neue Unterscheidung, z.B. Projekt↔Kampagne): `grep` findet die **Abwesenheit** eines Konzepts nicht → in den Plan: eine **code-abgeleitete** Flächen-Liste (Routen/Seiten/Exporte/Auswertungen) × **fachliches Verdikt pro Fläche** (zählt / N/A / offen); „zählt"-Zeilen werden getrackte Items.

„vollständig" nie aus Plan/Gedächtnis behaupten — Nenner frisch zählen, `X von Y` melden. Substanz, Trigger-Schwelle + Guard-Template → die Projekt-Konvention-Datei `docs/conventions/spec-completeness.md` (falls vorhanden), §Querschnitts-Weiche.

</supporting-info>

## Re-Grill Reconcile — execute-ready (Welle 26)

Triggers when you **re-grill an issue that already exists in the graph** (a leaf of a grilled epic, or a child of an Anker). Goal: leave the rooted sub-graph **execute-ready**, never silently drift.

1. **Read the Parent-Anker decisions FIRST** — fetch the Anker body + its PRD/Key-Decisions and take the seam decision **from there**. Do **not** re-derive the architecture from the leaf (Lehre: a leaf whose central decision was never read got re-litigated through question-rounds). For an atomar leaf, its own body/PRD is the reference.
2. **Check the leaf for internal contradiction** (Fix B): a body that contradicts itself ("kein neues UI" + "baue Namensfeld") or the Anker decision → **kein Execute**. Likewise a leaf that says *"finaler Schnitt hängt an #X"* via `<!-- final-cut-depends-on: #X -->` where **#X is closed** without resolving the cut.
3. **On drift/contradiction:** update the affected issue(s), re-stamp `plan_revision`, set the correct bucket. An internal contradiction → set the leaf to **HITL** (remove `ready-for-agent`, add `## Vor Bau zu klären`); the Drift-Guard then blocks a build-handoff via `target_buildable`. So the contradiction flows through existing machinery — no semantic heuristic in the hook.
4. **Audit, non-blocking:** `python3 scripts/execute-ready-check.py --issue <n> --mode audit` → visible two-liner. The **blocking** net is the Drift-Guard at handoff (`.claude/hooks/drift-guard.py`).
5. **Global `-codex` variant** can't change the repo → leave a pointer note ("Issues abgleichen + plan_revision stempeln, repo-seitig"); real enforcement = the repo hook. **Honest bound:** the hook fires at the handoff/session boundary, not at a "grill-exit" event; a same-session global-codex grill → direct `/tdd` (no handoff) is a documented residual (Global-Follow-up).

**Markers used here** (HTML comments, grep-bar): `<!-- guard-ack: #<n> r<N> reason:<text> by-user -->` (deliberate handoff override), `<!-- final-cut-depends-on: #<n> -->`, `<!-- handoff-intent: build|grill -->`, `<!-- guard-legacy -->` (grandfathered Alt-Anker → warn not block). **Kanonische Tabelle aller Marker:** Modul-Docstring von `scripts/execute-ready-check.py`.
