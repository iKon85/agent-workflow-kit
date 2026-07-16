#!/usr/bin/env python3
"""Stop-event adapter for profile-defined affected-surface checks."""
import json
import sys
from pathlib import Path

from _hook_utils import hook_event_output, load_workflow_advisories_core, run


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if "changed_files" not in payload:
            changed = run(["git", "diff", "--name-only", "HEAD"])
            payload["changed_files"] = changed.splitlines() if changed else []
        core = load_workflow_advisories_core()
        profile = core.load_profile(Path("docs/agents/workflow-capabilities.json"))
        decision = core.stop_check_decision(profile, payload, Path.cwd())
        if decision.context:
            print(json.dumps(hook_event_output(decision.event_name, decision.context)))
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
