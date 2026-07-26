#!/usr/bin/env python3
"""Wrapup must reuse the shipped Worktree Lifecycle cleanup assessment."""

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

REPO = Path(__file__).resolve().parent.parent
WRAPUP = REPO / "scripts/wrapup-land.py"
SETUP = REPO / "scripts/worktree-lifecycle/setup.py"


def load_wrapup():
    spec = importlib.util.spec_from_file_location("wrapup_land_worktree_contract", WRAPUP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def command(args, cwd):
    return subprocess.run(
        args,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    )


def create_merged_worktree(
    root: Path,
    *,
    setup_steps: list[dict] | None = None,
) -> tuple[Path, Path]:
    remote = root / "remote.git"
    main = root / "main"
    command(["git", "init", "--bare", str(remote)], root)
    command(["git", "init", "-b", "main", str(main)], root)
    command(["git", "config", "user.name", "Test"], main)
    command(["git", "config", "user.email", "test@example.invalid"], main)
    (main / ".gitignore").write_text(
        ".worktrees/\ndist-kit/\n__pycache__/\n.claude/logs/\nconsumer/\n",
        encoding="utf-8",
    )
    profile = main / "docs/agents/workflow-capabilities.json"
    profile.parent.mkdir(parents=True)
    profile.write_text(json.dumps({
        "worktreeLifecycle": {
            "enabled": True,
            "worktreeRoot": ".worktrees",
            "branchTemplate": "{type}/{issue}-{slug}",
            "pathTemplate": "{issue}-{slug}",
            "mainBranches": ["main"],
            "protectedBranches": ["main"],
            "scratchPatterns": [],
            "setupSteps": setup_steps or [],
        },
        "wrapup": {
            "landingGeneratedArtifactPatterns": [
                "dist-kit/**",
                "**/__pycache__/**",
                ".claude/logs/**",
            ],
        },
    }), encoding="utf-8")
    command(["git", "add", "."], main)
    command(["git", "commit", "-m", "seed"], main)
    command(["git", "remote", "add", "origin", str(remote)], main)
    command(["git", "push", "-u", "origin", "main"], main)
    command([
        os.sys.executable,
        str(SETUP),
        "--profile",
        str(profile),
        "--base",
        "origin/main",
        "268",
        "cleanup",
        "fix",
    ], main)
    worktree = main / ".worktrees/268-cleanup"
    command(["git", "rev-parse", "--verify", "HEAD"], worktree)
    (worktree / "change.txt").write_text("landed\n", encoding="utf-8")
    command(["git", "add", "change.txt"], worktree)
    command(["git", "commit", "-m", "change"], worktree)
    command(["git", "merge", "--ff-only", "fix/268-cleanup"], main)
    command(["git", "push", "origin", "main"], main)
    return main, worktree


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

    def test_release_build_subprocess_after_creation_baseline_is_cleaned_by_land(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            main, worktree = create_merged_worktree(root)
            generator = """
from pathlib import Path
for relative, content in {
    "dist-kit/package.tgz": "package",
    "scripts/__pycache__/guard.pyc": "cache",
    ".claude/logs/wrapup.log": "log",
}.items():
    path = Path(relative)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
"""
            command([os.sys.executable, "-c", generator], worktree)

            real_run = wrapup.run

            def landing_run(args, cwd=None, check=False):
                if args[:3] == ["gh", "pr", "view"]:
                    fields = args[-1]
                    payload = (
                        {"number": 42, "state": "MERGED", "body": "**Retro:** n/a"}
                        if "number,state,body" in fields
                        else {"state": "MERGED"}
                    )
                    return subprocess.CompletedProcess(args, 0, json.dumps(payload), "")
                if args[:3] == ["gh", "issue", "view"]:
                    return subprocess.CompletedProcess(
                        args, 0, json.dumps({"state": "CLOSED"}), ""
                    )
                if args[:3] == ["gh", "pr", "list"]:
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args and args[0] == os.sys.executable:
                    return subprocess.CompletedProcess(args, 0, "", "")
                return real_run(args, cwd=cwd, check=check)

            args = SimpleNamespace(
                branch="fix/268-cleanup",
                body_file=None,
                title=None,
                anchor=None,
                skip_malformed_drift=False,
            )
            previous = Path.cwd()
            try:
                os.chdir(main)
                with (
                    patch.object(wrapup, "run", side_effect=landing_run),
                    patch.object(wrapup, "wait_for_merge_gate", return_value=True),
                    patch.object(wrapup, "kill_worktree_processes", return_value=[]),
                ):
                    first = wrapup.cmd_land(args)
                    second = wrapup.cmd_land(args)
            finally:
                os.chdir(previous)

            self.assertEqual(
                first["cleanup_guard"]["landing_generated_files"],
                [
                    ".claude/logs/wrapup.log",
                    "dist-kit/package.tgz",
                    "scripts/__pycache__/guard.pyc",
                ],
            )
            self.assertEqual(first["worktree_removed"], str(worktree))
            self.assertFalse(worktree.exists())
            self.assertTrue(second["merged"])

    def test_profile_generated_path_present_in_creation_baseline_is_not_scratch(self):
        wrapup = load_wrapup()
        setup_step = {
            "kind": "command",
            "command": [
                os.sys.executable,
                "-c",
                (
                    "from pathlib import Path; "
                    "p=Path('dist-kit/setup-owned.txt'); "
                    "p.parent.mkdir(parents=True); p.write_text('initial')"
                ),
            ],
        }
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(
                Path(tmp),
                setup_steps=[setup_step],
            )

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_verified_scratch_files(
                    str(worktree),
                    str(main),
                )

            self.assertIn("dist-kit/setup-owned.txt", stopped.exception.reason)

    def test_missing_creation_baseline_fails_safe(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            core = wrapup.load_worktree_cleanup_core()
            core.artifact_baseline_path(worktree).unlink()

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_verified_scratch_files(
                    str(worktree),
                    str(main),
                )

            self.assertIn("artifact provenance baseline", stopped.exception.reason)

    def test_incoherent_creation_baseline_fails_safe(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            core = wrapup.load_worktree_cleanup_core()
            baseline_path = core.artifact_baseline_path(worktree)
            baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
            baseline["branch"] = "fix/999-foreign"
            baseline_path.write_text(json.dumps(baseline), encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_verified_scratch_files(
                    str(worktree),
                    str(main),
                )

            self.assertIn("artifact provenance baseline", stopped.exception.reason)

    def test_arbitrary_ignored_file_stops_exact_landing_cleanup(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("package", encoding="utf-8")
            consumer = worktree / "consumer/private.cache"
            consumer.parent.mkdir(parents=True)
            consumer.write_text("mine", encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.ensure_worktree_removable(
                    str(worktree),
                    str(main),
                    verified_scratch_files=("dist-kit/package.tgz",),
                )

            self.assertIn("consumer/private.cache", stopped.exception.detail)
            self.assertTrue(generated.exists())
            self.assertTrue(consumer.exists())

    def test_symlink_in_generated_evidence_stops_before_foreign_target_is_touched(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            main, worktree = create_merged_worktree(root)
            foreign = root / "foreign.txt"
            foreign.write_text("keep", encoding="utf-8")
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.symlink_to(foreign)
            assessment = wrapup.ensure_worktree_removable(
                str(worktree),
                str(main),
                verified_scratch_files=("dist-kit/package.tgz",),
            )

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.remove_verified_worktree_scratch(
                    str(worktree),
                    str(main),
                    assessment,
                    verified_scratch_files=("dist-kit/package.tgz",),
                )

            self.assertIn("not a regular file", stopped.exception.reason)
            self.assertEqual(foreign.read_text(encoding="utf-8"), "keep")
            self.assertTrue(generated.is_symlink())

    def test_late_generated_pattern_write_is_not_added_to_verified_evidence(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("package", encoding="utf-8")
            assessment = wrapup.ensure_worktree_removable(
                str(worktree),
                str(main),
                verified_scratch_files=("dist-kit/package.tgz",),
            )
            late = worktree / ".claude/logs/late.log"
            late.parent.mkdir(parents=True)
            late.write_text("late", encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.remove_verified_worktree_scratch(
                    str(worktree),
                    str(main),
                    assessment,
                    verified_scratch_files=("dist-kit/package.tgz",),
                )

            self.assertIn(".claude/logs/late.log", stopped.exception.reason)
            self.assertTrue(generated.exists())
            self.assertTrue(late.exists())


if __name__ == "__main__":
    unittest.main()
