#!/usr/bin/env python3
"""Reproduction probe R2 — `targets_linked_worktree` decides authorization by
substring (Truth / wrong axis + fail-open).

`scripts/worktree-lifecycle/core.py::targets_linked_worktree` returns True when
the *command string contains* a linked-worktree path, and `command_decision`
treats that as authorization. The probe calls the shipped functions directly
with synthetic `RepoFacts` — no repository is touched, nothing is executed.

Arms:
  baseline        risky command in the protected main checkout          -> block
  bypass-mention  same command, with a linked-worktree path in a comment-> allow
  bypass-echo     same command, path only inside an unrelated string    -> allow
  outside-repo    command legitimately operating outside the repo       -> block

`bypass-*` allowing is the fail-open direction; `outside-repo` blocking is the
fail-closed direction of the same predicate. Deterministic; no network.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[5]
LIFECYCLE = REPO / "scripts/worktree-lifecycle"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


# `core` imports its siblings by bare module name, so the lifecycle directory
# goes on the path exactly the way the shipped hook entry points put it there.
sys.path.insert(0, str(LIFECYCLE))
profile_module = load("profile", LIFECYCLE / "profile.py")
core = load("w31_core", LIFECYCLE / "core.py")

PROFILE_TEXT = """{
  "worktreeLifecycle": {
    "enabled": true,
    "worktreeRoot": ".worktrees",
    "protectedBranches": ["main"],
    "setupSteps": []
  }
}"""

MAIN = Path("/fixture/repo")
LINKED = MAIN / ".worktrees" / "380-truth-census"

FACTS = core.RepoFacts(
    root=MAIN,
    main_root=MAIN,
    branch="main",
    main_branch="main",
    is_main_worktree=True,
    worktrees=(MAIN, LINKED),
    changed_count=0,
)

ARMS = [
    ("baseline", "git push --force origin main"),
    ("bypass-mention", "git push --force origin main # see .worktrees/380-truth-census"),
    ("bypass-echo", 'echo "/fixture/repo/.worktrees/380-truth-census" && git push --force origin main'),
    ("outside-repo-cd", "cd /srv/other-checkout && git push --force origin main"),
    ("risky-regex-evaded", "git -C /srv/other-checkout push --force origin main"),
]


def main() -> int:
    prof = profile_module.load_profile_text(PROFILE_TEXT)
    arms = []
    for name, command in ARMS:
        decision = core.command_decision(prof, FACTS, {
            "tool_name": "Bash",
            "tool_input": {"command": command},
        })
        arms.append({
            "arm": name,
            "command": command,
            "targetsLinkedWorktree": core.targets_linked_worktree(command, FACTS),
            "action": decision.action,
        })
    by = {a["arm"]: a for a in arms}
    result = {
        "probe": "R2-command-substring",
        "target": "scripts/worktree-lifecycle/core.py::targets_linked_worktree",
        "arms": arms,
        "reproduced": (
            by["baseline"]["action"] == "block"
            and by["bypass-mention"]["action"] == "allow"
            and by["bypass-echo"]["action"] == "allow"
        ),
        "failClosedArm": by["outside-repo-cd"]["action"],
        "riskyRegexEvaded": by["risky-regex-evaded"]["action"] == "allow"
        and not by["risky-regex-evaded"]["targetsLinkedWorktree"],
    }
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
