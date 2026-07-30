# Provenance

Origin and license of every skill shipped in this kit, and of adopted doctrine
text. Model: fork-and-own — vendored material is locally adapted; the pinned
upstream SHA is for attribution, not byte-identity.

## Matt Pocock (MIT) — https://github.com/mattpocock/skills @ d574778

to-prd, to-issues, grill-with-docs, grill-me, tdd, diagnose,
improve-codebase-architecture, prototype, triage, write-a-skill,
codebase-design, domain-modeling, implement, resolving-merge-conflicts, ask-matt,
wayfinder, research, git-guardrails-claude-code, setup-workflow.

Folder↔upstream-name divergence (upstream renamed; local folder kept for
invocation stability): `diagnose` = upstream `diagnosing-bugs`,
`write-a-skill` = upstream `writing-great-skills`, `to-prd` = upstream
`to-spec`, `to-issues` = upstream `to-tickets` (upstream merged to-issues +
the short-lived to-plan into to-tickets @ v1.1.0). `zoom-out` (last-seen
upstream SHA 2bf7005) was removed upstream and, after a period as a local
fork, removed from this kit as well — `improve-codebase-architecture` covers
the step-back-to-the-structure door.

Each carries a `THIRD-PARTY-NOTICES.md` with its upstream path.

## Chase AI (MIT) — https://github.com/chaseai-yt/grill-me-codex @ fe37a70

grill-me-codex, grill-with-docs-codex, codex-review, codex-build. The first
three add an Act-2 cross-model Codex review and themselves adapt Matt Pocock's
grill-me / grill-with-docs (MIT); codex-build is the Act-3 role-flip (locally
adapted: bounded workspace-write sandbox instead of upstream's `--yolo`). Each
carries Chase's `THIRD-PARTY-NOTICES.md`.

## forrestchang (MIT) — https://github.com/multica-ai/andrej-karpathy-skills @ 2c60614

Doctrine text, not a skill. The four behavioral principles in that repo's root
`CLAUDE.md` — Think Before Coding · Simplicity First · Surgical Changes ·
Goal-Driven Execution, derived from Andrej Karpathy's observations on LLM coding
pitfalls — are adapted into this repo's `CLAUDE.md` §Behavioral core: rewritten
in the kit's voice, condensed, and merged with our own doctrine (verify-first in
two classes, one floor per failure class, add only on observed failure). The
upstream self-conditioning ("for trivial tasks, use judgment") and its
senior-engineer test are kept. MIT is declared in the upstream README §License
and in `.claude-plugin/plugin.json` (`"license": "MIT"`, author `forrestchang`);
that repository carries no LICENSE file of its own. Adopted 2026-07-30.

## Own work (MIT, Copyright (c) 2026 Niko (iKon85))

retro, wrapup, spec-self-critique, board-to-waves, verify-spike, decision-gate,
codex-adapter-sync, setup-pre-commit, code-review, orchestrate-wave,
census-update, memory-lifecycle, project-release — covered by the root LICENSE.
`setup-pre-commit` was rewritten from Matt Pocock's husky-based skill to a
zero-dep native git `core.hooksPath` scaffold; nothing of the original
mechanic remains (courtesy attribution).
