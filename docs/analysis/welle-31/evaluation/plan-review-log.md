<!-- language-census: ok -->
# Plan Review Log: v1.0.0 simplicity re-cut
Act 1 (grill-with-docs-codex) complete 2026-07-29 — plan locked, merged-findings written, board actions executed. MAX_ROUNDS=3.

## Round 1 — Codex (gpt-5.6-sol/high, read-only, runId T4n6GddU)

1. **Blocker — Wave 2 resurrects the failed receipt model.** The proposed provisioning record ([PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:85)) directly contradicts the accepted stateless classification contract ([CONTEXT.md](/home/niko/projects/agent-workflow-kit/CONTEXT.md:197), [ADR-0009](/home/niko/projects/agent-workflow-kit/docs/adr/0009-teardown-authority-is-stateless-repository-classification.md:6)), which replaced receipts after fifteen cleanup incidents and ~5,600 lines of machinery. Kit-owned creation also contradicts the explicit support for externally created worktrees.

   Fix: Delete the provisioning record and creator-ownership rule; retain present-state Git classification and change only the three reproduced bad predicates.

2. **Blocker — Option (c) has no ownership-ledger contract.** The plan ends the “kept-fork model” ([PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:110)), but shipped behavior preserves `project-extension`, `contribution-bridge`, and `explicit-fork` entries ([updateReconcile.mjs](/home/niko/projects/agent-workflow-kit/src/lib/updateReconcile.mjs:39), [manifest.mjs](/home/niko/projects/agent-workflow-kit/src/lib/manifest.mjs:28)), while `own`, `disown`, and `contribute` remain public commands. It never says whether overwrite applies only to locally edited `origin=kit` files or silently transfers consumer-owned paths back to Core.

   Fix: Scope overwrite explicitly to `origin=kit` edits, or include the complete removal/migration of fork and bridge commands, ledger states, docs, and glossary terms in the same slice.

3. **Blocker — “Project layer never touched” contradicts shipped behavior.** Update currently seeds missing project-layer stubs and performs narrow `CLAUDE.md`/`AGENTS.md` migrations transactionally ([kit-update](/home/niko/projects/agent-workflow-kit/.claude/skills/kit-update/SKILL.md:48), [updateCandidate.mjs](/home/niko/projects/agent-workflow-kit/src/lib/updateCandidate.mjs:367)); the consumer contract expressly allows those migrations ([CLAUDE.md](/home/niko/projects/agent-workflow-kit/CLAUDE.md:73)).

   Fix: Say “ordinary reconciliation never touches the project layer; existing explicit schema migrations remain allowed.”

4. **Major — The update summary risks making a user-owned semantic decision.** “Lists … where the edit belongs” ([PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:110)) can only be implemented by classifying an edit as project-specific, upstream-worthy, or a fork; the current skill deliberately asks the user instead ([kit-update](/home/niko/projects/agent-workflow-kit/.claude/skills/kit-update/SKILL.md:121)).

   Fix: Report the backup and present the supported routes as choices; never assign a route mechanically.

5. **Major — The promised backup floor is not supported by the existing primitive.** `backupFile` copies to a caller-supplied timestamp path and overwrites an existing file ([atomicWrite.mjs](/home/niko/projects/agent-workflow-kit/src/lib/atomicWrite.mjs:16)); an immediate retry can therefore replace the only copy of the original local edit, violating “nothing lost.”

   Fix: Keep conflict-blocking until backup creation is demonstrably non-overwriting; do not ship option (c) on the current helper.

6. **Major — Relocating authoring rules makes them invisible to Codex.** `write-a-skill` is deliberately Claude-only ([AGENTS.md](/home/niko/projects/agent-workflow-kit/AGENTS.md:5)), while Codex is still expected to author Claude-first and synchronize mirrors. Moving all remaining rules into that skill’s project extension ([PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:81)) removes the contract from one supported surface.

   Fix: Keep the three repository authoring contracts in shared `CLAUDE.md`/`AGENTS.md`; relocate only material actually reachable by both authoring surfaces.

7. **Major — Routing pointers point to tools the agent cannot invoke.** Both `ask-matt` and `scale-check` have `disable-model-invocation: true`, so replacing the operative routing map with pointers to them ([PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:76)) conflicts with the claim that agents will self-route.

   Fix: Retain one compact always-visible default route; reserve the two routers for explicit user invocation.

8. **Major excess — #413 justifies tolerant Prod recognition, not a new installer report.** The observed defect is an exact-heading false negative ([merged-findings.md](/home/niko/projects/agent-workflow-kit/.worktrees/405-evaluation/docs/analysis/welle-31/evaluation/merged-findings.md:27)); no cited incident demands invoking readiness after every `init` and `update`. “Named differently” is also not mechanically distinguishable from “absent” without inventing fuzzy intent inference.

   Fix: Correct the heading predicate and diagnostics where readiness is already queried; drop the new installer report and unknowable renamed-heading code.

9. **Major — “Transactional” GitHub publication is a false contract.** Issue creation, board addition, labels, links, and field stamps cannot be one atomic remote write; existing code explicitly handles “issue created, board sync failed” and mid-promotion partial state ([board-sync.py](/home/niko/projects/agent-workflow-kit/scripts/board-sync.py:859)). The idempotent re-run is the real contract.

   Fix: Call Publish v2 an idempotent reconciler, not a transaction, and have the rerun’s current-state result replace a separate verification layer.

10. **Major excess — Counted readback contradicts the new verify doctrine.** The plan says post-action verification is off unless incident-backed and names only #205 ([PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:51)), yet Publish v2 retains an uncited `N of N` readback ([PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:100)).

   Fix: Either cite the publication incident that earned readback or remove it and let idempotent reconciliation report its resolved state.

11. **Major excess — Splitting `wrapup` adds routing and handoff without an observed failure.** The evaluation supplies line count and traversal, not an incident of premature completion ([merged-findings.md](/home/niko/projects/agent-workflow-kit/.worktrees/405-evaluation/docs/analysis/welle-31/evaluation/merged-findings.md:35)); the repository’s own skill-design rule permits splitting only for distinct invocation or observed rushing ([write-a-skill](/home/niko/projects/agent-workflow-kit/.claude/skills/write-a-skill/SKILL.md:59)). Current landing already pauses at user acceptance and resumes idempotently.

   Fix: Prune `wrapup` into one linear route with its existing acceptance pause instead of creating two skills.

12. **Major excess — Release is already profile/invocation dependent.** `wrapup` already omits deploy reporting when `prodTarget` is unavailable and continues landing ([wrapup](/home/niko/projects/agent-workflow-kit/.claude/skills/wrapup/SKILL.md:58)); `project-release` already requires its profile. Slice 14 adds a second profile-routing concept without naming a missing behavior.

   Fix: Delete slice 14 and limit the work to correcting any concrete false release implication under #416.

13. **Major — The success model contradicts itself and claims unobservable success.** Phase 2 explicitly includes human acceptance, then defines all cross-side interaction as a defect ([PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:20)). It also says “no issue means it works” despite the evaluation finding 23 of 70 journeys unobservable ([merged-findings.md](/home/niko/projects/agent-workflow-kit/.worktrees/405-evaluation/docs/analysis/welle-31/evaluation/merged-findings.md:41)); silence could equally mean abandonment or missing feedback.

   Fix: Define only unplanned repair interaction as friction, and call issue flow a feedback heuristic rather than a measurement of success.

14. **Major excess — The anti-ceremony doctrine re-accretes ceremony.** Per-mechanism protection lines, per-rebuild floor declarations, per-slice source rereads, an excess question in every reviewer prompt, and a second spec checklist restate normal review competence across several locations ([PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:42), [PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:126), [PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:152)). The cited incidents justify one adversarial excess criterion, not this documentation lattice.

   Fix: Keep one excess criterion in the shared review contract and delete the per-mechanism, per-slice, and duplicated-prompt obligations.

15. **Major — The hook review evades its own denominator and safety rules.** “24 hooks” is a frozen analysis count, contrary to the repository rule that cross-cutting denominators are re-derived fresh ([CLAUDE.md](/home/niko/projects/agent-workflow-kit/CLAUDE.md:161)); declaring the safety floor out of scope simultaneously exempts retained mechanisms from the required incident test.

   Fix: Review the current manifest-derived hook set and require named incidents for every retained hook, with no blanket “safety floor” exemption.

16. **Major — Personal global configuration is improperly coupled to the product release.** Editing `~/.claude/CLAUDE.md` is user-local, non-package state, cannot be verified by the v1 artifact, and makes release completion context-specific despite the boundary-object claim ([PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:28), [PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:118)).

   Fix: Remove the global-file mutation from v1 release acceptance and offer it separately as an explicit personal migration.

VERDICT: REVISE



### Claude's response (revision for round 2)

Accepted (verified at source before revising): 1 (ADR-0009 confirmed verbatim — wave 2 rebuilt as stateless + declarative seed profile, external worktrees first-class), 2 (ownership ledger confirmed: own/disown/contribute + explicit-fork state; option (c) scoped to unowned origin=kit edits), 3 (project-layer wording: ordinary reconciliation never touches it, explicit schema migrations remain), 4 (summary offers routes as choices, never assigns), 5 (backupFile confirmed clobbering on same stamp — slice hardens it to non-clobbering), 6 (write-a-skill is Claude-only — authoring rules stay in shared CLAUDE.md/AGENTS.md compressed; relocation slice dropped), 7 (both routers confirmed disable-model-invocation — compact agent-readable route map instead of pointer-only), 9+10 (publish v2 renamed idempotent reconciler; re-run's resolved-state report is the only verification, no separate readback layer), 12 (wrapup prodTarget degradation confirmed at SKILL.md:62-63 — slice 14 deleted, reduced to a false-implication sweep inside #416), 13 (friction = unplanned repair interaction; issue flow = feedback heuristic, not measurement), 14 partially (doctrine consolidated: four sentences + ONE excess criterion in the shared review contract; per-mechanism/per-slice paperwork obligations dropped), 15 (hook denominator re-derived fresh at slice time; no safety-floor exemption), 16 (global CLAUDE.md edit decoupled from release — separate explicitly-accepted personal migration).

Rejected (user decisions from Act 1, Niko as decision owner, reasons logged): 8 in part — the installer readiness summary stays (explicit user request this session); accepted within 8: the heading fix is normalize+prefix matching with found-headings diagnostics, no fuzzy renamed-vs-absent inference, report-only. 11 — the wrapup split stays (explicit user decision; justified by the two genuinely distinct invocation moments post-implement vs post-acceptance, which satisfies the write-a-skill split rule Codex cited). 14 in part — the build rule itself stays as doctrine (explicit user demand after the byte-compare history).

## Round 2 — Codex (same session)

Most round-1 findings are resolved. The settled rejections were not reopened. Remaining defects:

1. **Blocker — `merged-findings.md` still contradicts the revised plan.** It retains relocation into `write-a-skill`, transactional publication with counted readback, a provisioning record, global-config rollout, duplicated reviewer prose, per-mechanism floor declarations, and the old friction definition ([merged-findings.md](/home/niko/projects/agent-workflow-kit/.worktrees/405-evaluation/docs/analysis/welle-31/evaluation/merged-findings.md:34)). Because the plan calls this the “full candidate evaluation,” implementers have two binding answers.

   Fix: Synchronize every revised decision into `merged-findings.md` before publishing the PRD.

2. **Blocker — The seed profile is being mistaken for present ownership evidence.** A declaration that setup normally provisions `.env` does not prove the current file was generated, remained unchanged, or was created by the helper—especially for first-class external worktrees. Nevertheless, declared `.env` files become unconditionally deletable ([PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:93)). That can delete a manually created or subsequently edited secret and contradicts the present-state rule.

   Fix: Do not let the seed declaration authorize deletion; explicitly choose between treating every ignored `.env` as accepted-risk Scratch or retaining a conservative teardown block.

3. **Major — Wave 2 still contradicts ADR-0009 and `CONTEXT.md`.** ADR-0009 says ignore rules are the sole configurable deletion policy and specifies byte comparison as the `.env` exception ([ADR-0009](/home/niko/projects/agent-workflow-kit/docs/adr/0009-teardown-authority-is-stateless-repository-classification.md:28)); `Scratch` says the same ([CONTEXT.md](/home/niko/projects/agent-workflow-kit/CONTEXT.md:206)). The plan changes both contracts but calls itself “per ADR-0009” and includes no corresponding decision-document update.

   Fix: Include the chosen `.env` policy’s amendment to ADR-0009 and `CONTEXT.md` in slice 6.

4. **Major — “Check the write target” is not observable for arbitrary Bash.** Structured Edit/Write payloads expose `file_path` ([core.py](/home/niko/projects/agent-workflow-kit/scripts/worktree-lifecycle/core.py:456)); Bash exposes only the command string ([core.py](/home/niko/projects/agent-workflow-kit/scripts/worktree-lifecycle/core.py:497)). After deleting command regexes and substring parsing, there is no pre-execution write target for that hook to check.

   Fix: Scope target authorization to tools carrying structured paths and explicitly delete Bash command authorization rather than rebuilding shell-intent inference.

5. **Major — Publish v2 still makes an unconditional rerun a verification layer.** “The re-run’s … report is the only verification” ([PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:112)) contradicts the doctrine that completed-action reverification is off absent an incident. Idempotency supports recovery; it does not require every successful publication to run twice.

   Fix: Make one invocation return its reconciliation result; reserve reruns for interruption or reported partial failure.

6. **Major — The readiness contract remains underspecified and conflicts with shipped privacy behavior.** Raw prefix matching can classify `## Production` or `## Product` as Prod, while naming headings “actually found” contradicts the current promise that diagnostics never echo consumer content ([kit-update](/home/niko/projects/agent-workflow-kit/.claude/skills/kit-update/SKILL.md:61)). Also, `update` has an availability result, but `init` currently has no existing aggregate readiness result to print ([init.mjs](/home/niko/projects/agent-workflow-kit/src/commands/init.mjs:34)).

   Fix: Define a whole-word normalized H2 match, the bounded sanitized diagnostic payload, and the exact existing evaluator whose result `init` and `update` render.

VERDICT: REVISE

### Claude's response (revision for round 3)

All six accepted, none conflicted with Act-1 user decisions:
1. merged-findings.md fully synchronized with the revised plan (B2 keep-in-shared-doc, publish reconciler wording, route-map compression, consolidated excess criterion, doctrine 1/2, friction definition, A1 row).
2+3. `.env` policy chosen and made an explicit ADR amendment: profile declaration grants deletion authority (consent-based, gitignore logic), undeclared `.env*` keeps the conservative byte-compare block; ADR-0009 + CONTEXT.md Scratch amended in slice 6 — no silent contract divergence.
4. Write-target authorization scoped to structured payloads (Edit/Write); Bash command authorization deleted outright — no shell-intent inference rebuilt (verified core.py:456 vs :497).
5. Publish v2: one invocation returns its own reconciliation result; re-runs reserved for interruption or reported partial failure — no unconditional double-run.
6. Readiness spec pinned: whole-word normalized H2 match (catches "Prod und Deployment", never "Production"), missing-section vs heading-mismatch + line number, bounded sanitized diagnostics (no consumer-content echo), one shared evaluator rendered by init (post-install) and update.

## Round 3 — Codex (same session, final round, cap=3)

One defect remains:

1. **Major — stale ceremony requirement:** [merged-findings.md](/home/niko/projects/agent-workflow-kit/.worktrees/405-evaluation/docs/analysis/welle-31/evaluation/merged-findings.md:65) still requires every rebuild slice to name the “floor” beneath each retained mechanism. That contradicts [PLAN.md](/home/niko/projects/agent-workflow-kit/PLAN.md:53), which explicitly rejects per-mechanism ledgers and per-slice declaration paperwork. Because the evaluation remains an implementation authority, this can re-accrete exactly the ceremony the re-cut removes. **Fix:** Delete the final sentence of doctrine item 3 requiring every rebuild slice to name each mechanism’s floor.

The six substantive round-2 corrections otherwise appear synchronized and source-compatible.

VERDICT: REVISE

### Claude's response (resolution)

Cap reached at REVISE with exactly one residual finding — a stale sentence in
merged-findings doctrine item 3 (per-slice floor declarations) contradicting
the consolidated doctrine, i.e. the same class as round-1 finding 14 which was
already accepted. Fixed post-round (sentence replaced: the floor principle is
the one excess criterion in the shared review contract, not per-slice
paperwork). No substantive disagreement remains; Codex round 3 states the six
round-2 corrections are synchronized and source-compatible. Presented to Niko
as: converged in substance, cap hit on a one-sentence sync defect, fix applied
and logged rather than a fourth round burned.
