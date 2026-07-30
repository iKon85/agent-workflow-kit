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
def manifest_path(file_path: str, root: Path) -> str | None:
    try:
        target = Path(file_path)
        target = target if target.is_absolute() else root / target
        normalized = target.resolve().relative_to(root.resolve()).as_posix()
    except (OSError, ValueError):
        return None
    return normalized or None


def kit_origin_path(payload: object, root: Path) -> str | None:
    if not isinstance(payload, dict) or payload.get("tool_name") not in TOOLS:
        return None
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict) or not isinstance(tool_input.get("file_path"), str):
        return None
    path = manifest_path(tool_input["file_path"], root)
    if path is None:
        return None
    manifest = json.loads((root / MANIFEST).read_text(encoding="utf-8"))
    installed = manifest.get("installed", []) if isinstance(manifest, dict) else []
    return path if any(
        isinstance(entry, dict) and entry.get("path") == path and entry.get("origin") == "kit"
        for entry in installed
    ) else None


def hint(path: str) -> str:
    return (
        "This file has kit origin. An edit left undeclared here is replaced by the "
        "next update, which keeps your bytes in a backup and names them. Before "
        "editing, ask whether the change should stay Consumer-owned or return "
        "upstream. If it becomes a Contribution Bridge, read the "
        "repository-scoped route with "
        f"`agent-workflow-kit contribute status {path} --surface=guard`; "
        "missing or invalid capability configuration offers preserve/fork only."
    )


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        path = kit_origin_path(payload, Path.cwd())
        if path:
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "additionalContext": hint(path),
                }
            }))
    except (OSError, ValueError, TypeError):
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
