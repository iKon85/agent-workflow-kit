<!-- language-census: ok -->
# Merged evaluation — truth × cost × outcome (Welle 31 / Slice 3, #405)

HITL grill session 2026-07-29, Niko × Claude (Fable), per the slice mandate in
#405 and the wave decisions in #403. Inputs: the truth census (#380,
`../truth-census/`), the cost walk (#343, `../cost-walk/`, both passes plus
`two-model-merge.md`), and the frozen substrate (#404, commit
`16325e59f9c1815231f8e37c431881219fac9762`). Cross-model plan-review
transcript: [`plan-review-log.md`](./plan-review-log.md) (3 rounds,
`gpt-5.6-sol`/high). Every candidate below carries its
truth verdict, its cost row, and exactly one of the four outcomes —
**cut / relocate / rebind / keep** — with reasoning. Disagreements between the
passes are listed as findings, never resolved silently. Cutting authority is
this document plus Niko's sign-off; nothing in the input passes promoted
anything.

**Framing set by Niko at the start of the session and binding for every
verdict:** simplicity is the bar; rebuilding beats endless fixing; the kit
today sits at ~95 on a 0–100 over-specification scale and the target is ~20–30
(gut figure, deliberately not operationalized). Safety concentrates where no
floor exists beneath (consumer files, irreversible publication, loss of
tracked work); everywhere else the skeleton stays and the armour goes.

## Outcome summary

| # | Candidate | Truth (#380) | Cost (#343) | Outcome |
|---|---|---|---|---|
| A1 | Worktree-lifecycle guards (`.env` byte-compare #410 · substring auth #411 · `git -C` risky-gate #412) | 3 × `keep` promoted by reproduction — mechanisms are fiction at the predicate level | teardown priced proportionate; guards produce 100 % false positives on correctly configured worktrees (#374) | **rebind by rebuild** — v2 under #401 **extending ADR-0009's stateless model** (no lifecycle records — that approach already failed 15×): a seed-profile declaration grants deletion authority for the declared `.env*` files (consent-based, same logic as `.gitignore`), undeclared `.env*` keeps the conservative byte-compare block; write-target authorization only where a target is observable, Bash command authorization deleted outright; ADR-0009 + CONTEXT.md *Scratch* amended in the same slice; the three reproductions become acceptance fixtures; external worktrees stay first-class |
| A2.1 | `readiness.mjs` `## Prod` exact-string match (#413) | `keep` promoted, reproduction + testreporter#2283 | small station, keep | **rebind** — tolerant matching, two distinguishable error codes, readiness report added to `init`/`update` output (report, never gate) |
| A2.2 | orchestrate-wave release-lockstep sentence (#416) | shipped fiction — `docs/adr` 0 of 356 manifest entries, never was in | F6/D1: misprices a journey in the expensive direction | **rebind** — correct the sentence (warning stays, enumeration inverted); the fiction dies, the purpose survives |
| A2.3 | `codex-exec.sh` exact version pin (#415) | event verified | blocked the cost walk itself (F1), stale again after 1 day | **already executed** — 0.46.2 replaced identity pin with capability probe; recorded, outside this evaluation's authority |
| A2.4 | Census rule-extractor blind spot (#409) | meta-finding | — | **cut** — blind spot accepted explicitly; the analysis census was a one-shot instrument, not a standing tool (the impact census is separate and unaffected) |
| A3.1 | `**Retro:**` binding (#408) | `keep` promoted (repeated-incident): sensor is the only planning-quality instrument, binding yields 1 of 135 | only journey both passes rated `secured-out-of-proportion` | **cut the binding** — marker duty, closed-set check, blocking question, forced second `$wrapup` all die; `/retro` stays a voluntary offer |
| A3.2 | Fast-forward promise (#414) | `keep` promoted — counter-control C1 fail 0/3 with red positive control | consumer contract = strongest keep (A5) | **rebind as option (c), scoped by the ownership ledger** — update always activates fully; a consumer-edited `origin=kit` file *without* an ownership declaration is overwritten with backup + diff + end-of-update backup summary offering the supported routes as choices; `own --as=explicit-fork` remains the supported fork surface (ledger states never overwritten); conflict-blocking state removed; the *silent* in-place fork ends (#360 closed) |
| B1 | `tdd` standalone skill | — | pass 1: "duplicates implement", traversal 4 | **keep** — pass-1 verdict refuted at source: `implement:50` delegates to `/tdd`; composition, not duplication (calibration entry 1) |
| B2 | Skill-authoring house rules in always-on CLAUDE.md | — | 4 of 4 mechanically enforced by lints | **keep in shared CLAUDE.md/AGENTS.md, compressed** — the planned extension relocation was refuted in review: `write-a-skill` is Claude-only, its extension would be invisible to the Codex authoring surface; English-first already lives upstream-adapted in the skill |
| B3 | `wrapup` (217 lines, several routes) | #380 parked seed: release-to-merge conflated with cleanup | most-traversed closing journey | **rebind by split** — two skills: make-landable (local CI, PR prep) and land (merge, anchor sync, teardown, handoff); the land-planning-output prose folds into the landing half |
| B-II | `small-direct-path` depth gate | station verifies nothing ("the depth ladder is prose") | 2 of 52 human gates on 3 stations — highest human-gate density of any seed; release carries 1 on 6 | **cut** — the agent self-routes; confirmed from lived practice (routing happens through `/diagnose`→`/implement`, not through a question); blast-radius STOP and PR acceptance remain the net |
| B-III.4 | Cross-model review as default posture | — | monotone hardening bias, F5 | **rebind** — never was a hard default (skill pair encodes user choice; calibration entry 2); doctrine stops recommending it as standard; deep route keeps it; reviewer prompts gain the excess question |
| B-III.5 | S/B/C/P publish machinery (plan → to-prd → to-issues) | byte-verify fights GitHub's own CRLF normalization | 4-state machine, 3 body rewrites per issue, for an already-approved plan | **rebind by rebuild** — an **idempotent reconciler** (remote multi-write cannot be atomic): full preview → write → one invocation returns its own reconciliation result; re-runs only on interruption or reported partial failure (the proven `reconcileRelease` pattern); no separate verification layer |
| B-III.6 | `ask-matt` + `scale-check` merge | — | pass 2: "two routers, collapse" | **keep both** — verdict refuted at source: explicit single-ownership of the altitude catalog, cross-referenced delegation (calibration entry 3). The real redundancy is the third, always-on copy: CLAUDE.md routing prose (~40 lines) **compresses to one compact agent-readable route map (~5 lines)** — pointer-only would fail, both routers are user-invoked |
| C.1 | Recovery lines for 9 high-traversal unwatched journeys | counted, solid | pass 1 proposed 9 preventive lines | **cut to zero** — resume-after-interruption is default agent competence plus already-documented vocabulary (lease in orchestrate-wave, red-gate doctrine); a documented procedure would be accretion (caught by Niko at a glance) |
| C.2 | Consumer-side signal | 23 of 70 journeys unobservable; the kit's central journey has 0 gates | both passes refuse `unwatched` | **cut (no build)** — no telemetry; one honesty sentence in the README; the primary consumer's lived use is the signal channel |
| C.3 | Counterweight against ceremony accretion | F5: nothing can fail an added gate; the only counterweight is a human | 173 of 237 stations are gates; recovery paths 82 % | **add as prose, consolidated to one place** — build rule as programme doctrine plus **one** excess criterion in the shared review contract that reviewer prompts and `spec-self-critique` already read (a duplicated per-prompt lattice would itself re-accrete — Codex round-1 finding 14). Success reads at journey level, deliberately not per prose rule |
| D1 | Release machinery | every gate incident-backed (#205 #243 #257) | 6 gates on 6 stations, proportionate (both passes keep) | **keep — as opt-in profile route.** Not every consumer releases (testreporter pushes to main); journeys end cleanly at "merged" where no release station exists |
| D2 | Consumer-contract core (manifest, backup, transactional activation) | counter-control validated | 5 mechanical stations, 0 human gates | **keep** — in the decided (c) form; the one place with no floor beneath |
| D3 | `board-sync.py` as the board write path | — | one mechanism, one promise, six journeys (F7 positive control) | **keep** — the reference example of a proportionate gate |

## Doctrine decisions (cross-cutting, locked)

1. **The build rule (from A1, programme-wide).** A guard never reconstructs
   intent from file bytes or command strings. It checks present repository
   state (per ADR-0009), observable write targets (structured tool payloads —
   Bash exposes none, so Bash command authorization is deleted rather than
   rebuilt as shell-intent inference), and declarative configuration. A
   mechanism must be able to name what observed incident demands it, or it is
   not built.
2. **Verify-first splits into two classes with opposite defaults.**
   Assertions about existing state: read before claiming, always, unconditioned
   (the original intent of the rule, twice re-validated in this very session).
   Re-verification of one's own just-completed action: **off by default** — the
   tool's confirmation is the truth; exceptions are named, carry an incident
   number (#205 is the only earned one today), and are purpose-built with the
   work, never generic. Rollout spans repo CLAUDE.md and shipped doctrine; the
   matching edit to the personal global `~/.claude/CLAUDE.md` is a separate,
   explicitly accepted migration, never part of v1.0.0 acceptance.
3. **One floor per failure class.** A second floor is legitimate only where
   nothing catches beneath (consumer files, irreversible publication, tracked
   work). Where git, GitHub, or an idempotent re-run already catches the
   failure, any additional floor is ceremony. This is a review criterion (the
   one excess criterion in the shared review contract), not per-slice
   declaration paperwork.
4. **A workaround is a mechanism bug.** An agent observed working around a
   mechanism (force-teardown #2305 class, `.gitignore` disarming,
   `IMPACT_CENSUS_SKIP=1`) files an issue against the mechanism, never against
   the agent. This is the living needle for the 95→20-30 target.
5. **The success model (preamble of the v1.0.0 PRD).** Phase 1 — planning,
   human in the loop: friction is the product; success = the right questions at
   the right altitude, deliverable = an AFK-executable issue set true to the
   intent; architecture for large work is phase-1 material, never invented AFK.
   Phase 2 — implementation, AFK to acceptance: worktree → red→green → tests →
   CI → prepared PR → human acceptance → merged; friction — **unplanned
   repair interaction** (the acceptance and any planned stop are not
   friction) — is a defect. A journey succeeds when it runs intent-to-result
   with exactly the planned stops and nothing to sweep up afterwards; the
   existing house rule that friction becomes an issue is the **feedback
   heuristic** (not a measurement — 23 of 70 journeys are unobservable, and
   silence there proves nothing): a journey that stops producing friction
   issues while being walked works. No counting apparatus, no measurement
   windows.
6. **The kit core is a boundary object.** The Act-1/Act-2 path must work in
   every context (kit repo with releases, consumers without, Codex surface,
   third parties) without per-context adaptation. Liberal at the core,
   declarative at the edges: specialization lives in the three existing
   consumer surfaces (profile, project layer, skill extension), never in the
   core. A core that needs specialization to function has failed as a boundary
   object.

## Disagreements carried as findings (not resolved here)

- **D2 (traversal proxy admissibility).** No journey-attributed traversal
  record exists; pass 1's proxy is usable but over-precise, pass 2's refusal
  honest but unusable. **Decision under the simplicity frame: no traversal
  record is built** (that would be telemetry machinery, cf. C.2); the
  classification bins retire with the one-shot analysis instrument.
- **D3/D4 (gate basis 173 vs 62; interactions 52 vs 107).** Both counts kept
  side by side in the cost-walk artifacts; the informative gap (52 unattended
  decisions) is folded into the phase-2 friction lens rather than resolved.
- **Retro severity (move vs delete).** Resolved by Niko toward delete —
  "the road to hell is paved with good intentions."
- **Pass 2's ADR/research relocation.** Void as written (§D1 of the merge);
  its instinct survives as the #416 sentence correction.

## Calibration — model-pass reliability, measured in this grill

Three judgment verdicts flipped on source reading during the session; a fourth
accretion attempt was caught by the human. Counted against ~20 candidates
discussed: an error rate that mandates the HITL merge this slice is.

1. **`tdd` "duplicates implement"** — refuted by `implement/SKILL.md:50`
   (explicit delegation; 56-line file). Verdict origin: judgment from the
   derived station table, which carries no composition edges (pass 2's own B1
   finding names the blind spot).
2. **"Cross-model review is the default"** — refuted by the skill surface: the
   `grill-with-docs` / `grill-with-docs-codex` pair encodes user choice and
   always did.
3. **"Collapse `ask-matt` + `scale-check`"** — refuted by both files: explicit
   single-ownership contract and delegation; the real finding (always-on third
   copy in CLAUDE.md) only surfaced on reading.
4. **C.1 recovery procedure** — Claude packaged default agent competence as a
   documented two-step-plus-branch procedure; caught by Niko on sight as
   accretion-in-miniature.

5. **Wave-2 provisioning record (Codex round 1, blocker)** — the grill's first
   rebuild design re-invented persisted lifecycle evidence, the exact model
   ADR-0009 had retired after fifteen incidents and ~5,600 lines. Caught by
   the cross-model plan review reading the ADRs — the deep-route review
   earning its keep on a high-stakes plan, one session after its default
   status was cut. Plan revised to stateless-with-seed-profile.

Systematic cause: judgments were written from derived tables rather than
sources, in the blind spot both passes had themselves disclosed
("skill bodies were read as citations, not audited"; "station rows do not
compose"). Consequence applied within the session: no verdict reached the
table without its source files being read in this session. Consequence for the
programme: counted numbers from the passes are load-bearing; free-standing
judgment verdicts are hypotheses until source-read. A further datum in the
same class, supplied by Niko: the byte-compare teardown guard — the most
excessive mechanism in the census — had passed a cross-model adversarial
review. The review loop checks for holes, never for excess; the excess
question (C.3) is built against exactly that blindness.

## Board actions executed during the session

- **Closed with reasoning comments:** #410, #411, #412 (superseded by the A1
  rebuild under #401 — mechanisms deleted, reproductions become acceptance
  fixtures) · #409 (blind spot accepted; one-shot instrument) · #360 (the
  kept-fork model ends with #414 option (c)).
- **Decision recorded on:** #414 (option (c) comment). — #370, #373, #374
  remain open as #401 members; #374 carries the ownership decision until
  `to-prd` writes it into the anchor. #413, #416, #408 remain open as
  programme slices.
- **Parked explicitly (out of scope for v1.0.0):** programme-level
  orchestration / loop engineering beyond `orchestrate-wave` (session limits
  known, own question after the simplified base stands) · consumer telemetry ·
  the safety floor itself.
