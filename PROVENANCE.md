# Provenance

Origin and license of every skill shipped in this kit. Model: fork-and-own —
vendored skills are locally adapted; the pinned upstream SHA is for attribution,
not byte-identity.

## Matt Pocock (MIT) — https://github.com/mattpocock/skills @ d574778

to-prd, to-issues, grill-with-docs, grill-me, tdd, diagnose, zoom-out,
improve-codebase-architecture, prototype, triage, write-a-skill,
codebase-design, domain-modeling, implement, resolving-merge-conflicts, ask-matt,
wayfinder, research, git-guardrails-claude-code, setup-workflow.

Folder↔upstream-name divergence (upstream renamed; local folder kept for
invocation stability): `diagnose` = upstream `diagnosing-bugs`,
`write-a-skill` = upstream `writing-great-skills`, `to-prd` = upstream
`to-spec`, `to-issues` = upstream `to-tickets` (upstream merged to-issues +
the short-lived to-plan into to-tickets @ v1.1.0). `zoom-out` was removed
upstream (attribution pins to its last-seen SHA 2bf7005) and is retained here
as a local fork.

Each carries a `THIRD-PARTY-NOTICES.md` with its upstream path.

## Chase AI (MIT) — https://github.com/chaseai-yt/grill-me-codex @ fe37a70

grill-me-codex, grill-with-docs-codex, codex-review, codex-build. The first
three add an Act-2 cross-model Codex review and themselves adapt Matt Pocock's
grill-me / grill-with-docs (MIT); codex-build is the Act-3 role-flip (locally
adapted: bounded workspace-write sandbox instead of upstream's `--yolo`). Each
carries Chase's `THIRD-PARTY-NOTICES.md`.

## Own work (MIT, Copyright (c) 2026 Niko (iKon85))

retro, wrapup, spec-self-critique, board-to-waves, verify-spike, decision-gate,
codex-adapter-sync, setup-pre-commit, code-review, orchestrate-wave,
census-update, memory-lifecycle, project-release — covered by the root LICENSE.
`setup-pre-commit` was rewritten from Matt Pocock's husky-based skill to a
zero-dep native git `core.hooksPath` scaffold; nothing of the original
mechanic remains (courtesy attribution).
