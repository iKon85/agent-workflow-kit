#!/usr/bin/env python3
"""SessionStart adapter for profile-driven branch and worktree facts."""

import json
import sys
from pathlib import Path

from _hook_utils import hook_event_output, load_worktree_lifecycle_core


def main() -> int:
    try:
        json.load(sys.stdin)
        core = load_worktree_lifecycle_core()
        profile = core.load_profile(Path("docs/agents/workflow-capabilities.json"))
        decision = core.evaluate(profile, core.collect_facts(Path.cwd()), "session-start", {})
    except Exception:
        return 0
    if decision.action == "emit":
        print(json.dumps(hook_event_output(decision.event_name, decision.message)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
