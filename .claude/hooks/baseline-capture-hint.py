#!/usr/bin/env python3
"""PreToolUse once-per-branch baseline advisory for impacting edits."""
import json
import sys
from pathlib import Path

from _hook_utils import current_branch, hook_event_output, load_workflow_advisories_core


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        core = load_workflow_advisories_core()
        profile = core.load_profile(Path("docs/agents/workflow-capabilities.json"))
        branch = payload.get("branch") or current_branch()
        decision = core.baseline_decision(profile, payload, Path.cwd(), branch)
        if decision.context:
            print(json.dumps(hook_event_output(decision.event_name, decision.context)))
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
