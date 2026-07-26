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
    result = subprocess.run(
        args,
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"{' '.join(args)} failed ({result.returncode}): "
            f"{(result.stderr or result.stdout).strip()}"
        )
    return result


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


def create_real_kit_merged_worktree(root: Path) -> tuple[Path, Path]:
    main = root / "main"
    remote = root / "remote.git"
    command(["git", "clone", "--no-local", str(REPO), str(main)], root)
    command(["git", "config", "user.name", "Test"], main)
    command(["git", "config", "user.email", "test@example.invalid"], main)
    command(["git", "checkout", "-B", "main"], main)
    command(["git", "remote", "remove", "origin"], main)
    command(["git", "init", "--bare", str(remote)], root)
    command(["git", "remote", "add", "origin", str(remote)], main)

    ignore = main / ".gitignore"
    ignored = ignore.read_text(encoding="utf-8")
    required_ignores = [
        ".worktrees/",
        "dist-kit/",
        "**/__pycache__/",
        ".claude/logs/",
    ]
    missing = [pattern for pattern in required_ignores if pattern not in ignored.splitlines()]
    if missing:
        ignore.write_text(
            ignored.rstrip("\n") + "\n" + "\n".join(missing) + "\n",
            encoding="utf-8",
        )

    profile_path = main / "docs/agents/workflow-capabilities.json"
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    lifecycle = profile.setdefault("worktreeLifecycle", {})
    lifecycle.update({
        "enabled": True,
        "worktreeRoot": ".worktrees",
        "branchTemplate": "{type}/{issue}-{slug}",
        "pathTemplate": "{issue}-{slug}",
        "mainBranches": ["main"],
        "protectedBranches": ["main"],
        "scratchPatterns": [],
        "setupSteps": [],
    })
    profile["wrapup"] = {
        "landingGeneratedArtifactPatterns": [
            "dist-kit/**",
            "**/__pycache__/**",
            ".claude/logs/**",
        ],
    }
    profile_path.write_text(
        json.dumps(profile, indent=2) + "\n",
        encoding="utf-8",
    )
    command(["git", "add", ".gitignore", str(profile_path.relative_to(main))], main)
    command(["git", "commit", "-m", "configure lifecycle fixture"], main)
    command(["git", "push", "-u", "origin", "main"], main)

    command([
        os.sys.executable,
        str(SETUP),
        "--profile",
        str(profile_path),
        "--base",
        "origin/main",
        "268",
        "real-generator",
        "fix",
    ], main)
    worktree = main / ".worktrees/268-real-generator"
    (worktree / "change.txt").write_text("landed\n", encoding="utf-8")
    command(["git", "add", "change.txt"], worktree)
    command(["git", "commit", "-m", "change"], worktree)
    command(["git", "merge", "--ff-only", "fix/268-real-generator"], main)
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

    def test_real_build_and_python_check_after_baseline_are_cleaned_by_land(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            main, worktree = create_real_kit_merged_worktree(root)
            # The first landing attempt journals its start before the real
            # pre-push generators run. A resumed already-MERGED land must
            # reuse that attempt instead of treating its outputs as user files.
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            command(["npm", "run", "kit:build"], worktree)
            command([
                os.sys.executable,
                "-m",
                "py_compile",
                "scripts/worktree-lifecycle/core.py",
            ], worktree)
            wrapup.freeze_landing_artifact_evidence(
                str(worktree),
                str(main),
                push_succeeded=True,
            )
            self.assertTrue((worktree / "dist-kit/package.json").is_file())
            self.assertTrue(
                any(
                    (worktree / "scripts/worktree-lifecycle/__pycache__").glob(
                        "core.*.pyc"
                    )
                )
            )

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
                branch="fix/268-real-generator",
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

            generated = first["cleanup_guard"]["landing_generated_files"]
            self.assertIn("dist-kit/package.json", generated)
            self.assertTrue(
                any(
                    path.startswith(
                        "scripts/worktree-lifecycle/__pycache__/core."
                    )
                    and path.endswith(".pyc")
                    for path in generated
                ),
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

            self.assertIn("scratch path", stopped.exception.reason)
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

    def test_same_path_generated_replacement_is_preserved_by_frozen_evidence(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("generator-owned", encoding="utf-8")
            evidence = wrapup.landing_verified_scratch_evidence(
                str(worktree),
                str(main),
                landing_start_files=(),
            )
            assessment = wrapup.ensure_worktree_removable(
                str(worktree),
                str(main),
                verified_scratch_files=("dist-kit/package.tgz",),
            )
            generated.unlink()
            generated.write_text("user replacement", encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.remove_verified_worktree_scratch(
                    str(worktree),
                    str(main),
                    assessment,
                    verified_scratch_evidence=evidence,
                )

            self.assertIn("identity changed", stopped.exception.reason)
            self.assertEqual(generated.read_text(encoding="utf-8"), "user replacement")

    def test_landing_start_generated_file_is_never_reclassified_as_build_output(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            user_file = worktree / "dist-kit/user-note.txt"
            user_file.parent.mkdir(parents=True)
            user_file.write_text("keep", encoding="utf-8")
            landing_start = wrapup.landing_start_artifact_inventory(
                str(worktree),
                str(main),
            )
            # A generator writing the same path cannot turn pre-landing user
            # ownership into landing ownership.
            user_file.write_text("overwritten during build", encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_verified_scratch_evidence(
                    str(worktree),
                    str(main),
                    expected_baseline_digest=landing_start["baselineDigest"],
                    landing_start_files=tuple(landing_start["generatedFiles"]),
                )

            self.assertIn("landing-start generated paths", stopped.exception.reason)
            self.assertTrue(user_file.exists())

    def test_frozen_landing_output_does_not_claim_a_later_private_path(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("generator", encoding="utf-8")
            wrapup.freeze_landing_artifact_evidence(
                str(worktree), str(main), push_succeeded=True
            )
            private = worktree / ".claude/logs/private.log"
            private.parent.mkdir(parents=True)
            private.write_text("keep", encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.freeze_landing_artifact_evidence(
                    str(worktree), str(main), push_succeeded=True
                )

            self.assertIn("evidence changed", stopped.exception.reason)
            self.assertTrue(generated.exists())
            self.assertTrue(private.exists())

    def test_failed_push_retry_validates_replacement_before_invoking_push(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("generator", encoding="utf-8")
            wrapup.freeze_landing_artifact_evidence(
                str(worktree), str(main), push_succeeded=False
            )
            generated.unlink()
            generated.write_text("user replacement", encoding="utf-8")
            pushes = []
            real_git = wrapup.git

            def observed_git(args, **kwargs):
                if args and args[0] == "push":
                    pushes.append(args)
                return real_git(args, **kwargs)

            args = SimpleNamespace(
                branch="fix/268-cleanup",
                body_file=None,
                title=None,
                anchor=None,
                skip_malformed_drift=False,
                abandon_unfinished_attempt=False,
            )
            previous = Path.cwd()
            try:
                os.chdir(main)
                with (
                    patch.object(wrapup, "git", side_effect=observed_git),
                    self.assertRaises(wrapup.Stop) as stopped,
                ):
                    wrapup.cmd_land(args)
            finally:
                os.chdir(previous)

            self.assertIn("evidence changed", stopped.exception.reason)
            self.assertEqual(pushes, [])
            self.assertEqual(
                generated.read_text(encoding="utf-8"), "user replacement"
            )

    def test_first_attempt_protects_preexisting_generated_path_before_push(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            user_file = worktree / "dist-kit/package.json"
            user_file.parent.mkdir(parents=True)
            user_file.write_text("user bytes", encoding="utf-8")
            pushes = []
            real_git = wrapup.git

            def observed_git(args, **kwargs):
                if args and args[0] == "push":
                    pushes.append(args)
                return real_git(args, **kwargs)

            args = SimpleNamespace(
                branch="fix/268-cleanup",
                body_file=None,
                title=None,
                anchor=None,
                skip_malformed_drift=False,
                abandon_unfinished_attempt=False,
            )
            previous = Path.cwd()
            try:
                os.chdir(main)
                with (
                    patch.object(wrapup, "git", side_effect=observed_git),
                    self.assertRaises(wrapup.Stop) as stopped,
                ):
                    wrapup.cmd_land(args)
            finally:
                os.chdir(previous)

            self.assertIn("consumer-owned", stopped.exception.reason)
            self.assertEqual(pushes, [])
            self.assertEqual(user_file.read_text(encoding="utf-8"), "user bytes")

    def test_unfinished_attempt_can_be_archived_without_claiming_ambiguous_files(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            ambiguous = worktree / "dist-kit/ambiguous.tgz"
            ambiguous.parent.mkdir(parents=True)
            ambiguous.write_text("unknown owner", encoding="utf-8")

            archive = Path(wrapup.abandon_unfinished_landing_attempt(
                str(worktree), str(main)
            ))

            self.assertTrue(archive.is_file())
            self.assertEqual(ambiguous.read_text(encoding="utf-8"), "unknown owner")
            next_attempt = wrapup.landing_start_artifact_inventory(
                str(worktree), str(main)
            )
            self.assertEqual(
                next_attempt["generatedFiles"], ["dist-kit/ambiguous.tgz"]
            )


if __name__ == "__main__":
    unittest.main()
