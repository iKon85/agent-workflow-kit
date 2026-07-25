<!-- agent-workflow-kit: project-extension/v1; skill=orchestrate-wave -->
# Project layer — orchestrate-wave

The generic `orchestrate-wave` skill ships the full wave-landing **mechanics**
(disjointness recon → parallel implementers → serial integration → central verify
→ land) with no project tooling in the body. This file is the **project layer**:
it carries your project's exact commands, setup, verify recipe, login and deploy
detail. The skill probes it at runtime (Phase 0); with the sections below
**filled** it runs your project recipe instead of the generic fallback.

> **Section contract.** The skeleton refers to these exact headings by name.
> Keep them; fill each with your project's real detail. While a section is empty
> the skill treats the whole layer as absent (Phase-0 sentinel-stub rule) and
> falls back to generic instructions — so fill them before relying on the recipe.

## §Setup
<!-- Project setup steps Phase 0 runs before verify: DB/tunnel/services the
     live-verify depends on, dependency install, your worktree-setup command. -->

## §Builder Commands
<!-- Exact test / typecheck / fast-gate commands per package for the builder
     contract and integration. State the exact invocation; note any false-red
     traps (a test-runner arg that silently filters, a composite-typecheck flag). -->

## §Builder Hard Rules
<!-- UI-text language/Umlaut rules, design tokens, formatters, size gates —
     whatever a delegated implementer must obey in this repo. -->

## §Integration Suites
<!-- Every test framework the wave's files can belong to: the main suite plus any
     separate unit-test or script-test runner the main suite does NOT cover. -->

## §Verify Recipe
<!-- The central verify gate you re-run yourself: full CI command (+ any
     coordinator-branch skip/override), combined integration suite for schema/reader
     waves, the one-dev-server rule, design/brand checks, DB-compare coercion traps,
     console-clean command. -->

## §Headless Login
<!-- The AFK login recipe for the session-MCP browser profile: which profile,
     where it resolves, the login script, port lore — no password in the transcript. -->

## §Landing
<!-- Deploy trigger (auto-deploy-on-merge?), prod-migration command + lockstep
     window, the deploy-done signal, anchor-sync mechanics pointer. -->
