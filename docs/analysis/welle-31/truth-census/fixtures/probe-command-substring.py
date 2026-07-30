#!/usr/bin/env python3
"""Reproduction probe R2 — authorization by command substring (Truth / wrong
axis + fail-open), retired by the authorization re-cut (#373, #411, #412).

Under v1, `scripts/worktree-lifecycle/core.py::targets_linked_worktree` returned
True when the *command string contained* a linked-worktree path, and
`command_decision` treated that as authorization. This probe kept the failure
class visible; it now pins its removal.

Under v2 no `Bash` payload is judged at all: authorization reads an **observable
write target** out of a structured Edit/Write payload, so the arms below leave
the guard without an opinion (`skip`) instead of a wrong one.

Command arms — all `skip` under v2:
  baseline           risky command in the protected main checkout
  bypass-mention     same command, with a linked-worktree path in a comment
  bypass-echo        same command, path only inside an unrelated string
  outside-repo-cd    command legitimately operating outside the repo
  risky-regex-evaded `git -C <other>` — never matched by the v1 pattern (#412)

Write-target controls — the positive control that proves the harness can still
refuse, next to the negative measurement above:
  target-in-main     structured write into the protected main checkout -> block
  target-outside     structured write outside the repository (#373)     -> allow

The controls read this repository's own git index read-only (`git check-ignore`);
nothing is written and no command from the arms is ever executed.
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
    "riskyCommandPatterns": ["\\\\bgit\\\\s+push\\\\b"]
  }
}"""

# The main checkout is this repository, so the write-target controls can consult
# a real git index; the linked worktree is synthetic and never created.
MAIN = REPO
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
    ("bypass-mention", f"git push --force origin main # see {LINKED}"),
    ("bypass-echo", f'echo "{LINKED}" && git push --force origin main'),
    ("outside-repo-cd", "cd /srv/other-checkout && git push --force origin main"),
    ("risky-regex-evaded", "git -C /srv/other-checkout push --force origin main"),
]

CONTROLS = [
    ("target-in-main", str(MAIN / "README.md"), "block"),
    ("target-outside", "/tmp/wrapup-pr-body.md", "allow"),
]

RETIRED_SYMBOLS = ("targets_linked_worktree", "command_decision")


def main() -> int:
    prof = profile_module.load_profile_text(PROFILE_TEXT)
    arms = []
    for name, command in ARMS:
        decision = core.evaluate(prof, FACTS, "write-target", {
            "tool_name": "Bash",
            "tool_input": {"command": command},
        })
        arms.append({"arm": name, "command": command, "action": decision.action})
    controls = []
    for name, target, expected in CONTROLS:
        decision = core.evaluate(prof, FACTS, "write-target", {
            "tool_name": "Write",
            "tool_input": {"file_path": target},
        })
        controls.append({
            "control": name,
            "target": target,
            "action": decision.action,
            "expected": expected,
        })
    retired = [name for name in RETIRED_SYMBOLS if hasattr(core, name)]
    unjudged = all(entry["action"] == "skip" for entry in arms)
    controls_hold = all(entry["action"] == entry["expected"] for entry in controls)
    result = {
        "probe": "R2-command-substring",
        "target": "scripts/worktree-lifecycle/core.py::write_target_decision",
        "arms": arms,
        "controls": controls,
        "retiredSymbolsStillPresent": retired,
        "reproduced": not unjudged,
        "riskyRegexEvaded": not unjudged,
        "green": unjudged and controls_hold and not retired,
    }
    print(json.dumps(result, sort_keys=True))
    return 0 if result["green"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
