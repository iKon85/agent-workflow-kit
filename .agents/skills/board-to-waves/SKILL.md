---
name: board-to-waves
disable-model-invocation: false
description: "Use for sweeping the GitHub backlog board and clustering open issues into thematic Wellen. Reads many open issues, groups candidates, estimates size and risk, and creates cluster/Wave-less candidate stub issues after confirmation. Stops at stubs; use to-prd then to-issues to mature and slice one chosen candidate."
---

# board-to-waves

**Board sichten → offene Issues nach Thema clustern → Anker-Stub-Issues.** Systematisiert, wie Welle F entstand: erst geschaut was offen ist und zusammenpasst, dann Themen-Wellen gebildet. Ergebnis landet durable als Anker-Issue auf dem Board (GitHub = SSOT), nicht als Chat-Liste.

## Pipeline-Position

```
board-to-waves   Board → Kandidaten-STUB-Issues (cluster/Wave-los, Größe + grill-needed-Flag)   ← HIER
                         ↓ (<maintainer> wählt Wellen)
[optional]       dedizierte grill-with-docs Session — nur wenn Flag feuert
                         ↓
to-prd           reift den Stub zur Draft-PRD (Mode B)
                         ↓
to-issues        schneidet Slices + promotet (setzt type:cluster + Wave bei ≥2 Slices)
```

**Stoppt bei Stubs.** Kein Slice-Plan, keine PRD, kein Sub-Issue-Link, keine Promotion. Ob/wann ein Stub echte Welle wird = separater Schritt (`to-prd → to-issues`), <maintainer>s Call.

Modell: **Opus** (Sichten/Plan/Brainstorm — Cross-Board-Urteil, <maintainer>s Tabelle).

## Wellen-Nummerierung & Registry

**Format:** `Welle <N> — <Thema>` (Hybrid: Nummer ordnet, Thema gibt Kontext). **Die Wave-Nummer wird erst bei der `to-issues`-Promotion vergeben** — der board-to-waves-Kandidaten-Stub ist cluster/Wave-los und trägt im Titel noch **kein** `Welle <N> —`-Präfix (`to-issues` setzt es beim Promote).
**Carrier = Wave-Field (number)** auf dem **Anker** (Pflicht — Source-of-Truth + Board-Sortier-Key, gesetzt bei der Promotion). NICHT Titel-String, NICHT `wave:*`-Label (beide für Wellen deprecated). Member/Sub-Issues bekommen Wave-Field + nativen Parent-Link bei der `to-issues`-Promotion (nicht schon beim Clustern): der Parent-Link trägt die Zuordnung fachlich, das Wave-Field macht sie board-filterbar — ohne Wave-Field taucht ein zugeordnetes Issue fälschlich in der „wave-los"-View (`is:open no:wave -label:"type:cluster"`) auf.
**N = monotone Auto-Increment-ID:** `max(je vergebene Wave-Nummer) + 1`. Aufsteigend, nie wiederverwendet, nie Buchstaben, nicht retroaktiv umsortiert (wie Issue-Nummern). Lücken sind ok. Die nächste freie Nummer zieht `to-issues` bei der Promotion über den geteilten Board-Sync-Helper (`scripts/board-sync.py` `next-wave`) — board-to-waves vergibt selbst **keine** Wave.

**Registry = board-nativ, kein Doku-File:** View Filter `type:cluster`, Sort `Wave` aufsteigend, Spalten Status + Sub-issues-progress. Die Anker-Issues + Wave-Field **sind** die Registry. Aktive Welle = `type:cluster` + Status `In Arbeit`. Wave-Field ≠ `Cluster (G-Nummer)`-Field (Roadmap-G-Cluster, orthogonal). Keine Milestones (Progress macht der Sub-Issue-Rollup).

## Clustering-Heuristik — Gate + Booster + Splitter

**🚦 Gate (Pflicht — ohne das keine Welle, nur Stapel):** gemeinsamer **roter Faden / Outcome**. Die Issues müssen *ein* Produkt-Ergebnis bedienen (z.B. „Markt-/Partner-Reife" = Welle F).

**➕ Booster (je mehr feuern, desto klarer eine Welle):**
| # | Kriterium | Board-Signal |
|---|---|---|
| B1 | Code-Nähe / Change-Coupling | gleiche Files/Pfade in Issue-Bodies; historisch co-changed (`git log`) |
| B2 | Typ-Homogenität | gleiche `type:*` / `dimension:*`-Labels |
| B3 | Abhängigkeitskette | `blocked`-Label, „blocked by"/gegenseitige Refs |
| B4 | Gemeinsame Verify-Fläche | gleiche Seite/Surface live testbar |

**✂️ Splitter (trennen TROTZ Affinität):**
- **S1 Zu groß** — > ~7 Slices / nicht in überschaubarer Folge shippbar → in zwei Wellen.
- **S2 Fremder Parent** — Issue hängt schon unter anderer Welle (GitHub 1-Parent; `to-issues` Link prüft das endgültig).
- **S3 „Gleicher Typ allein" ≠ Welle** — Typ ist Booster, nie Gate. Sonst wird „alle Refactors" zur Müllhalde.

**Regel:** Issue → Kandidat X, wenn **Gate(X) erfüllt UND ≥1 Booster feuert** und kein Splitter greift. Sonst: eigener Kandidat oder Rest-Topf „ungeclustert / Einzel-Issue".

**Sequenz INNERHALB einer Welle** (gehört zu `to-issues`, hier nur notieren): WSJF-lite — sichtbar+low-risk → Logik/Backend → Cleanup; Abhängigkeiten erzwingen Reihenfolge.

> Belege: Atlassian/Mountain Goat (Epics/Themes), CodeScene/Tornhill (Change-Coupling), SAFe (WSJF), ProductPlan/Asana (Affinity/Batching).

## Größe + `grill-needed` (je Kandidat)

- **Größe + Risiko** in KI-Schritten, **nie Manntage** (sted-local): grobe Slice-Zahl, Backend-ja/nein, Modell-Mix, Risiko-Level (Race/Cache/Forecast/Migration → hoch).
- **`grill-needed`-Flag** — feuert bei: viele Slices ODER fuzzy (Mitglieder sind `type:idea`/`type:research`, nicht entschieden) ODER subsystem-übergreifend ODER offene Produkt-Entscheidungen. = niedrige Entscheidungs-Reife.
  - **„diese Session"** wenn überschaubar, **„eigene Session"** wenn zu groß/fuzzy für nebenher. Empfehlung in den Stub, **<maintainer>s Call**.

## Procedure

### 1. Board lesen
```bash
gh issue list --repo <owner>/<repo> --state open --limit 500 \
  --json number,title,labels,body
```
`--limit 500` (item/issue-list cappt **silent**, `docs/agents/board-sync.md`). Schon-Parent-Issues erkennt man später beim Link — hier reicht Titel/Labels/Body.

### 2. Clustern
Heuristik anwenden. Pro Kandidat festhalten: Thema (Gate-Outcome), Mitglieder (#…), feuernde Booster, Splitter-Checks, Größe+Risiko, `grill-needed`+Wann. Issues die kein Gate+Booster erreichen → Rest-Topf, **nicht** zwangs-clustern.

### 3. Kandidaten vorschlagen (<maintainer> wählt)
Knappe Liste, je Kandidat **welche Kriterien feuerten** sichtbar (Rationale):
```
Kandidat A „<Outcome>": #a #b #c
  Gate=<Outcome> · B1 alle Frontend · B2 alle type:refactor
  Größe ~4 Slices, Risiko niedrig · grill-needed: nein
Kandidat B „<Outcome>": #x #y …
  … · grill-needed: ja (eigene Session — subsystem-übergreifend)
Rest (ungeclustert): #m #n …
```
**<maintainer> bestätigt**, welche echte Wellen werden. Nur bestätigte → Schritt 4.

### 4. Kandidaten-Stubs anlegen (je bestätigtem Kandidat)
Body aus `docs/agents/wave-anchor-template.md` **Stufe 1** (Kopf + Cluster-Herkunft + To-Do-Checklist; Slice-Tabelle leer). Body **immer** `--body-file` (`gotchas_gh_body_file`).

**Alle Board-Schreib-Mechaniken (Stub anlegen, ins Board hängen, Status stempeln) laufen über den geteilten Board-Sync-Helper** `scripts/board-sync.py` — keine bare `gh issue create`/`gh project item-*` mehr in dieser Prosa (per Lint erzwungen, `scripts/test_skill_gh_lint.py`; Board-Konstanten leben in `docs/agents/board-sync.md`).

**Idempotenz — Stub-Marker + search-before-create (Pflicht, VOR dem `create`).** Re-Runs von board-to-waves dürfen **keine** Duplikat-Stubs erzeugen (sonst verwirrt der Duplikat-Stub die Modus-B-Identität in `to-prd`). Spiegelt das `to-prd`-Muster:
- **Stabiler Stub-Marker** `<!-- wave-stub-source: <thema-slug> -->` als **erste Body-Zeile** jedes Stubs. `<thema-slug>` = kebab-case-Slug des Gate-Outcomes; beim **ersten** Lauf gesetzt, danach **nie** geändert (Identität ≠ Inhalt — der Slug bleibt auffindbar, auch wenn sich Mitglieder/Größe später ändern).
- **search-before-create** je Kandidat **vor** dem `create`. **Kein** Verlass auf GitHub-Search (indexiert HTML-Kommentare nicht) — bounded lokal:
  ```bash
  gh issue list --repo <owner>/<repo> --state open --limit 500 --json number,body,labels
  # lokal auf `wave-stub-source: <thema-slug>` filtern → 1 Treffer ⇒ skip + melden (Stub existiert); >1 ⇒ STOP + melden; 0 ⇒ create
  ```

**Kandidaten-Stub anlegen (cluster/Wave-los)** — Issue **ohne** `type:cluster` und **ohne** `--wave` (genau ein `type:*` + ein `priority:*`; Titel **ohne** `Welle <N>`-Präfix, da die Wave-Nummer erst bei der Promotion vergeben wird), **mit `--wave-stub`** (durchsuchbarer „wartet auf Planung"-Filter — der HTML-Marker oben ist nur lokal greppbar, GitHub indexiert ihn nicht), ins Board hängen, Status `Triaged` (geclustert, noch nicht geplant). Danach reift `to-prd` den Stub (Mode B) zur Draft-PRD, `to-issues` promotet ihn zum Anker (setzt dann `type:cluster` + Wave, **strippt `wave-stub`** — der Stub verlässt die Planungs-Liste):
```bash
python3 scripts/board-sync.py create \
  --title "<Outcome/Thema>" \
  --body-file <stub.md> \
  --label "type:feature" --label "priority:medium" \
  --wave-stub \
  --status Triaged
```
Gibt `#<STUB_NUM> <URL>` aus. `--dry-run` zeigt die `gh`-Aufrufe ohne Schreiben. (Fuzzy/unentschiedener Kandidat → `type:research` statt `type:feature`.)

**Offene Stubs durchsuchen** (= „was muss ich noch planen"): `gh issue list --label wave-stub --state open` bzw. Board-Filter `is:open label:wave-stub`. Bei `to-issues`-Promotion (Welle) **oder** atomar-Publish (`add --bucket`) wird `wave-stub` automatisch gestrippt — kein manueller Edit.

**Mitglieds-Issues:** im Stub-Body listen (#…). **Noch kein** Wave-Stempel und **kein** nativer Parent-Link beim Clustern — beides setzt `to-issues` bei der Promotion. Dass die Member bis dahin in der „wave-los"-View (`is:open no:wave`) auftauchen, ist **korrekt**: ein Kandidat ist noch keine committete Welle.

### 5. Output
```
Geclustert: <N> Wellen-Kandidaten, <M> bestätigt → cluster/Wave-lose Stubs angelegt.
  Kandidat <X> #<STUB_NUM> — #a #b #c · ~4 Slices · grill: nein
  Kandidat <Y> #<…>       — #x #y   · ~8 Slices · grill: eigene Session
Rest (ungeclustert): #m #n …
Nächster Schritt (<maintainer>s Call, getrennt): grill → to-prd (reift den Stub) → to-issues (schneidet + promotet) je gewähltem Kandidaten.
```

## Notes
- **Stoppt bei Stubs.** Niemals selbst PRD schreiben, slicen, linken, promoten oder `to-prd`/`to-issues` aufrufen.
- Abgrenzung: `triage` = pro-Issue-State-Machine; `zoom-out` = Code-Comprehension; `board-to-waves` = board-weite Themen-Affinität. Verschiedene Flughöhen.
- Rest-Topf ist OK und gewollt — nicht jedes Issue gehört in eine Welle. Zwangs-Clustern verwässert das Gate.
- Größe/Risiko sind Schätzung (KI-Schritte), kein Commitment. Stub-Empfehlung „Wann grillen" überschreibt <maintainer> jederzeit.
