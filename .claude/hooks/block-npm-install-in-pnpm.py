#!/usr/bin/env python3
"""Thin PreToolUse adapter for profile-driven package-manager consistency."""

import json
import sys
from pathlib import Path

from _hook_utils import log
from _safety_guard import load_core

HOOK_NAME = "block-package-manager"


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        core = load_core()
        profile = core.load_profile(Path("docs/agents/workflow-capabilities.json"))
        decision = core.evaluate("package-manager", profile, payload)
    except Exception:
        return 0
    if decision.action == "block":
        print(decision.message, file=sys.stderr)
        log(HOOK_NAME, decision.log_message)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
