# Verification fixtures — spec-self-critique (generic)

**Fixtures only — no new rules here.** Each fragment is a synthetic, project-neutral spec snippet that violates **exactly one** check. When the skill works, it should trigger the named point and name it in the summary. Walk these when refactoring the checklist. New *project-specific* checks/scenarios go in the project layer (`docs/agents/skills/spec-self-critique.md`), never here.

## Point 1 — placeholder / unverified count
> "Rename `oldUtil` → `newUtil` across the 9 call-sites and update imports."

Violates 1 (cited count not re-verified; rename = caller-audit + typecheck-backstop). Expected: *"Punkt 1: '9 call-sites' nicht empirisch belegt — grep + breiter Caller-Audit + Typecheck-Backstop nach dem Move ergänzt."*

## Point 2 — internal consistency
> "Section A: the cache TTL is 60s. Section B's diagram labels the same cache 600s."

Violates 2. Expected: *"Punkt 2: widersprüchliche TTL (60s vs 600s) — vereinheitlicht."*

## Point 3 — scope
> "This spec covers: new auth provider, a billing rewrite, a dashboard redesign, and a data migration."

Violates 3. Expected: *"Punkt 3: zu groß für einen Plan — in Sub-Specs zerlegen."*

## Point 4 — ambiguity
> "When the request fails, retry it a few times before giving up."

Violates 4. Expected: *"Punkt 4: 'a few times' mehrdeutig — auf konkrete Zahl + Backoff festgelegt."*

## Point 5 — state transitions
> "New live progress indicator: on start a spinner appears, on finish a green check."

Violates 5 (only `running → succeeded`). Expected: *"Punkt 5: Live-Feature, nur Erfolgs-Pfad — failed / reload / multi-tab / connection-loss / aborted ergänzt."*

## Point 6 — convention scope
> "Introduce a `withRetry()` wrapper. Apply it in `serviceA.fetch()` and `serviceB.fetch()`."

Violates 6 (no app-wide-vs-touched scope, no follow-up). Expected: *"Punkt 6: Pattern-Scope nicht erklärt — explizit nur diese 2 + Followup für den Rest."*

## Point 7 — user walk-through
> "New multi-step onboarding wizard at `/onboarding`. Data model: a 3-field form posted to `/api/onboard`."

Violates 7 (only data model). Expected: *"Punkt 7: kein User-Walk-Through der Wizard-Stufen — pro Stufe ergänzt, was der User sieht."*

## Point 8 — project convention (+ 8b marker, 8c trivial post)
> "Refactor an aggregation module. Pre-invariant: `typeof rows[0]?.id === 'string'` (already guaranteed by the typed signature). Post-invariant: `out.length === rows.length` where the body is `for (const r of rows) out.push(...)`."

Violates 8c (post structurally guaranteed by the loop) + 8b-style trivial pre. Expected: *"Punkt 8c: Post strukturell durch den Loop garantiert — gestrichen / Property-Test; triviale Pre entfernt."* (With a project layer present, point 8 also iterates that project's `## Self-Critique-Check` convention blocks.)

## Point 9 — primitive recon (DRY)
> "Build a new `FilterableList` component with sort + filter."

Violates 9 (no recon for an existing list/table primitive). Expected: *"Punkt 9: neues Primitiv ohne DRY-Recon — auf Wiederverwendung des Bestehenden geprüft/umgestellt."*

## Point 10 — user-action feedback
> "A 'Rebuild caches' button kicks off a 4-stage backend job (~2 min). On error: a toast."

Violates 10 (no per-step feedback). Expected: *"Punkt 10: ≥2-Schritt-Prozess ohne Sub-Step-Feedback — Schritt-Labels / Progress / Retry- bzw. Modus-Sichtbarkeit ergänzt."*

## Point 11 — live-verify bug-plausibility
> "Live-verify for percentile indices. Bug-variant: change `p80 = 0.8*n` to `0.6*n`. Expect the ordering check `p10 < p50 < p80 < p90` to fire."

Violates 11 (`0.5 < 0.6 < 0.9` stays monotone → property does NOT fire). Expected: *"Punkt 11: Variante erhält die Monotonie — Property feuert nicht; korrekte Variante (z.B. 0.8→0.95, bricht p80>p90) gewählt."*

## Point 12 — vertical-slice completeness
> "Slices: 1) Config UI · 2) Backend resolver · 3) Wire-up."

Violates 12 (layer names, no tracer-bullet, no traced outcome slice). Expected: *"Punkt 12: Layer-Namen statt Tracer-Bullets — als '<Aktion> → <sichtbares Ergebnis>' umformuliert; erste Outcome-Slice gegen Code getrace't."*
