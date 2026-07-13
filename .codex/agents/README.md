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
