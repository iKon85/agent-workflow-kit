#!/usr/bin/env python3
"""PostToolUse adapter for branch-changing shell commands."""

import json
import sys
from pathlib import Path

from _hook_utils import load_worktree_lifecycle_core


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        core = load_worktree_lifecycle_core()
        profile = core.load_profile(Path("docs/agents/workflow-capabilities.json"))
        decision = core.evaluate(profile, core.collect_facts(Path.cwd()), "branch-watch", payload)
    except Exception:
        return 0
    if decision.action == "emit":
        print(json.dumps({"systemMessage": decision.message}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
