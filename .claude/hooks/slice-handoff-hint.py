#!/usr/bin/env python3
"""UserPromptSubmit adapter for configured Worktree Lifecycle handoffs."""

import json
import sys
from pathlib import Path

from _hook_utils import hook_event_output, load_worktree_lifecycle_core


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        core = load_worktree_lifecycle_core()
        profile = core.load_profile(Path("docs/agents/workflow-capabilities.json"))
        decision = core.evaluate(profile, core.collect_facts(Path.cwd()), "handoff", payload)
    except Exception:
        return 0
    if decision.action == "emit":
        print(json.dumps(hook_event_output(decision.event_name, decision.message)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
