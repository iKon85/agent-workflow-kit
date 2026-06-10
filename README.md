# agent-workflow-kit

Portable AI-agent workflow skills — **plan → execute → land → learn** — for
Claude Code & Codex. One `npx` command installs the skills, helper scripts, and
project-layer stubs into any repo.

## Quickstart

```sh
npx github:iKon85/agent-workflow-kit init
```

Then run `/setup-workflow` once to fill the project layer (issue tracker, board
profile, deploy target). Update later with `npx github:iKon85/agent-workflow-kit update`
(`diff` to preview, `uninstall` to remove). User edits are never clobbered.

## What's included

- **Workflow skills:** grill-me, grill-with-docs, to-prd, to-issues, tdd,
  diagnose, zoom-out, improve-codebase-architecture, prototype, triage,
  write-a-skill, git-guardrails, setup-pre-commit, setup-workflow, board-to-waves,
  retro, wrapup, spec-self-critique.
- **Cross-model review (Codex):** grill-me-codex, grill-with-docs-codex, codex-review.
- **Helper scripts:** board-sync.py, execute-ready-check.py, pr-body-check.py,
  a handoff drift-guard hook, and a wave-anchor template.

## Credits

- Several skills are adapted from **Matt Pocock's skills**
  (https://github.com/mattpocock/skills), MIT.
- The `grill-*-codex` / `codex-review` cross-model review is by **Chase AI**
  (https://github.com/chaseai-yt/grill-me-codex), MIT.
- `retro`, `wrapup`, `spec-self-critique`, `board-to-waves` are original work.

See each adapted skill's `THIRD-PARTY-NOTICES.md` and `PROVENANCE.md`.

## License

MIT — see [LICENSE](LICENSE).

## Note on language

Some skill prose is currently German (the workflow conventions originated in a
German-speaking project). The skills are functionally portable via the project
profile; an English translation is a planned follow-up.
