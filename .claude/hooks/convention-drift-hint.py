#!/usr/bin/env python3
"""SessionStart convention freshness advisory over profile-owned source maps."""
import json
import sys
from pathlib import Path

from _hook_utils import hook_event_output, load_workflow_advisories_core


def main() -> int:
    try:
        json.load(sys.stdin)
    except Exception:
        pass
    try:
        core = load_workflow_advisories_core()
        profile = core.load_profile(Path("docs/agents/workflow-capabilities.json"))
        decision = core.convention_freshness_decision(profile, Path.cwd())
        if decision.context:
            print(json.dumps(hook_event_output(decision.event_name, decision.context)))
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
