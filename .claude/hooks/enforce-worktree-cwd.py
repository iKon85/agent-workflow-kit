#!/usr/bin/env python3
"""PreToolUse adapter for commands that must run in their linked worktree."""

import json
import sys
from pathlib import Path

from _hook_utils import load_worktree_lifecycle_core


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        core = load_worktree_lifecycle_core()
        profile = core.load_profile(Path("docs/agents/workflow-capabilities.json"))
        decision = core.evaluate(profile, core.collect_facts(Path.cwd()), "command-cwd", payload)
    except Exception:
        return 0
    if decision.action == "block":
        print(decision.message, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
