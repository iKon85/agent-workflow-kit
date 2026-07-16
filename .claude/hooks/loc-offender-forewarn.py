#!/usr/bin/env python3
"""SessionStart forewarning over the existing LoC gate and issue marker contracts."""
import json
import re
import subprocess
import sys
from pathlib import Path

from _hook_utils import (
    current_branch,
    hook_event_output,
    load_loc_offender_gate,
    load_workflow_advisories_core,
)


def main() -> int:
    try:
        json.load(sys.stdin)
    except Exception:
        pass
    try:
        root = Path.cwd()
        core = load_workflow_advisories_core()
        profile = core.load_profile(root / "docs/agents/workflow-capabilities.json")
        config = profile.get("locForewarn", {})
        match = re.search(config.get("branchRegex", r"$^"), current_branch())
        command = config.get("issueCommand", [])
        if not match or not command:
            return 0
        issue = match.group(1)
        argv = [str(part).replace("{issue}", issue) for part in command]
        result = subprocess.run(
            argv,
            cwd=root,
            capture_output=True,
            text=True,
            timeout=float(config.get("timeoutSeconds", 5)),
        )
        if result.returncode != 0:
            return 0
        gate = load_loc_offender_gate()
        max_lines, offenders = gate.load_max_lines(root / "max-lines-allowlist.json")
        context = gate.forewarning_context(result.stdout, max_lines, offenders)
        if context:
            budget = int(config.get("outputBudget", 500))
            if budget > 0 and len(context) > budget:
                context = context[: max(0, budget - 1)] + "…"
            print(json.dumps(hook_event_output("SessionStart", context)))
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
