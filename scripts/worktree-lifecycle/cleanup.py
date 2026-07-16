#!/usr/bin/env python3
"""Preview or safely remove a profile-governed linked worktree."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from core import LifecycleError, cleanup_assessment, load_profile, main_worktree, run


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="docs/agents/workflow-capabilities.json")
    parser.add_argument("--remove", action="store_true")
    parser.add_argument("worktree")
    return parser.parse_args()


def execute(args: argparse.Namespace) -> dict:
    main = main_worktree(Path.cwd())
    profile_path = Path(args.profile)
    if not profile_path.is_absolute():
        profile_path = main / profile_path
    profile = load_profile(profile_path)
    assessment = cleanup_assessment(profile, main, Path(args.worktree))
    report = {
        "worktree": str(assessment.worktree),
        "branch": assessment.branch,
        "removable": assessment.removable,
        "reasons": list(assessment.reasons),
        "assumptions": assessment.assumptions,
        "removed": False,
    }
    if not args.remove:
        return report
    if not assessment.removable:
        raise LifecycleError("; ".join(assessment.reasons))
    run(["git", "worktree", "remove", str(assessment.worktree)], cwd=main)
    run(["git", "branch", "-d", assessment.branch], cwd=main)
    report["removed"] = True
    return report


def main() -> int:
    try:
        print(json.dumps(execute(parse_args()), ensure_ascii=False, indent=2))
        return 0
    except LifecycleError as error:
        print(f"STOP: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
