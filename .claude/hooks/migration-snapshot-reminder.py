#!/usr/bin/env python3
"""PostToolUse migration artifact refresh reminder over consumer profile data."""
import json
import sys
from pathlib import Path

from _hook_utils import hook_event_output, load_workflow_advisories_core


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        core = load_workflow_advisories_core()
        profile = core.load_profile(Path("docs/agents/workflow-capabilities.json"))
        decision = core.migration_reminder_decision(profile, payload)
        if decision.context:
            print(json.dumps(hook_event_output(decision.event_name, decision.context)))
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
