#!/usr/bin/env python3
"""Wrapup must reuse the shipped Worktree Lifecycle cleanup assessment."""

import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

REPO = Path(__file__).resolve().parent.parent
WRAPUP = REPO / "scripts/wrapup-land.py"


def load_wrapup():
    spec = importlib.util.spec_from_file_location("wrapup_land_worktree_contract", WRAPUP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorktreeCleanupContract(unittest.TestCase):
    def test_active_profile_delegates_removal_safety_to_shared_assessment(self):
        wrapup = load_wrapup()
        calls = []

        class FakeCore:
            @staticmethod
            def load_profile(path):
                calls.append(("profile", path))
                return {"enabled": True}

            @staticmethod
            def cleanup_assessment(profile, main, target, merge_target=None):
                calls.append(("assessment", main, target, merge_target))
                return SimpleNamespace(reasons=("dirty worktree",), assumptions="reviewed")

        with tempfile.TemporaryDirectory() as tmp:
            main = Path(tmp)
            profile = main / "docs/agents/workflow-capabilities.json"
            profile.parent.mkdir(parents=True)
            profile.write_text('{"worktreeLifecycle":{"enabled":true}}\n')
            with patch.object(wrapup, "load_worktree_cleanup_core", return_value=FakeCore):
                with self.assertRaises(wrapup.Stop) as stopped:
                    wrapup.ensure_worktree_removable(str(main / "wt"), str(main))

        self.assertIn("shared cleanup guard", stopped.exception.reason)
        self.assertEqual(calls[1][-1], "origin/main")


if __name__ == "__main__":
    unittest.main()
