---
name: wrapup
disable-model-invocation: true
description: >-
  Use ONLY when the user types /wrapup. Session-end "land & clean" for a
  finished feature/fix worktree — merges the open PR (= triggers prod deploy),
  kills the worktree dev server, removes the worktree + local branch, and
  fast-forwards the main checkout so main is current again, then sweeps
  merged-branch leftovers (local + stale remote whose PR is merged). If the
  slice isn't landed yet, it first makes it landable (Step 0): commits a dirty
  tree (after an .env/secret check), pushes, and opens the PR — reusing one if
  it already exists. User-triggered only (never auto-invoke, never hook). Aborts
  hard only on: not in a feature worktree, a detected .env/secret, a rejected
  push, a conflicting PR, or red (FAILURE) checks.
---

# wrapup — PR landen & Worktree auflösen

Trigger: User tippt `/wrapup` (optional mit PR-Nummer, z. B. `/wrapup 697`). **Nur manuell** — `disable-model-invocation: true`, kein Hook, kein Auto-Invoke.

## Was dieser Skill macht

Schließt eine fertige Slice-Session ab: **Stand landbar machen (Step 0: commit → push → PR anlegen/wiederverwenden)** → offenen PR mergen → Worktree-Dev-Server beenden → Worktree + lokalen Branch auflösen → Main-Checkout per Fast-Forward aktualisieren. Spart das wiederholte Eintippen der Abschluss-Sequenz. Ist die Slice schon committed/gepusht/mit PR, ist Step 0 ein No-op (kein Abbruch deswegen).

## ⚠ Spec-Kontext (lesen, nicht überspringen)

**Merge auf `main` = Prod-Deploy** (your deploy platform-Webhook, ~7 min live). CLAUDE.md: *„Claude deployt NIE eigenmächtig — Merge+Deploy bei <maintainer>."* Dieser Skill **verletzt das nicht**, weil **<maintainer> ihn selbst triggert** — der `/wrapup`-Aufruf IST die explizite Merge+Deploy-Freigabe pro Lauf. Deshalb: **niemals** diesen Skill aus einem Hook, einem anderen Skill oder autonom aufrufen. Nur auf direkte `/wrapup`-Eingabe.

Vor dem Merge **immer** das Deploy-Banner zeigen (Step 3). Keine y/n-Rückfrage (so gewählt) — aber die Pre-flight-Hard-Stops sind nicht verhandelbar.

## Execution model — 3 phases (mechanical bulk on Sonnet)

**Why separate:** `model:` frontmatter only overrides the session model **"for the rest of the current turn; the session model resumes on your next prompt"** ([Claude Code skills docs](https://code.claude.com/docs/en/skills.md)). `wrapup` is **multi-turn interactive** (Retro-Gate, Annahme-Drift confirmation): each user gate answer starts a new turn → the frontmatter override reverts, and the **mechanical bulk runs after the gates** — back on the session model (empirically all-Opus in sessions that ran at Opus). Therefore the skill carries **no** `model:` frontmatter; instead, the mechanical git/gh plumbing is dispatched to a **Sonnet subagent** (runs fully on its own model, turn-independent). All user gates **and** security judgment stay in the **main thread** (= session model, the user's choice — Sonnet *or* Opus; the subagent enforces Sonnet for the bulk regardless).

| Phase | Who | Content |
|---|---|---|
| **1 — Preparation + gates** | **Main thread** (session model) | Pre-flight · Retro-Exit-Gate · **Step 0a Commit incl. Secret-Review** (security judgment stays here) · **Step 0c.2 Annahme-Drift propose+confirm**. Collects: `**Retro:**` line, confirmed `annahme-drift` marker blocks, conventional title/commit context. |
| **2 — Mechanics** | **Sonnet subagent** (dispatch) | Step 0b Push · Step 0c PR create/reuse (body with Retro line + markers + `closes`/`Part of`) → body-check → merge-gate · **Step 1 Merge (= deploy)** · Step 2 dev-server kill · Step 4 worktree remove · Step 5 main FF + `branch -d` · Step 5b issue-close · Step 5c/5d branch sweep · Step 5e.1 anchor-tick. Pure git/gh mechanics, mechanically verifiable. |
| **3 — Post-merge gates + report** | **Main thread** (session model) | Step 3 deploy-banner · **Step 5e.2 sibling-propagation propose+confirm+write** · Step 6 report. |

**Dispatch contract (Phase 1 → Phase 2):** When Phase 1 is green (all gates answered, commit is local), dispatch **one** subagent — `Agent` tool, **`model: sonnet`** explicit. Pass all Phase-1-collected values: `WT`, `MAIN_TREE`, `BRANCH`, `ISSUE`, anchor number (if `Part of #<anchor>`) or leaf-flag, the **complete PR body text** (Retro line + confirmed markers + `closes`/`Part of`), and the conventional title.

**Subagent return (concise, structured):** PR-# · `state==MERGED`? · body-check exit · sweep counts (5c local / 5d remote) · anchor-tick result · parsed `annahme-drift` markers (for Phase-3 Step-5e.2) · main SHA · **any STOP** with reason.

**STOP-return rule (non-negotiable):** On any hard stop (push rejected · body-check Exit 1 · merge-gate `CONFLICTING`/red check · merge not `MERGED` · `worktree remove`/`branch -d` refused · **any secret-grep hit**) → **abort, force nothing, report back to main thread**. The subagent does not self-fix security judgment calls and cannot call `AskUserQuestion`.

**Merge = deploy stays `/wrapup`-triggered:** the `/wrapup` input is the authorization per run; the main thread dispatching = carrying the authorization forward. No auto/hook trigger.

> The steps below are tagged `[Phase N]`. Phases 1 + 3 run in the main thread; **everything tagged `[Phase 2]` runs in the Sonnet subagent** — the main thread does NOT execute these steps itself, it dispatches them as one block.

## Pre-flight — Hard-Stops (bei JEDEM Fail: abbrechen, melden, NICHTS mergen/löschen) `[Phase 1 · main thread]`

Kontext ermitteln:
```bash
WT=$(git rev-parse --show-toplevel)
BRANCH=$(git branch --show-current)
MAIN_TREE=$(git worktree list --porcelain | awk '/^worktree / {print $2; exit}')
```

1. **Im Feature-Worktree?** `WT` ≠ `MAIN_TREE` **und** `BRANCH` ≠ `main`. Sonst Stop (`/wrapup` läuft im Worktree der fertigen Slice, nicht im Haupt-Checkout / nicht auf main).
Das ist die **einzige** reine Vorbedingung. Früher waren *dirty Tree*, *ungepushte Commits* und *kein offener PR* ebenfalls harte Stops — **nicht mehr**: **Step 0** stellt sie her (commit → push → PR anlegen/wiederverwenden, idempotent), die Mergebarkeit prüft **Step 0c** danach.

Verbleibende Hard-Stops (bei jedem: abbrechen, melden, NICHTS mergen/löschen):
- nicht im Feature-Worktree (#1)
- Secret bzw. `.env` im Commit-Diff (Step 0a)
- abgelehnter Push (Step 0b)
- PR `CONFLICTING` oder Check-`conclusion` in `FAILURE`/`CANCELLED`/`TIMED_OUT` (Step 0c)

Bei Stop: präzise sagen *was* blockt und *was* der User tun muss. Nicht „weitermachen versuchen".

## Ablauf (nach grünem Pre-flight)

### Retro-Erinnerung (nach Pre-flight #1, VOR Step 0 — portabler Backstop, kein Auto-Run) `[Phase 1 · main thread]`
Direkt nach grünem Pre-flight, **bevor** Step 0a irgendwas committet: **eine** Erinnerung als **blockierendes, optionales Retro-Exit-Gate** — keine Merge-Bestätigung.

> „Retro schon gefahren? **(a)** ja / weiter → ich lande jetzt. **(b)** du willst noch eine → ich brich hier **sauber** ab, du fährst `/retro`, dann `/wrapup` erneut — die **Repo-Datei**-Patches reisen dann in diesem PR mit (Memory-Patches bleiben lokal)."

- Wählt der User **(b)** → `wrapup` **beendet sich sofort sauber** (kein Commit, kein Merge, kein Worktree-Touch). `wrapup` kann **keinen** anderen Skill mitten im Lauf pausieren/resumen → sauberer Exit + Re-Run statt Schein-Pause.
- Wählt der User **(a)** → weiter mit Step 0a.
- **NIE** `/retro` selbst aufrufen (kein Auto-Run / kein Auto-Capture) — nur die Erinnerung zeigen.
- **≠ Merge-y/n:** Die „Keine y/n-Rückfrage"-Regel (Spec-Kontext oben, Z19) betrifft die **Merge**-Bestätigung — die bleibt (Deploy-Banner ohne y/n). Dieses Gate ist ein **pre-Step-0 Retro-Exit**, **keine** Merge-Freigabe. Nicht verwechseln.
- **Warum im generischen `wrapup`:** im Fremd-Projekt fehlt eine projekt-lokale „vor PR `/retro` anbieten"-Konvention → `wrapup` ist dort der **einzige portable** Retro-Touchpoint. In <project> quittiert man meist „schon erledigt" (primärer Nudge kommt aus der CLAUDE.md-Konvention nach `/tdd`) → kein Doppel-Prompt.
- **Antwort → Spur (Materialisierung):** Die Gate-Antwort verschwindet nicht — sie wird in **Step 0c** als `**Retro:**`-Pflichtzeile in den PR-Body geschrieben. Retro gelaufen (in dieser oder einer früheren Session des Slice) → `**Retro:** gefahren — Findings unter ## Retro / Meta-Findings`; bewusst keins → `**Retro:** übersprungen — <Grund in <maintainer>s Worten>`. So sieht man jedem gemergten PR an, ob Lernen stattfand. Das ist **keine** neue Frage und kein Auto-Run — nur das Festhalten der ohnehin gegebenen Antwort.

### Step 0 — Stand landbar machen (commit → push → PR; idempotent, IM Worktree)
Macht die Slice landefähig, **ohne abzubrechen, wenn schon alles erledigt ist** (jeder Sub-Step ist No-op, wenn nichts zu tun). Läuft noch **im Worktree** (cwd = `$WT`, Branch = `$BRANCH` aus dem Pre-flight) — erst Step 1 wechselt in den Main-Tree.

**Step 0a — Dirty Tree → committen.** `[Phase 1 · main thread]` Nur wenn `git status --porcelain` nicht leer.
- **`.env`-Hard-Block (mechanisch):** liegt `.env`/`.env.*` im Tree → **STOP**, nie committen (globale Regel, nicht verhandelbar). Manuell klären.
- **Secret-Review (Judgment):** vor dem Commit `git diff --cached` durchsehen — keine Keys/Tokens/Passwörter/Private-Keys mitcommiten. `grep` ist Aid, entscheiden tut der Verstand (Variablenname `token` ≠ Secret; echter Key → `git reset` + Stop).
- **Commit-Message Conventional** (`<type>(<scope>): <kurze Zusammenfassung> (#<issue>)`): Typ aus Branch-Prefix, Zusammenfassung aus dem **tatsächlichen Diff** (nicht stumpf der Branch-Slug), Issue-Nr. aus dem Branch (`feat/<N>-…`).
```bash
if [ -n "$(git status --porcelain)" ]; then
  git status --porcelain | grep -qE '(^|[ /])\.env(\.[^/ ]*)?$' \
    && { echo "STOP: .env im Arbeitsbaum — nicht committen, manuell klären."; exit 1; }
  git add -A
  git diff --cached | grep -niE 'BEGIN [A-Z ]*PRIVATE KEY|(api[_-]?key|secret|password|access[_-]?token|bearer)[[:space:]]*[:=]' \
    && echo "⚠ mögliche Secrets im Diff (oben) — VOR dem Commit prüfen; Fehlalarm (z. B. Variablenname) → weiter, echtes Secret → git reset + STOP."
  git commit -m "<conventional message aus dem Diff>"
fi
```
**Pre-commit-Hook (husky `tsc`+ESLint) feuert beim Commit** — neu in diesem Pfad (früher committete der User vor `/wrapup`, der Hook lief außerhalb). Schlägt er mit *vielen* `Cannot find module`/TS2307 quer über **fremde** Files fehl (nicht deine Slice-Files) → Worktree-`node_modules` fehlt/stale, **kein** echter Fehler: `pnpm install --frozen-lockfile` (warmer Store, ~Sek.), dann erneut committen. **Nie `--no-verify`.** Echte TS-/Lint-Fehler in *deinen* Slice-Files = berechtigter Stop → beheben, nicht bypassen.

**Step 0b — Ungepusht → pushen.** `[Phase 2 · Sonnet subagent]` Feature-Branch → `pre-push` erlaubt (nur `main` ist geblockt). Setzt Upstream idempotent:
```bash
git push -u origin "$BRANCH"     # schon gepusht & aktuell → No-op; abgelehnt (z. B. divergiert) → STOP + Grund melden
```

**Step 0c — PR sicherstellen + Merge-Gate.** `[Phase 2 · Sonnet subagent — except 0c.2 Drift-confirmation = Phase 1]` Bestehenden PR **wiederverwenden** (kein Abbruch!), sonst anlegen; dann Mergebarkeit prüfen.
```bash
PR=$(gh pr view "$BRANCH" --json number -q .number 2>/dev/null || true)
if [ -z "$PR" ]; then
  # Body nach /tmp schreiben (gh --body-file Pflicht: inline Backticks/Klammern crashen bash)
  #   Leaf-Issue:            "closes #<n>"        (NIE in Backticks → sonst greift Auto-Close nicht, vgl. Step 5b)
  #   Wellen-/Cluster-Slice: "Part of #<anker>"   (NIE "closes" → schlösse den Anker verfrüht,)
  gh pr create --base main --head "$BRANCH" --title "<conventional title>" --body-file /tmp/wrapup-pr-body.md
  PR=$(gh pr view "$BRANCH" --json number -q .number)
  echo "Step 0c: PR #$PR neu angelegt"
else
  echo "Step 0c: PR #$PR bereits vorhanden — wiederverwendet"
fi
gh pr view "$PR" --json state,mergeable,mergeStateStatus,statusCheckRollup
```
- Title = Conventional (wie der Commit). Issue-Nr. aus dem Branch. Body-Konvention strikt wie im Kommentar (Leaf → `closes`, Anker-Slice → `Part of`).
- **`**Retro:**`-Pflichtzeile in den Body (Materialisierung der Retro-Erinnerung):** Beim Body-Schreiben **genau eine** dieser Zeilen aufnehmen, je nach Gate-Antwort:
  - Retro lief (diese oder frühere Session des Slice) → `**Retro:** gefahren — Findings unter ## Retro / Meta-Findings`
  - bewusst keins → `**Retro:** übersprungen — <Grund in <maintainer>s Worten>`

  Format exakt: `**Retro:**`-Prefix, dann `gefahren`/`übersprungen`, dann ` — ` + Begründung (mit Space nach dem Marker — `**Retro:**gefahren` ohne Space wird vom Check abgelehnt). **Geschlossenes Set: NUR diese zwei Wörter, wörtlich kopieren — nie freihändig formulieren.** Jede andere Variante (z. B. „Nicht angeboten", „entfällt") lehnt `pr-body-check.py` ab → unnötige Nacharbeit. „Nichts zu retro'n" (Meta-/Config-Session ohne Feature-Slice) ist **kein** dritter Zustand, sondern `übersprungen — <Grund>` (z. B. „Meta-/Config-Session, kein Slice-Retro"). **Gilt für JEDE PR-Body-Erstellung — auch ad-hoc mitten in der Session** (`gh pr create` außerhalb dieses Step 0c): dieselben zwei Formen wörtlich, sonst fängt der Check sie und du arbeitest nach. Kein Auto-Run von `/retro` — nur die Antwort festhalten.
  - **Reuse-Pfad (PR existierte schon):** der bestehende Body hat die Zeile evtl. nicht. **Proaktiv nachtragen** — fehlt die `**Retro:**`-Zeile im wiederverwendeten Body, sie per `gh pr edit "$PR" --body-file <ergänzter Body>` einfügen, **bevor** der Body-Konventions-Check läuft (nicht auf dessen Exit 1 + Hand-Fix verlassen — Slice-7/8-Lücke).
- **Annahme-Drift-Selbst-Check `[0c.2 · Phase 1 · main thread]` — VOR dem Body-Check:** Erst die Marker in den Body schreiben (s. u.), DANN den Body-Konventions-Check laufen lassen, damit dieser den **finalen** Body sieht (R2-F4). Quelle = das **Build-Zeit-Log** `ANNAHMEN.md` (Worktree-Root, gitignored), das Wellen-Slice-Sessions live führen (Erfassung bei Kontext-Frische statt Gedächtnis am Session-Ende; Konvention: CLAUDE.md Cross-Slice-Writeback + `tdd`-Checklist). **Q3-konform: kein Code-/Diff-Scan, keine Heuristik — das Log IST explizit Genanntes, nur früher erfasst.** Das Log ist die **Untergrenze, nicht die Obergrenze**: fällt mir beim Landen eine Drift auf, die **nicht** im Log steht, bringe ich sie genauso retro-style ein (s. Fallback), statt sie zu übergehen.
  - **Log vorhanden + nicht-leer** → pro Zeile einen `annahme-drift`-Marker-Vorschlag bauen und dem User zur **Bestätigung** zeigen (Schreiben in den PR-Body erst nach OK — Session-Notizen verschwinden nach Merge+Worktree-Removal, nur der PR-Body überlebt für Step 5e). Zeilen-Format `- #<n>: <text>` (optional `- #<n> §<Section>: <text>`); daraus Marker mit Defaults `section="Vor Bau zu klären"`, `op="append"` — JSON-Payload im HTML-Kommentar (überlebt Quotes/Newlines/`-->`):
    ```
    <!-- annahme-drift: {"target":"","section":"Vor Bau zu klären","op":"append","text":"retro-Seam in 1g vereinheitlicht — vor Schnitt prüfen"} -->
    ```
  - **Zeile ohne `#<n>`-Ziel (malformed)** → **warnen + im Walkthrough klären** (Ziel nachtragen oder Eintrag bewusst verwerfen), **nie still droppen** (Spiegel zu „stilles Schreiben verboten", Step 5e).
  - **Log fehlt/leer** (oder Nicht-Wellen-Slice ohne Log) → **Fallback retro-style: ICH bringe zuerst eigene Kandidaten ein, frage NICHT blank.** Wie bei `/retro` (User liefert Richtung + Freigabe, nicht das Impl-Detail — er kennt es meist nicht, ich habe gebaut; CLAUDE.local.md „Liegt X so vor? frage ich nicht <maintainer>"): die im Slice **bewusst getroffenen oder gekippten** Annahmen durchgehen, die ein **ungebautes** Geschwister-Issue tragen könnten, und sie als **benannte Kandidaten** vorlegen — je `- #<n>?: <Annahme> → trägt evtl. <Issue/Contract>`. Der User bestätigt / verwirft / priorisiert; bestätigte → Marker wie oben von Hand. **Null** Kandidaten → das **ausdrücklich sagen** („keine Drift gefunden — geprüft: <kurz, was berührt wurde>"), erst danach optional die Eine-Zeile-Absicherung *„etwas übersehen, das ein ungebautes Issue trägt?"*. Die blanke Frage ist **nie** Ersatz fürs eigene Durchgehen.
  - Kein Marker → nichts propagiert (eine vergessene Drift fängt der Drift-Guard am nächsten Handoff).
- **Body-Konventions-Check (mechanisch,) — nach Retro-Zeile + Annahme-Drift-Markern, gegen den finalen Body:** Das Script prüft die `closes`-vs-`Part of`-Regel (Anker-Schutz) + die `**Retro:**`-Pflichtzeile gegen den **realen PR-Body**. Es **parst KEINE `annahme-drift`-Marker** (deren Validierung ist bewusst nicht mechanisiert,/R2-F6) — darum laufen die Marker-Writes davor. Issue-Nr. aus dem Branch, Parent via `board-sync.py parent-of`.
  ```bash
  python3 scripts/pr-body-check.py --branch "$BRANCH"
  ```
  - **Exit 0** → grün, weiter zum Merge-Gate.
  - **Exit 1** → **STOP**: die gemeldeten Verstöße im Body beheben (`gh pr edit "$PR" --body-file <korrigierter Body>`), dann das Script **erneut** laufen lassen, bis Exit 0. **Nicht** mit rotem Check mergen.
  - **Exit 2** → nur Warnung (kein Issue aus dem Branch / kein PR-Body abrufbar), **kein Block** (fail-open).
- **Merge-Gate** (der frühere Pre-flight-#4-Check, jetzt **nach** dem PR-Anlegen):
  - `state == OPEN` und **kein** Check mit `conclusion` in `FAILURE`/`CANCELLED`/`TIMED_OUT` → sonst **STOP** (rote Checks nennen).
  - `mergeable == CONFLICTING` → **STOP** (Merge-Konflikt; Branch rebasen/auflösen).
  - `mergeable == UNKNOWN` (frisch erstellter PR — GitHub rechnet die Mergebarkeit async) → **kein Stop**: der Merge-Versuch in Step 1 ist das echte Gate (Step 1 verifiziert `state == MERGED` und stoppt sonst).

### Step 1 — PR mergen (= Prod-Deploy) `[Phase 2 · Sonnet subagent]`
**Body-Konventions-Gate (vor dem Merge):** Erst mergen, wenn `pr-body-check.py` (Step 0c) **Exit 0** lieferte — er deckt die `**Retro:**`-Pflichtzeile (`gefahren`/`übersprungen` + Grund) **und** die `closes`-vs-`Part of`-Anker-Regel mechanisch ab. Bei Exit 1 zuerst den Body fixen (`gh pr edit "$PR" --body-file <korrigierter Body>`) und neu prüfen, **nicht** blind mergen. (Bestehender PR ohne `**Retro:**`-Zeile fällt damit ebenfalls in den STOP.)

**Wichtig:** `gh pr merge` macht intern `git checkout main` — das schlägt fehl wenn `main` im Feature-Worktree belegt ist. Deshalb **immer zuerst in den Main-Tree wechseln**:
```bash
cd "$MAIN_TREE"
gh pr merge "$PR" --merge --delete-branch
```
- `--merge` = Merge-Commit (Repo-Konvention, vgl. `git log` auf main).
- `--delete-branch` entfernt den **Remote**-Branch. Den lokalen Branch löscht gh nicht, solange er im Worktree ausgecheckt ist — das macht Step 4.
- Danach verifizieren: `gh pr view "$PR" --json state -q .state` == `MERGED`. Nicht MERGED → Stop, Rest NICHT ausführen.
- „already merged"-Meldung + `state == MERGED` → OK (Remote-Merge lief durch, nur lokale Folgeschritte fehlten) → weitermachen.

### Step 2 — Worktree-Dev-Server beenden (VOR der Worktree-Auflösung!) `[Phase 2 · Sonnet subagent]`
Reihenfolge-Falle: ein laufender Prozess hält Dir + Ports → `git worktree remove` schlägt sonst fehl.
**cwd-Falle:** der Kill-Loop unten matcht Prozesse per cwd-unter-WT — läuft die Shell selbst im WT
(z.B. „pr merged"-Pfad, wo Step-1's `cd "$MAIN_TREE"` übersprungen wird), killt er den eigenen
Shell-Ancestor → Exit 144, Loop bricht ab, Stray-Proc bleibt. Darum ZUERST in den Main-Tree wechseln.
```bash
cd "$MAIN_TREE"   # raus aus dem Worktree — sonst trifft der cwd-Filter unten die eigene Shell
# Ports aus .dev-ports lesen (separate source-Zeile, nicht im &&-Chain)
VITE_DEV_PORT="" BACKEND_PORT=""
[ -f "$WT/.dev-ports" ] && source "$WT/.dev-ports" 2>/dev/null || true

# a) Listener auf den Offset-Ports killen (Front + Back)
for p in "${VITE_DEV_PORT:-}" "${BACKEND_PORT:-}"; do
  [ -n "$p" ] && lsof -ti:"$p" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
done
# b) Alle node/tsx/vite/tsc/pnpm-Prozesse killen, deren cwd UNTER dem Worktree liegt
#    (fängt den pnpm-dev-Parent + tsc-watch, die keinen Port halten, aber den Dir)
while IFS= read -r pid; do
  cwd=$(readlink -f /proc/"$pid"/cwd 2>/dev/null) || continue
  case "$cwd" in "$WT"*) kill "$pid" 2>/dev/null || true;; esac
done < <(pgrep -f 'tsx|vite|tsc|pnpm|node' 2>/dev/null)
```
Wurde der Server in DIESER Session als Background-Task gestartet, zusätzlich per `TaskStop` beenden (Task-ID aus dem Session-Verlauf).

### Step 3 — Deploy-Banner `[Phase 3 · main thread]`
Eine Zeile ausgeben, z. B.:
> ⚠ PR #`$PR` gemerged → your deploy platform deployt `main` (~7 min live: <your-app-domain>).

### Step 4 — Worktree auflösen (AUS dem Main-Tree) `[Phase 2 · Sonnet subagent]`
`git worktree remove` darf nicht aus dem zu entfernenden Worktree laufen → vorher in den Main-Tree wechseln. Den lokalen Branch löscht **Step 5** (nach dem Main-Update — vorher refuse't `-d`, s. dort).
```bash
cd "$MAIN_TREE"
git worktree remove "$WT"          # Tree ist sauber (Step 0a hat committed) → kein --force nötig
git worktree prune
git fetch origin --prune
```
- Schlägt `git worktree remove` fehl („contains modified or untracked files" / „is locked") → **nicht** blind `--force`: erst prüfen, ob Step 2 wirklich alle Prozesse beendet hat (`lsof`, `pgrep`), sonst gingen evtl. echte Dateien verloren. Ursache melden statt forcen.

### Step 5 — Main aktualisieren + lokalen Branch löschen `[Phase 2 · Sonnet subagent]`
```bash
cd "$MAIN_TREE"
git checkout main 2>/dev/null || true   # i. d. R. schon auf main
git pull --ff-only
git branch -d "$BRANCH"                  # NACH dem ff-Pull — erst jetzt ist der Merge-Commit von main reachable
```
`--ff-only`: kein Push, keine Branch-Protection (pre-push) berührt. Kein Fast-Forward möglich → melden (divergierter Main = Anomalie, untersuchen).
- **`git branch -d "$BRANCH"` gehört NACH den Pull** (nicht in Step 4): davor ist der Merge-Commit noch nicht von `main` reachable + der Remote-Upstream schon gepruned → `-d` refuse't „not fully merged" und schlägt das Hook-geblockte, verbotene `-D` vor. `-d` reicht nach dem Pull immer; schlägt es trotzdem fehl → melden, **nie** `-D`.

### Step 5b — Issue-Close verifizieren (Auto-Close-Miss abfangen) `[Phase 2 · Sonnet subagent]`
GitHub schließt das `closes #<n>`-Issue beim Merge **nur**, wenn das Keyword im PR-Body nicht in Backticks/Code-Span steht — sonst bleibt das Issue still offen. Deshalb hart prüfen, nicht vertrauen. Issue-Nummer kommt aus dem Branch (`feat/<N>-…`).
```bash
ISSUE=$(echo "$BRANCH" | sed -E 's#^(feat|fix|chore|docs)/([0-9]+)-.*#\2#')
if [[ "$ISSUE" =~ ^[0-9]+$ ]]; then              # bash-Regex, kein grep (rtk-Alias-Falle)
  state=$(gh issue view "$ISSUE" --json state -q .state 2>/dev/null)
  if [ "$state" = "OPEN" ]; then
    gh issue close "$ISSUE" -c "Gemerged via PR #$PR — Auto-Close griff nicht (Keyword evtl. in Backticks); manuell geschlossen."
    echo "Step 5b: #$ISSUE war trotz Merge OPEN → manuell geschlossen"
  else
    echo "Step 5b: #$ISSUE bereits $state ✓"
  fi
else
  echo "Step 5b: keine Issue-Nummer im Branch — übersprungen"
fi
```
**Vorbeugend** außerdem: `closes #<#>` im PR-Body **nie** in Backticks/Code-Span schreiben (sonst ignoriert GitHub das Keyword — genau der Miss, den dieser Step abfängt). (Retro 2026-05-31.)

### Step 5c — Verwaiste merged-Branches kehren (lokale Karteileichen) `[Phase 2 · Sonnet subagent]`
Step 4 löscht **nur** den Branch dieser Slice. Über die Zeit sammeln sich aber lokale Branches an, deren PR längst gemergt ist (manuelle Merges, Alt-Stände vor diesem Skill, andere Sessions). Nach dem Main-Update einmal sicher durchkehren — **ausschließlich `-d`** (löscht nur, was aus `main` reachable ist; refuse't alles andere, inkl. in anderen Worktrees ausgecheckter Branches):
```bash
cd "$MAIN_TREE"
for b in $(git branch --merged main --format='%(refname:short)'); do   # grep-frei (rtk-Alias-Falle, vgl. 5b)
  [ "$b" = "main" ] && continue
  git branch -d "$b" 2>/dev/null && echo "  gekehrt: $b"
done
```
- **Niemals `-D`** (Hook-geblockt, Hard-Rule). Der Sweep ist durch `--merged main` **und** `-d` doppelt abgesichert — er kann per Definition nichts Ungemergtes treffen.
- **Squash-/rebase-gemergte** Branches sind nicht aus `main` reachable → der Sweep lässt sie **bewusst** stehen (kein `-D`-Bypass). Die bleiben manuelle Einzelfall-Entscheidung: `gh pr list --head <b> --state merged` verifizieren, dann force't der User selbst.
- Fängt die Merge-Commit-Klasse (Repo-Default `--merge`) und verhindert das Branch-Müll-Wachstum, das diesen Step motiviert hat (2026-06-02, 28 Karteileichen).

### Step 5d — Verwaiste merged-Branches kehren (REMOTE Karteileichen) `[Phase 2 · Sonnet subagent]`
`--delete-branch` (Step 1) löscht nur den Remote-Branch *dieser* Slice. Über die Zeit stauen sich auf `origin` aber Hunderte Remote-Branches, deren PR längst gemergt ist (GitHub „auto-delete head branches" aus, manuelle Merges, Alt-Stände). 5c sieht die **nicht** — es kehrt nur lokal. Darum hier einmal die Remote-Karteileichen kehren, **autoritativ über den PR-Status** (nicht über `--merged`-Reachability — das übersähe squash/rebase-gemergte, vgl. 5c). Sichere Menge = *Remote-Branch existiert* **und** *hat einen MERGED-PR* **und** *hat KEINEN offenen PR* (Reuse-Schutz):
```bash
cd "$MAIN_TREE"
git fetch origin --prune
gh pr list --state merged --limit 1000 --json headRefName -q '.[].headRefName' | sort -u > /tmp/wrapup-merged.txt
gh pr list --state open   --limit 1000 --json headRefName -q '.[].headRefName' | sort -u > /tmp/wrapup-open.txt
git branch -r --format='%(refname:short)' | sed -n 's#^origin/##p' | sort -u > /tmp/wrapup-remotes.txt
# merged-PR-Heads ∩ existierende Remotes − offene-PR-Heads (comm = grep-frei, rtk-Alias-Falle, vgl. 5b/5c)
comm -23 <(comm -12 /tmp/wrapup-merged.txt /tmp/wrapup-remotes.txt) /tmp/wrapup-open.txt > /tmp/wrapup-stale.txt
STALE=()
while IFS= read -r b; do
  [ -z "$b" ] && continue
  [ "$b" = "main" ] && continue          # main nie löschen (Sicherheitsnetz)
  STALE+=("$b")
done < /tmp/wrapup-stale.txt
if [ "${#STALE[@]}" -gt 0 ]; then
  git push origin --delete "${STALE[@]}" && echo "Step 5d: ${#STALE[@]} remote merged-PR-Branch(es) gelöscht"
  git fetch origin --prune               # lokale remote-tracking refs nachziehen
else
  echo "Step 5d: keine stale remote merged-Branches"
fi
```
- **Reversibel:** ein versehentlich gelöschter Remote-Branch ist über die GitHub-PR-Seite („Restore branch") wiederherstellbar — der Merge-Commit hält die Commits ohnehin. Trotzdem ist die Menge dreifach gefiltert (MERGED-PR + existiert + kein offener PR + nie `main`).
- **`--delete-branch` in Step 1 bleibt** — 5d ist die kumulative Nachkehr, nicht sein Ersatz; bei sauberer Hygiene ist 5d meist ein No-op.
- Erstlauf nach Einführung kehrt den Altbestand in **einem** Multi-Ref-Push (2026-06-08: 142 stale Remotes von 145).

### Step 5e — Land-Reconcile (Anker + Geschwister kohärent halten) `[5e.1 = Phase 2 · 5e.2/5e.3 = Phase 3]`
Greift nur, wenn das gemergte Issue ein **Slice eines Wellen-Ankers** ist (`Part of #<anker>`). Hält den Rest-Graph land-seitig execute-ready. **Phase split:** Anchor-tick (5e.1) = unambiguous one-line flip → **subagent** (Phase 2); sibling-edits (5e.2) = user-gate (propose+confirm) → **main thread** (Phase 3).

1. **Anker-Tracker-Tick — prose-geführt** `[Phase 2 · Sonnet subagent]` (kein Script wie 5b–5d; ein Edit nach Augenmaß). Anker-Body **unmittelbar vor dem Write neu fetchen**. In der **Slices-Tabelle** die **genau eine** Zeile finden, deren **Sub-Issue-Spalte `#<n>`** trägt (= der gemergte Slice) → ihre **Status-Zelle** flippen: `⬜`/`🔄` → `✅ #<PR>` (Emoji-Tabelle — **keine** `- [ ]`-Checkbox; das war der Mismatch). Match über `#<n>` (robuster als der Titel). Mehrdeutig / 0 Treffer / Race → **stop + vorschlagen** (kein Blind-Regex, der die falsche Zeile/`#n` trifft). Die Status-Spalte ist **`wrapup`-gepflegt**; der native „Sub-issues progress"-Rollup ist die %-Zweitsicht. Ersetzt den alten reinen Step-6-Reminder.
2. **Annahmen-Propagation — VORSCHLAGEN + BESTÄTIGEN** `[Phase 3 · main thread]`. `annahme-drift`-Marker from the **subagent report** (or PR body) parsen (JSON). Pro Marker: Sibling-Edit entwerfen (z. B. `## Vor Bau zu klären` des Ziel-Issues ergänzen) **+ `plan_revision` des Siblings re-stempeln**; dem User **anzeigen, bestätigen lassen, dann erst schreiben**. Stilles Schreiben verboten (Codex #15). Beides prose-geführt: der Tick (1.) ist ein eindeutiger Ein-Zeilen-Flip ohne User-Gate, die inhaltlichen Sibling-Edits sind judgment → propose + bestätigen.
3. **Land-Sanity (non-blocking):** `python3 scripts/execute-ready-check.py --issue <anker#> --mode audit` → Zweiler; Drift im Report nennen.

### Step 6 — Report `[Phase 3 · main thread]`
Knapp: gemergter PR (#), Issue-Close-Status (auto vs. manuell via Step 5b), Worktree entfernt (Pfad), lokaler Branch gelöscht, **gekehrte merged-Branches lokal (Step 5c) + remote (Step 5d), je Anzahl**, `main` jetzt auf `<SHA>` (`git log --oneline -1`), Deploy läuft. **Anker-Tracker** (bei `Part of #<anker>`): in Step 5e getickt — Ergebnis (getickt / propose-pending) nennen, **kein** manueller Reminder mehr.

## Nicht im Scope
- Live-Verify / DoD: muss VOR `/wrapup` passiert sein — der Skill landet (Step 0 macht landbar, dann Merge), er **verifiziert nicht**. Step 0's Auto-Commit ersetzt kein Live-Verify.
- `/retro`: **vor** dem Landen anbieten (s. Retro-Erinnerung vor Step 0) — Repo-Datei-Patches reisen im PR mit, Memory-Patches bleiben lokal. `wrapup` **ruft `/retro` nie selbst auf** (kein Auto-Run); `wrapup` selbst landet/verifiziert nur, es führt keine Retro durch.
- Andere laufende Worktrees / deren Server bleiben unangetastet.
