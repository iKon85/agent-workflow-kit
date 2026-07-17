#!/usr/bin/env python3
"""The shipped pre-commit template must sanitize git's hook environment.

Git exports GIT_DIR/GIT_INDEX_FILE to hooks; a consumer gate that runs a test
suite whose child tests call git in their own temp repos would otherwise
redirect those calls onto the host repo's index (PR #121's incident)."""

from __future__ import annotations

import unittest
from pathlib import Path

TEMPLATE = (
    Path(__file__).resolve().parent.parent
    / ".claude/skills/setup-pre-commit/scripts/pre-commit.template.sh"
)


class PreCommitTemplateSanitizesGitEnv(unittest.TestCase):
    def test_template_unsets_git_env_before_gate(self):
        text = TEMPLATE.read_text(encoding="utf-8")
        unset_pos = text.find("unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX")
        gate_pos = text.find(">>> your gate commands here <<<")
        self.assertGreater(unset_pos, -1, "template must unset git's exported hook env")
        self.assertGreater(gate_pos, -1, "template must keep the gate marker")
        self.assertLess(unset_pos, gate_pos, "sanitize must happen before the gate runs")


if __name__ == "__main__":
    unittest.main()
