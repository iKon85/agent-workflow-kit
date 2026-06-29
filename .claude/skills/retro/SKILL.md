---
name: retro
disable-model-invocation: false
description: Use when the user explicitly asks for a retro after a session with PR-activity. Analyzes session friction and proposes concrete config mutations (Memory/Skill/CLAUDE.md/Hook) with per-patch approval. No file is written — findings live in the mutated config.
---

# Retro — In-Session Deep-Dive

Trigger: user types `/retro` (optionally with a PR/Issue number, e.g. `/retro 274`).

## What this skill does

A retro is a session-contained vehicle for surfacing friction and turning it into concrete config improvements. The retro itself is NOT a persistent artifact — the artifact is the **change** to Memory, Skill, CLAUDE.md, or a Hook. If nothing should change, nothing is persisted.

## Symmetrie-Prinzip (Pflicht)

**Retro-Input = User-Friction + Agent-Friction. Beide gleichberechtigt.**

Der User beschreibt seine Pains in Alltagssprache. Der ausführende Agent bringt parallel die eigenen Session-Pains aus dem Tool-Call-Trace ein. **Beides** geht durch die Analyse-Pipeline. Der Agent analysiert (Root-Cause + Konfig-Komponente) und schlägt Maßnahmen vor. User stimmt pro Patch ab.

Niemals ist die Retro nur "Agent fragt User nach Friction". Das wäre der falsche Eingangspunkt — der User sieht oft nur Symptome, der Agent sieht im Trace die echten Tool-Call-Failures, Memory-Stalls, Hook-Misses und Skill-Konflikte.

## Why this exists

Two purposes:

1. **Feature-level learning** — capture friction while it is fresh so the same trap is not stepped into next session.
2. **Konfig-Health surveillance** — accumulate evidence that a CLAUDE.md rule, Skill, Memory note, or Hook is outdated, missing, or actively in the way. Each retro is the trigger source for incremental config cleanup.

The previous file-based workflow (`pr-retro-stub.py` hook + filled retro files in `.claude/retros/` + batch-PR) was removed because filed retros are read by no one — only the config mutations matter.

## Process

### 1. Detect PR-Kontext

Two signals:

- **Branch-Pattern:** Run `git branch --show-current`. If it matches `feat/<N>-…` / `fix/<N>-…` / `chore/<N>-…` / `docs/<N>-…`, the issue number is `<N>`.
- **Skill-Argument:** if the user typed `/retro <num>`, that number wins over the branch.

If neither yields a number, ask the user:

> "Kein PR-Kontext detected — trotzdem Retro? Wenn ja, nenn mir Issue/PR-Nummer oder sag 'keine'."

User may skip (silent exit), give a number, or say "keine" (proceed without a PR/Issue anchor).

### 2a. User-Friction-Probe (eine Frage, Outcome-Sprache)

Ask exactly:

> "War Friction in der Session? Wenn ja, in 1-2 Sätzen: was war's?"

User-Beschreibung in **Alltagssprache** erwartbar ("Worktree-Setup ist ärgerlich", "LSP zickt rum"). Es ist **Aufgabe des Agents**, daraus die technische Root-Cause + Konfig-Komponente abzuleiten — NIEMALS soll der Agent den User danach fragen.

### 2b. Agent-Friction-Self-Probe (Pflicht, parallel zu 2a)

Der ausführende Agent scannt die Session selbst auf Friction. Pflicht-Check-Liste:

- Welche Tool-Calls schlugen fehl oder mussten retried werden? (Permission-Denials, Edit-vor-Read-Errors, Bash-Pipe-Aborts)
- Welche Memories haben sich beim Hinschauen als stale erwiesen? (Inhalt widerspricht heutigem Code)
- Welche Pre-Commit-/Hook-Checks brauchten Workarounds?
- Welche Skill-Schritte waren widersprüchlich zu CLAUDE.md? (z.B. plugin-skill sagt npm install, CLAUDE.md sagt pnpm)
- Welche Bash-Calls liefen mit CWD-Drift / sequentieller Permission-Approval / fehlendem absoluten Pfad?
- Welche `<system-reminder>`-Spam-Muster traten wiederholt auf?

Eigene Findings explizit als **"<Agent>-Finding: …"** im Output markieren, gleichberechtigt zu User-Findings. Beispiele: **"Codex-Finding: …"** auf Codex, **"Claude-Finding: …"** auf Claude.

### 2c. Memory-Sweep-Probe (Pflicht, falls Threshold gerissen)

Empirisch zählen — aktives Memory-Set + Index-Größe:

```bash
ls -1 "$HOME/.claude/projects/<project>/memory/"*.md \
  | grep -v '/MEMORY\.md$' | wc -l
wc -l "$HOME/.claude/projects/<project>/memory/MEMORY.md"
```

Threshold-Trigger (einer reicht):
- Aktives Memory-Set ≥ 65 Files (Sweep-Trigger über dem CLAUDE.md-Ziel „aktives Set <35" — feuert nur bei echtem Bloat, nicht auf einem gesund-aber-vollen Set; realer aktiver Stand ~50–61, content-checked alle aktiv---/Retro)
- MEMORY.md > 120 Zeilen

Wenn Trigger gerissen:
- Im Output ein Satz: "Memory-Sweep-Probe: N aktive Memory-Files, X Zeilen MEMORY.md — über Token-Hygiene-Ziel (<35 Files)."
- Konfig-Patch-Vorschlag in Step 3 mitgeben:
  "Patch X — Memory-Set über <35. Veraltete/erledigte Memories identifizieren + löschen (prune-on-touch). Vor jedem Löschen Inhalt prüfen; gelöschte Memory-Files nach `archive/` verschieben (statt hart löschen), damit Recovery möglich bleibt. **Wirkt auf:** Memory · **Gewicht:** niedrig (Hygiene, punktuell)."
  Wie jeder Step-4-Patch trägt auch dieser die `Wirkt auf / Gewicht`-Zeile (3b/Step 4).

Wenn 0 Trigger:
- Ein-Zeiler im Output: "Memory-Sweep ok (N Files / X Zeilen)."
- Kein Patch-Vorschlag.

**Skip-Erlaubnis:** keine — Sweep-Probe läuft auf jedem Retro.

**Warum hier (Pflicht-Step, nicht nur Memory):** Memory ist passiv (nur wenn der Agent dran denkt); `/retro` läuft routinemäßig nach PR-Activity und ist das natürliche Enforcement-Vehikel. Der Eintrag muss VOR der symmetrischen Analyse passieren, damit er ggf. als Patch-Vorschlag in den Flow einfließt.

**Threshold-Tuning:** Sweep-Trigger = ≥65 Files / >120 Zeilen MEMORY.md; das CLAUDE.md-Ziel bleibt „aktives Set <35" (Aspiration) — Trigger über Ziel mit Headroom, damit der Sweep nicht auf jedem Retro feuert (Retro: realer Stand ~39 → ~46 bei, content-checked alle aktiv → 0 sicher löschbar; der Legacy-DAL-Memory-Cluster retired bei Delete). Schwelle 45→50 → 50→60 (Retro 2026-06-18) → 60→65 angehoben (Retro 2026-06-27: 61 feuerte erneut auf einem legitim-voll-aktiven Set, alle content-checked aktiv, 0 sicher löschbar — dasselbe Leerlauf-Sweep-Muster wie bei 50). Nach weiteren Retros nachjustieren. (Die frühere `project_*_done`-Done-File-Klasse + `## Project (Active)`-Section existieren nicht mehr — das aktuelle Memory-Modell ist prune-on-touch ohne Done-File-Lifecycle; `consolidate-memories.sh` war der einmalige W2-Massen-Archive-Lauf, kein laufender Sweep.)

### 3. Symmetrische Analyse (Agent eigenständig)

Für **jeden** Friction-Punkt (User-gemeldet UND selbst-gefunden) analysiert der Agent:

- **Root-Cause:** Welcher Tool-Call / Memory / Hook / Skill war konkret involviert?
- **Konfig-Komponente:** Welche Mutation würde das nächste Mal verhindern? (Memory / Skill / CLAUDE.md / Hook / Helper-Script / Issue / nichts)
- **Wiederholbar oder einmalig?** Einmalige Vorfälle → kein Patch nötig.

Wenn die User-Beschreibung in Step 2a mehrdeutig ist, darf der Agent **EINE** klärende Outcome-Frage stellen — z.B. "an welcher Stelle war's am ärgerlichsten — beim Setup, mitten in der Arbeit, oder beim Cleanup?". Niemals Multiple-Choice mit Memory-Namen, Hook-Paths, oder Konfig-Klassen.

### 3b. Ziel + Gewicht bestimmen (Schwellen-Leiter)

Bevor du in Step 4 einen Patch formulierst, ordne **jede** Friktion auf der Schwellen-Leiter ein. **Gewicht** = wie durabel/weitreichend die Regel ist (steuert die sichtbare Patch-Zeile in Step 4 + die Approval-Tiefe des Users). **Ziel** = wohin der Patch physisch geht.

| Gewicht | Ziel (Tier) | Wann |
|---|---|---|
| **hoch** | CLAUDE.md / Hard Rule (oder durabler Hook) | durabel + querschnittig + **incident-backed**; gilt **über alle Phasen** (auch ohne Spec — im Bau, bei Git, beim Deploy) |
| **mittel** | `spec-self-critique` (Projekt-Check) | wiederkehrender **spec-struktureller** Defekt, **vor dem Bau aus der Spec fangbar** |
| **niedrig** | Memory | punktueller Infra-/Domänen-Gotcha (Fakt zum Recall, kein Muster) |
| **minimal** | Inline-Notiz / „nichts" | One-off, kein Muster, kein durables Konfig-Artefakt |

**Domänen-/Glossar-Lücke** (der Defekt läge im **Grill-Input**, nicht in der Spec-Struktur — ein Begriff war unscharf/fehlte, bevor überhaupt eine Spec entstand) → Ziel `CONTEXT.md` / `docs/adr/`, **Gewicht mittel**. So erreichen Learn-Findings erstmals den **Plan-START** (das, was `grill-with-docs` liest), nicht nur das Spec-Gate. Abgrenzung zu `spec-self-critique` (auch mittel): dort sitzt ein **struktureller** Spec-Defekt; hier eine **inhaltliche** Domänen-/Begriffs-Lücke.

**Grenzfall hoch vs mittel — Zwei-Stufen-Test (CLAUDE.md vs `spec-self-critique`):**
1. **Phasen-Reichweite zuerst:** „Hätte ein Blick auf die SPEC *vor* dem Bauen die Friktion verhindert?" → **Ja** = Spec-Qualitäts-Loch → `spec-self-critique` (mittel). → **Nein, gilt immer/phasenübergreifend** → CLAUDE.md-Kandidat.
2. **Incident-Gate für die hoch-Stufe:** CLAUDE.md / Hard-Rule **nur** wenn durabel + querschnittig + **mind. einmal real schiefgegangen** (incident-backed). Reine Einmal-Beobachtung ohne Recurrence → runter auf Memory/inline, **nicht** Hard-Rule.

**Grenzfall mittel vs niedrig:** Im Zweifel gewinnt **mittel** (aktives Spec-Gate schlägt passiven Memory-Recall) — ein nach `niedrig`/Memory fehlgeroutetes Spec-struktur-Finding sitzt in passivem Recall und feuert beim nächsten Spec **nie wieder**, ein mittel-Finding im `spec-self-critique`-Layer feuert garantiert.

**Tier sagt wohin grob, Klasse sagt welche Datei.** Bei einem **Skill**-Ziel entscheidet das Klassen-Routing in Step 4 („Klasse zuerst") **welche** Datei — z.B. ein „mittel → `spec-self-critique`"-Patch landet (publizierte Klasse) im **Projekt-Layer** `docs/agents/skills/spec-self-critique.md`, nicht im Gerüst.

**GitHub-Issue ist KEIN Gewicht-Tier.** Ein echter Follow-up = Arbeit zum Tracken → `gh issue create` + Board-Sync (Step-4-Tabelle), **orthogonal** zur Leiter; sein „Gewicht" richtet sich nach dem Follow-up-Scope. Die Leiter klassifiziert **Konfig-Patches**, nicht „mach ein Ticket draus".

**Ziel fehlt im Projekt — zwei Fälle scharf trennen:**
- **(a) Tier-Skill ganz fehlt** (z.B. Fremd-Projekt ohne `spec-self-critique`): kein durables Spec-Time-Gate da. **Memory ist KEIN Ersatz** — passiver Recall fängt keinen wiederkehrenden Spec-Defekt vor dem Bau. Ehrlich melden: *„für dieses Tier gibt es in diesem Projekt kein durables Ziel"* + `/setup-workflow`-Follow-up vorschlagen. **Kein Fake-Guard via Memory.**
- **(b) Skill da, Projekt-Layer-Datei fehlt** (`docs/agents/skills/<skill>.md`): **anlegen / anhängen** — das ist das normale retro-Sink-Verhalten, das `spec-self-critique` Step 0 ohnehin erwartet. **Kein** Downgrade.

### 4. Patch-Vorschläge (konkrete Empfehlung, keine Multiple-Choice mit Tech-Refs)

**Generalisierungs-Check ZUERST (Pflicht, vor dem Formulieren) — Klasse statt Symptom.** Bevor du einen Patch schneidest, abstrahiere eine Ebene hoch: *„Wovon ist dieser Vorfall ein BEISPIEL?"* Der Patch deckt die **Klasse / das Prinzip** (alle Szenarien, in denen derselbe Mechanismus beißt) — der konkrete Vorfall ist nur das **Beispiel**, nicht der Scope. Symptom-enge Patches (genau-dieser-eine-Trigger) verfehlen die nächste Variante derselben Klasse, und der User muss nachsteuern. **ABER Klasse ≠ Spekulation:** nimm nur **verifizierte** Mitglieder der Klasse auf (Verify-First), strukturiere **erweiterbar** statt mit ungeprüften Mustern vollzupacken — zu breit (ungeprüft) ist derselbe Fehler wie zu eng, nur andersrum. (Retro: „blocke `(`" = Symptom → „Shim verarbeitet Regex anders als echtes ripgrep" = Klasse; aber `\d` bewusst NICHT aufgenommen, weil es auf ripgrep funktioniert = unverifizierter Breaker.)

Für jeden Friction-Punkt: Der Agent formuliert **eine konkrete Empfehlung** mit kurzer Begründung in Alltagssprache. Format:

> **Patch X — [eine Zeile Was].**
> **Warum:** [eine Zeile, warum es die Friction beseitigt].
> **Was sich ändert:** [eine Zeile sichtbarer Effekt].
> **Wirkt auf:** [Ziel in Alltagssprache] · **Gewicht:** [hoch / mittel / niedrig / minimal] — [kurze Begründung aus der Leiter (3b)].

**Jeder Patch trägt die `Wirkt auf / Gewicht`-Zeile** (aus 3b) — auch der Memory-Sweep-Patch aus Step 2c (Wirkt auf: Memory · Gewicht: niedrig). Das Gewicht steuert die Approval-Tiefe: „hoch / CLAUDE.md" = durable Always-on-Regel, mehr Prüfung wert; „minimal / inline" = Wegwerf. Wording in Alltagssprache (kein Tech-Jargon im User-Blick).

Optional dazu der präsentierte Diff/Script/Edit als Code-Block (für die Sichtprüfung), aber NICHT als Multiple-Choice-Option mit tech-Vokabular.

Mögliche Mutation-Targets (intern für Claude, NICHT im User-Output auflisten):

| Mutation type | Where |
|---|---|
| Neue/geänderte Memory-Note | `~/.claude/projects/<project>/memory/<slug>.md` (plus `MEMORY.md`-Index updaten) |
| CLAUDE.md-Rule-Anpassung | `CLAUDE.md` (Hard Rules section) |
| Skill-Verbesserung (generisch-portabel) | `.claude/skills/<skill>/SKILL.md` |
| Projektspezifische Skill-Lore (`generic`/`vendored`-Skill) | `docs/agents/skills/<skill>.md` (Projekt-Layer) |
| Neuer/geänderter Hook | `.claude/hooks/<name>.py` + Test |
| Neues Helper-Script | `scripts/<name>.sh` (+ tracked `.claude/settings.json` Whitelist —: `.local.json` propagiert nicht in Worktrees) |
| Neues GitHub-Issue | `gh issue create` + Board-Sync |
| "Nichts machen" | einmaliger Vorfall, kein Recurrence-Risiko |

**Skill-Patch-Routing (Klasse zuerst).** Zielt ein Patch auf ein Skill, ZUERST `.claude/skills/skill-manifest.json` **best-effort** lesen. Publizierte Klassen (`generic`/`vendored`): **projektspezifische** Lore → `docs/agents/skills/<skill>.md` (Projekt-Layer), **generisch-portable** Verbesserung → `.claude/skills/<skill>/SKILL.md`. `project-private`: Skill-Dir ist ok. **Manifest fehlt** (Fremd-Install) → safe-default: Lore nach `docs/agents/skills/<skill>.md`, NIE in ein publiziertes Skill-Dir. (Hält publizierte Skills self-contained; z.B. `spec-self-critique` ist `generic` → seine projektspezifischen Checks gehören in den Projekt-Layer, nicht ins Gerüst.)

### 5. Per-Patch-Approval (Ja / Nein / Modifizieren)

Pro Patch:

> "Patch X — [Was-Zeile]. Übernehmen? (Ja / Nein / Modifizieren)"

<!-- mirror-xform:start codex-user-input-mechanism -->
Benutze `AskUserQuestion` mit ≤3 Optionen. Optionen-Labels in Alltagssprache, **niemals Memory-Slugs oder Hook-Paths in den Labels**. Bei "Modifizieren" frag in Alltagssprache nach, was anders sein soll.
<!-- mirror-xform:end -->

### 6. Umsetzung

For each approved patch, execute the mutation immediately (Edit / Write / Bash). Do NOT batch — apply one at a time so the user can interrupt.

### 7. Exit

Die Retro ist **opt-in** (User triggert `/retro`); ich **biete sie vor der PR-Erstellung an**, erzwinge sie nie. Wird sie gemacht, dann vor PR (nicht erst nach Merge). Nach allen Patches:

1. In 2-3 Sätzen zusammenfassen, was geändert + was deferiert wurde.
2. Eine **`## Retro / Meta-Findings`-Sektion in den PR-Body** falten — in den noch zu erstellenden PR, oder via `gh pr edit` wenn schon offen: die ehrliche Friction-Analyse (User- **und** Agent-Findings) + die angewandten Patches.
3. Repo-Datei-Patches (CLAUDE.md/Hook/Skill/Script) werden **als Teil des Slice-PR committet**; Memory-Patches sind Filesystem-only (nicht im PR).

Niemals eine Datei in `.claude/retros/` anlegen.

## What NOT to do

- **Do NOT create files in `.claude/retros/`.** The directory is historical archive only.
- **Repo-Datei-Patches gehören in den Slice-PR** (Retro läuft VOR PR-Erstellung) — committen + Findings als Meta-Sektion in den PR-Body. Nur Memory/Filesystem-Patches bleiben uncommitted.
- **Do NOT skip the friction probe.** If you don't ask explicitly, you may silently invent friction that wasn't there.
- **Do NOT propose patches without user approval.** Every config mutation gets explicit ja/nein.

## Format conventions

- German prose for user-facing questions and summaries (project convention).
- Umlaute korrekt (ä, ö, ü, ß — nie ae/oe/ue/ss in Prosa).
- File-Links als `[name](pfad)`, klickbar in <maintainer>'s VSCode.
