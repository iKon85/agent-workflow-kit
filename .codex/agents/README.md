# Codex Agents

This directory holds project-scoped Codex custom agents as `.toml` files.

There are currently no `.claude/agents/*.md` files to adapt. When Claude-first
agent definitions are added, convert each relevant definition into a standalone
TOML file here with at least:

```toml
name = "agent-name"
description = "When Codex should spawn this agent."
developer_instructions = """
Specialized instructions for this agent.
"""
```

Optional custom-agent fields `model` and `model_reasoning_effort` belong to the
agent definition. They prove a named-agent route only when the active host
reports the applied values and precedence; the presence of a TOML file alone is
not enforcement evidence.

## Dated host routing attestation

The host inventory observed on 2026-07-23 exposes the native spawn fields
`task_name`, `message`, and `fork_turns`. It exposes no per-spawn `model` and no
per-spawn effort selector. That inventory can prove the ability to start a task,
but it cannot prove that a differentiated model-plus-effort request was applied.

`src/lib/routingAdapters/codex.mjs` records that dated Codex-only fact and uses
the shared resolver and spawn guard. It blocks differentiated AFK before spawn
instead of copying the requested route into a false Dispatch receipt v2. A
future host capability may be used only after a new dated attestation proves
the relevant per-spawn, named-agent, or session-default controls and their
precedence.
