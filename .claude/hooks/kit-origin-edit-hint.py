#!/usr/bin/env python3
"""Advisory PreToolUse hint for kit-origin Edit/Write targets.

Covered surface: agent Edit/Write tools only. Shell redirection, formatters, and
IDE edits are knowingly uncovered; the skills remain the rule's primary
carrier. This hook never enforces or blocks. It performs a single manifest read,
does no network work, and fails open silently when input or manifest is unusable.
"""
import json
import sys
from pathlib import Path

MANIFEST = "agent-workflow-kit.json"
TOOLS = {"Edit", "Write"}
HINT = (
    "This file has kit origin. Before editing, ask: should this change go "
    "upstream to agent-workflow-kit, or should the consumer own this file?"
)


def manifest_path(file_path: str, root: Path) -> str | None:
    try:
        target = Path(file_path)
        target = target if target.is_absolute() else root / target
        normalized = target.resolve().relative_to(root.resolve()).as_posix()
    except (OSError, ValueError):
        return None
    return normalized or None


def is_kit_origin(payload: object, root: Path) -> bool:
    if not isinstance(payload, dict) or payload.get("tool_name") not in TOOLS:
        return False
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict) or not isinstance(tool_input.get("file_path"), str):
        return False
    path = manifest_path(tool_input["file_path"], root)
    if path is None:
        return False
    manifest = json.loads((root / MANIFEST).read_text(encoding="utf-8"))
    installed = manifest.get("installed", []) if isinstance(manifest, dict) else []
    return any(
        isinstance(entry, dict) and entry.get("path") == path and entry.get("origin") == "kit"
        for entry in installed
    )


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if is_kit_origin(payload, Path.cwd()):
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "additionalContext": HINT,
                }
            }))
    except (OSError, ValueError, TypeError):
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
