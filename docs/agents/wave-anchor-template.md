# Wave-Anker-Template

Der Body eines Wellen-Anker-Issues. Modell: das war der Tracker, der funktioniert hat.
**Reife-Stufen** — Platzhalter `<…>` ersetzen, nicht-zutreffende Zeilen löschen:

- **Stufe 1 (Kandidaten-Stub, bottom-up)** — füllt `board-to-waves`: Kopf bis inkl. To-Do-Checklist. **cluster/Wave-los**, Slice-Tabelle bleibt leer (`⬜ via to-issues`).
- **Stufe 1p (Programm-Vorzustand, top-down)** — füllt `to-waves` aus einem Programm-PRD: benannter Stub `Welle <N> — <Thema>` **ab Anlage**, `wave-stub`-Label, **Wave + Phase sofort gestempelt**, nativer Parent = das Programm-PRD, vorerzeugte Slice-Leaves als native Kinder. Unterschied zu Stufe 1: benannt + gestempelt + PRD-Parent statt cluster/Wave-los. Details unten (§ Stufe 1p).
- **Stufe 2 (gereift + promotet)** — füllt `to-prd` (Entscheidungen/PRD-Body) + `to-issues` (Slice-Tabelle + Handoff-Blocks, verknüpft Sub-Issues, Promotion setzt `type:cluster` + Wave). Hakt die To-Dos ab. Ein Stufe-1p-Stub reift hier genauso (die erste Programm-Stub-Promotion flippt das PRD auf den In-Progress-Status, `roles.inProgress`).

Der **Kandidaten-Stub** (Stufe 1) ist cluster/Wave-los. Bei der **`to-issues`-Promotion** (Stufe 2) bekommt der Anker `type:cluster` + **Wave-Field = `<N>`** (monotone Nummer, kein `wave:*`-Label); `type:cluster` **ersetzt** das bisherige `type:*` des Stubs (z.B. `type:followup`) — genau ein `type:*` pro Issue, `board-sync.py promote` strippt das alte; der **Issue-Titel wird zu `Welle <N> — <Thema>`** (das ist das `board-sync.py promote`-Default-Verhalten — `wave_title()` ersetzt jeden alten `Welle X —`-Präfix idempotent und strippt einen führenden Conventional-Commit-Präfix; Opt-out `--no-rename` — **autoritativ ist der `promote`-Code**), und das `Welle <N> — <Thema>` steht **auch** in der **Body-Kopfzeile**. Body **immer** via `--body-file` (`gotchas_gh_body_file`). Nummerierung → [SKILL.md des `board-to-waves`](.claude/skills/board-to-waves/SKILL.md) „Wellen-Nummerierung".

---
--- TEMPLATE AB HIER (alles oben drüber ist Anleitung, nicht ins Issue kopieren) ---

<!-- wave-stub-source: <thema-slug> -->   <!-- Stufe 1: stabiler Idempotenz-Marker, board-to-waves search-before-create; kebab-case-Slug des Gate-Outcomes, nie geändert -->
<!-- prd-source-id: <#> -->
**plan_revision:** r<N>        <!-- Stufe 2: bei der Promotion gestempelt (vor dem ersten Heading — der execute-ready-Checker verlangt ihn dort, sonst denied der Post-Promote-Audit den Anker) -->

**Welle <N> — <Kurzbeschreibung>.** Roter Faden: <Gate — das gemeinsame Outcome, das diese Issues zur Welle macht>.

> 📍 **Execution-Tracker (Stand <Datum>).** Dieses Issue ist Single-Source-of-Truth für „wo stehen wir, was kommt als Nächstes". Jede Sub-Session ankert hier.

## Herkunft

- **Quelle:** <board-to-waves | externe-prd | rohes-issue | plan | grill> *(provenienz-neutral — die Form ist gleich, egal woher; die folgenden Zeilen soweit zutreffend füllen, nicht-zutreffende löschen)*
- **Mitglieds-Issues:** #<a> #<b> #<c> … *(gelistet; verknüpft via `to-issues`-Promotion, To-Do unten)*
- **Warum zusammen (feuernde Kriterien):** Gate=<Outcome> · <B1 Code-Nähe / B2 Typ-Homogenität / B3 Abhängigkeit / B4 Verify-Fläche, soweit zutreffend>
- **Größe + Risiko:** ~<N> Slices · Backend: <ja/nein> · Modell-Mix: <Modell [Effort], z.B. Sonnet [medium] / Opus [high] / gpt-5.5 [medium]> · Risiko: <niedrig/mittel/hoch — Grund, z.B. Race/Cache/Forecast/Migration>
- **`grill-needed`:** <nein> | <ja — diese Session> | <ja — eigene Session (zu groß/fuzzy)>

### To-Do (Reifung: grill → to-prd → to-issues)
- [ ] *(nur falls grill-needed=ja, eigene Session)* dedizierte `grill-with-docs`-Session — Domänen-Discovery
- [ ] **`to-prd`** → Entscheidungen/PRD-Body in diesen Stub schreiben (Mode B); `spec-self-critique` läuft automatisch
- [ ] **`to-issues`** → Slices schneiden, **pro Slice ein Sub-Issue** (Member-Issue wiederverwenden / neu anlegen), Slice-Tabelle **+ `## Handoff-Startbefehle`-Block je Slice** füllen; bei ≥2 Slices **promoten** (setzt `type:cluster` + Wave) + **alle** Slice-Sub-Issues nativ verknüpfen (vollständig — Slice-Set == Sub-Issue-Set)
- [ ] **Wellen-Gate** → vor dem Schließen: offene `annahme-drift`-Propagation Richtung Zukunfts-Wellen/-Stubs (und, bei Programm-Zugehörigkeit, dem Programm-PRD) reconciled — kein unbemerktes Drift über die Wellengrenze hinweg (Drift-Checkpoint, `wrapup` Step 5e.2)
- [ ] **Track** → Rollup ist der Status; Anker zu bei 100 %

## Entscheidungen — *(`to-prd` füllt; bei Quelle `grill`: „Grill <Datum>, gelockt")*

| Item | Entscheidung |
|---|---|
| <Issue/Thema> | <Was genau, in Outcome-Sprache> |

**Artefakte:** <CONTEXT.md-Terme / docs/adr/<nnnn>-…md, falls im Grill entstanden>

## Slices (vertikal, je 1 PR/Session) — *(`to-issues` füllt)*

Reihenfolge (WSJF-lite): sichtbar + low-risk zuerst → Logik/Backend → Cleanup. Abhängigkeiten erzwingen Reihenfolge.

<!-- slice-table:start -->
| # | Status | Slice | Sub-Issue | Branch | Modell | Gate | Backend? | schließt/refs |
|---|---|---|---|---|---|---|---|---|
| 1 | ⬜ | <Slice-Titel> | #<sub> | `feat/<#>-<slug>` | <Modell [Effort]> | <—/🧭/🔬/📐/📝> | <ja/nein> | <closes #x / refs #y> |
<!-- slice-table:end -->

Status-Legende: ⬜ offen · 🔄 in Arbeit · ✅ merged #<PR>. **Jeder Slice = ein Sub-Issue** (`#<sub>`). **Die volatilen Spalten Status + Branch generiert `board-sync.py anchor-sync <anker#>` aus dem Board** (zwischen den `<!-- slice-table:start/end -->`-Markern; `wrapup` Step 5e.1 ruft es beim Merge) — monoton (kippt nie ein `✅`/`🔄` zurück), driftfrei idempotent; **stabile Plan-Spalten (Slice/Modell/Gate/Backend?/refs) bleiben hand-gepflegt** und überleben verbatim. Fehlende Sub-Issue-Zeilen hängt es an (Gen-b-Split). **Marker nicht löschen** — ohne sie kann `anchor-sync` die Tabelle nicht finden (Erstlauf lokalisiert sie über die `Status`+`Sub-Issue`-Kopfzeile und setzt die Marker selbst). Der native „Sub-issues progress"-Rollup ist die %-Zweitsicht.

**Gate-Legende (Retro):** `—` AFK-Bau (`/tdd`) · 🧭 Design-Grill (`grill-with-docs-codex`, ADR) · 🔬 Verify-Spike (read-only Faktenfrage) · 📐 Abwägung/Research (Trade-off/Research, read-only, unter Grill-Schwelle) · 📝 Review-Notiz (kein Bau-Slice). Ein Gate-Slice (🧭/🔬/📐) steht **vor** seinem abhängigen Bau-Slice (gate-before-build) + blockt ihn.

**Schließbedingungen:** <Issue #x → nach welchen Slices> · <…> · Anker #<self> → alle Slices merged + native Sub-Issues 100 %.

**Mid-Wave entdeckte Follow-ups** → als **Slice-Zeile in diese Tabelle** einplanen (Zwischenslice an der richtigen Sequenz-Position, oder ans Ende) + eigenes Sub-Issue (nativ verknüpft, zählt im Rollup). **Keine** separate Follow-ups-Tabelle — die wäre in der Slice-Sicht unsichtbar.

**Parallel-Hinweis:** echtes Parallel nur mit Worktree pro Strang. Slices die Files teilen → seriell.

## Handoff-Startbefehle (pro Slice, paste-ready) — *(`to-issues` füllt)*

<details><summary>Slice 1 — <Titel> · empf. <Modell></summary>

```
Welle <N> · Slice 1 (<refs/closes>, Parent #<self>). Lies #<self> für Kontext/Entscheidung.
Worktree: ./scripts/setup-worktree.sh <#> <slug>
Scope (<N> Dateien) — PFLICHTFELD, Blast-Radius-Schätzung am Schnitt; Bau-Session prüft sie gegen ihren Recon-Befund, >2×-Abweichung → STOP:
- <konkrete Datei + Änderung>
Live-Verify: <User-Outcome, DB-/UI-Wert mit Vergleich —>
PR: <closes #x / refs #self>.
```
</details>

## Stufe 1p — Programm-Vorzustand (top-down, `to-waves`)

`to-waves` legt die Wellen-Stubs eines **Programm-PRD** in genau dieser Form an — der definierte Vorzustand oberhalb der Feature-Route (statt cluster/Wave-los wie Stufe 1):

- **Titel** `Welle <N> — <Thema>` **ab Anlage** (nicht erst bei der Promotion).
- **Label** `wave-stub`; **Wave + Phase** sofort gestempelt (gebatcht über `stamp-batch`).
- **Nativer Parent = das Programm-PRD** (3 Ebenen: PRD → Stub → Slice-Leaves). Die vorerzeugten Slice-Leaves hängen als native Kinder unter dem Stub — für `to-prd` Mode B **erwartetes Skelett**, kein Child-Drift.
- **Idempotenz-Marker im Body** (Kopfzeile, grep-bar, nie geändert):

```
<!-- program-stub-source: <prd-source-id>/w<N> -->   <!-- stabile Identität: to-waves search-before-create + Delta-Re-Run/Crash-Recovery -->
<!-- program-revision: rN -->                          <!-- gegen die PRD-plan_revision geprüft; stale Stub blockt laut; der Delta-Re-Run erneuert ihn -->
```

- **Handoff-Worktree-Zeile konsumenten-neutral** — der Programm-Vorzustand ist Teil der publizierten `to-waves`-Route, daher **kein** projekt-spezifischer Skript-Pfad, sondern:

```
Worktree: your project's worktree helper, or `git worktree add`
```

Reifung: der Stub reift bei der **Wellen-Promotion** wie Stufe 2 (`to-prd` Mode B in den Stub + `to-issues`); ungebaute Leaves/Stubs eines abgebrochenen Programms schließen in der Reihenfolge Leaves → Stubs → PRD (Abbruch-Konvention im PROGRAM-PRD-FORMAT).
