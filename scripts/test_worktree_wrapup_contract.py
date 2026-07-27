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
    scratch_patterns: list[str] | None = None,
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
            "scratchPatterns": scratch_patterns or [],
            "setupSteps": setup_steps or [],
        },
        "wrapup": {
            "landingGeneratedArtifactPatterns": [
                "dist-kit/**",
                "**/__pycache__/**",
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
        "PLAN.md",
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
        "scratchPatterns": ["PLAN.md", ".claude/logs/**"],
        "setupSteps": [],
    })
    profile["wrapup"] = {
        "landingGeneratedArtifactPatterns": [
            "dist-kit/**",
            "**/__pycache__/**",
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


def merged_landing_runner(wrapup):
    """Stub the external gh/board calls of an already-MERGED land run."""
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

    return landing_run


def land_args(branch="fix/268-cleanup", **overrides):
    values = {
        "branch": branch,
        "body_file": None,
        "title": None,
        "anchor": None,
        "skip_malformed_drift": False,
        "abandon_unfinished_attempt": False,
        "recover_canonical_cleanup": False,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def run_land(wrapup, main: Path, args) -> dict:
    """Run `land` from the main tree against an already-merged PR."""
    previous = Path.cwd()
    try:
        os.chdir(main)
        with (
            patch.object(wrapup, "run", side_effect=merged_landing_runner(wrapup)),
            patch.object(wrapup, "wait_for_merge_gate", return_value=True),
            patch.object(wrapup, "kill_worktree_processes", return_value=[]),
        ):
            return wrapup.cmd_land(args)
    finally:
        os.chdir(previous)


def rewrite_landing_attempt(core, worktree: Path, mutate) -> Path:
    """Rewrite the attempt journal with a coherent digest for a forged payload."""
    path = core.artifact_baseline_path(worktree).with_name(core.LANDING_ATTEMPT_FILE)
    document = json.loads(path.read_text(encoding="utf-8"))
    payload = {key: value for key, value in document.items() if key != "sha256"}
    mutate(payload)
    path.write_text(
        json.dumps({**payload, "sha256": core._baseline_digest(payload)}),
        encoding="utf-8",
    )
    return path


def downgrade_landing_attempt_to_v1(core, worktree: Path) -> Path:
    """Produce the coherent v1 journal shape a pre-upgrade landing left behind."""
    def mutate(payload):
        payload.pop("policyDigest", None)
        payload["contractVersion"] = 1

    return rewrite_landing_attempt(core, worktree, mutate)


class WorktreeCleanupContract(unittest.TestCase):
    def test_declared_close_targets_is_pr_body_authority(self):
        mod = load_wrapup()
        self.assertEqual(mod.declared_close_targets("Part of #320"), [])
        self.assertEqual(mod.declared_close_targets("closes #341\ncloses #12"),
                         ["12", "341"])
        self.assertEqual(mod.declared_close_targets("`closes #341`"), [])

    def test_profile_scratch_and_generated_evidence_share_safe_removal_contract(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(
                Path(tmp), scratch_patterns=["PLAN.md"]
            )
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            (worktree / "PLAN.md").write_text("plan\n", encoding="utf-8")
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("generated\n", encoding="utf-8")
            evidence = wrapup.landing_verified_scratch_evidence(
                str(worktree), str(main)
            )
            assessment = wrapup.ensure_worktree_removable(
                str(worktree),
                str(main),
                verified_scratch_files=tuple(item["path"] for item in evidence),
                verified_scratch_evidence=evidence,
            )

            final = wrapup.remove_verified_worktree_scratch(
                str(worktree),
                str(main),
                assessment,
                verified_scratch_evidence=evidence,
            )

            self.assertFalse(final.reasons)
            self.assertFalse((worktree / "PLAN.md").exists())
            self.assertFalse(generated.exists())

    def test_profile_scratch_same_path_replacement_is_preserved(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(
                Path(tmp), scratch_patterns=["PLAN.md"]
            )
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            plan = worktree / "PLAN.md"
            plan.write_text("assessed\n", encoding="utf-8")
            assessment = wrapup.ensure_worktree_removable(
                str(worktree), str(main)
            )
            plan.unlink()
            plan.write_text("replacement\n", encoding="utf-8")
            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.remove_verified_worktree_scratch(
                    str(worktree), str(main), assessment
                )
            self.assertIn("inventory no longer matches preview", stopped.exception.reason)
            self.assertEqual(plan.read_text(encoding="utf-8"), "replacement\n")

    def test_missing_generator_identity_is_not_downgraded_to_profile_scratch(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("generated\n", encoding="utf-8")
            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.ensure_worktree_removable(
                    str(worktree),
                    str(main),
                    verified_scratch_files=("dist-kit/package.tgz",),
                    verified_scratch_evidence=(),
                )

            self.assertIn("evidence", stopped.exception.detail)
            self.assertTrue(generated.exists())

    def test_generator_pattern_overlap_still_requires_exact_evidence(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(
                Path(tmp), scratch_patterns=["dist-kit/**"]
            )
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("generated\n", encoding="utf-8")
            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.ensure_worktree_removable(
                    str(worktree), str(main), verified_scratch_files=()
                )
            self.assertIn(
                "landing-generated scratch evidence is missing",
                stopped.exception.detail,
            )
            self.assertTrue(generated.exists())

    def test_legacy_worktree_gets_conservative_baseline_without_claiming_existing_files(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            core = wrapup.load_worktree_cleanup_core()
            core.artifact_baseline_path(worktree).unlink()
            existing = worktree / "dist-kit/existing.tgz"
            existing.parent.mkdir(parents=True)
            existing.write_text("consumer\n", encoding="utf-8")
            preserved = worktree / "consumer/keep.txt"
            preserved.parent.mkdir(parents=True)
            preserved.write_text("preserve\n", encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_start_artifact_inventory(
                    str(worktree), str(main)
                )

            self.assertFalse(core.artifact_baseline_path(worktree).exists())
            self.assertIn("consumer-owned", stopped.exception.reason)
            self.assertTrue(existing.exists())
            self.assertTrue(preserved.exists())

            existing.unlink()
            attempt = wrapup.landing_start_artifact_inventory(
                str(worktree), str(main)
            )
            baseline = core.load_artifact_baseline(worktree)
            self.assertNotIn("dist-kit/existing.tgz", baseline.initial_ignored_files)
            self.assertIn("consumer/keep.txt", baseline.initial_ignored_files)
            existing.write_text("landing-generated\n", encoding="utf-8")
            evidence = wrapup.landing_verified_scratch_evidence(
                str(worktree),
                str(main),
                expected_baseline_digest=attempt["baselineDigest"],
                landing_start_files=tuple(attempt["generatedFiles"]),
            )
            self.assertEqual(
                [item["path"] for item in evidence],
                ["dist-kit/existing.tgz"],
            )

    def test_preexisting_generated_blocker_does_not_poison_next_attempt(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            blocker = worktree / "dist-kit/preexisting.tgz"
            blocker.parent.mkdir(parents=True)
            blocker.write_text("consumer\n", encoding="utf-8")
            core = wrapup.load_worktree_cleanup_core()
            attempt_path = core.artifact_baseline_path(worktree).with_name(
                core.LANDING_ATTEMPT_FILE
            )

            with self.assertRaises(wrapup.Stop):
                wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            self.assertFalse(attempt_path.exists())
            blocker.unlink()
            attempt = wrapup.landing_start_artifact_inventory(
                str(worktree), str(main)
            )
            self.assertTrue(attempt["newAttempt"])

    def test_candidate_policy_blocks_generated_path_before_canonical_bootstrap(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            core = wrapup.load_worktree_cleanup_core()
            baseline_path = core.artifact_baseline_path(worktree)
            baseline_path.unlink()
            canonical_profile = main / "docs/agents/workflow-capabilities.json"
            canonical = json.loads(canonical_profile.read_text(encoding="utf-8"))
            del canonical["wrapup"]
            canonical_profile.write_text(json.dumps(canonical), encoding="utf-8")
            blocker = worktree / "dist-kit/bootstrap.tgz"
            blocker.parent.mkdir(parents=True)
            blocker.write_text("preserve\n", encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_start_artifact_inventory(
                    str(worktree), str(main)
                )

            self.assertIn(
                "landing-start generated paths are consumer-owned",
                stopped.exception.reason,
            )
            self.assertFalse(baseline_path.exists())
            self.assertFalse(
                baseline_path.with_name(core.LANDING_ATTEMPT_FILE).exists()
            )

    def test_candidate_policy_cannot_widen_post_merge_deletion_authority(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            candidate_path = worktree / "docs/agents/workflow-capabilities.json"
            candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
            candidate["wrapup"]["landingGeneratedArtifactPatterns"].append("**")
            candidate_path.write_text(json.dumps(candidate), encoding="utf-8")
            command(["git", "add", "docs/agents/workflow-capabilities.json"], worktree)
            command(["git", "commit", "-m", "widen candidate policy"], worktree)
            core = wrapup.load_worktree_cleanup_core()
            attempt_path = core.artifact_baseline_path(worktree).with_name(
                core.LANDING_ATTEMPT_FILE
            )

            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.ensure_worktree_removable(str(worktree), str(main))

            self.assertIn(
                "worktree cleanup policy differs from merged canonical origin/main",
                stopped.exception.reason,
            )
            self.assertTrue(attempt_path.exists())

    def test_policy_drift_during_attempt_cannot_claim_preexisting_consumer_file(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            victim = worktree / "consumer/victim.txt"
            victim.parent.mkdir(parents=True)
            victim.write_text("preserve\n", encoding="utf-8")
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            candidate_path = worktree / "docs/agents/workflow-capabilities.json"
            candidate = json.loads(candidate_path.read_text(encoding="utf-8"))
            candidate["wrapup"]["landingGeneratedArtifactPatterns"].append(
                "consumer/**"
            )
            candidate_path.write_text(json.dumps(candidate), encoding="utf-8")
            command(["git", "add", "docs/agents/workflow-capabilities.json"], worktree)
            command(["git", "commit", "-m", "widen active attempt policy"], worktree)

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.freeze_landing_artifact_evidence(
                    str(worktree), str(main), push_succeeded=True
                )

            self.assertIn(
                "landing cleanup policy changed after attempt start",
                stopped.exception.reason,
            )
            self.assertEqual(victim.read_text(encoding="utf-8"), "preserve\n")

    def test_canonical_cleanup_rejects_generator_evidence_outside_policy(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            victim = worktree / "consumer/victim.txt"
            victim.parent.mkdir(parents=True)
            victim.write_text("preserve\n", encoding="utf-8")
            core = wrapup.load_worktree_cleanup_core()
            baseline = core.load_artifact_baseline(worktree)
            with core.verified_worktree_root(
                worktree, baseline.root_device, baseline.root_inode
            ) as descriptor:
                evidence = (
                    core.contained_regular_identity(
                        descriptor, "consumer/victim.txt"
                    ),
                )

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.ensure_worktree_removable(
                    str(worktree),
                    str(main),
                    verified_scratch_evidence=evidence,
                )

            self.assertIn(
                "generator evidence is outside canonical landing policy",
                stopped.exception.detail,
            )
            self.assertEqual(victim.read_text(encoding="utf-8"), "preserve\n")

    def test_missing_local_main_profile_cannot_disable_canonical_guard(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            wrapup.freeze_landing_artifact_evidence(
                str(worktree), str(main), push_succeeded=True
            )
            (main / "docs/agents/workflow-capabilities.json").unlink()
            victim = worktree / "consumer/ignored.txt"
            victim.parent.mkdir(parents=True)
            victim.write_text("preserve\n", encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.ensure_worktree_removable(str(worktree), str(main))

            self.assertIn(
                "dirty worktree: untracked non-scratch: consumer/ignored.txt",
                stopped.exception.detail,
            )
            self.assertEqual(victim.read_text(encoding="utf-8"), "preserve\n")
            self.assertTrue(worktree.is_dir())

    def test_explicit_empty_landing_policy_is_distinct_from_missing(self):
        wrapup = load_wrapup()
        core = wrapup.load_worktree_cleanup_core()
        with tempfile.TemporaryDirectory() as tmp:
            profile_path = Path(tmp) / "workflow-capabilities.json"
            document = {
                "worktreeLifecycle": {"enabled": True},
                "wrapup": {"landingGeneratedArtifactPatterns": []},
            }
            profile_path.write_text(json.dumps(document), encoding="utf-8")
            configured = core.load_profile(profile_path)
            del document["wrapup"]
            profile_path.write_text(json.dumps(document), encoding="utf-8")
            missing = core.load_profile(profile_path)

            self.assertTrue(
                configured.landing_generated_artifact_policy_configured
            )
            self.assertEqual(configured.landing_generated_artifact_patterns, ())
            self.assertFalse(missing.landing_generated_artifact_policy_configured)

    def test_abandon_archives_drifted_frozen_attempt_without_touching_files(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("one\n", encoding="utf-8")
            wrapup.freeze_landing_artifact_evidence(
                str(worktree), str(main), push_succeeded=True
            )
            generated.write_text("two\n", encoding="utf-8")

            args = SimpleNamespace(
                branch="fix/268-cleanup",
                body_file=None,
                title=None,
                anchor=None,
                skip_malformed_drift=False,
                abandon_unfinished_attempt=True,
            )
            previous = Path.cwd()
            try:
                os.chdir(main)
                result = wrapup.cmd_land(args)
            finally:
                os.chdir(previous)
            archive = Path(result["landing_attempt_abandoned"])

            self.assertTrue(archive.is_file())
            self.assertEqual(generated.read_text(encoding="utf-8"), "two\n")
            with self.assertRaises(wrapup.Stop):
                wrapup.landing_start_artifact_inventory(str(worktree), str(main))

    def test_cli_abandon_archives_attempt_even_when_baseline_is_missing(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            generated = worktree / "dist-kit/ambiguous.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("keep\n", encoding="utf-8")
            core = wrapup.load_worktree_cleanup_core()
            core.artifact_baseline_path(worktree).unlink()
            args = SimpleNamespace(
                branch="fix/268-cleanup",
                body_file=None,
                title=None,
                anchor=None,
                skip_malformed_drift=False,
                abandon_unfinished_attempt=True,
            )
            previous = Path.cwd()
            try:
                os.chdir(main)
                result = wrapup.cmd_land(args)
            finally:
                os.chdir(previous)
            self.assertTrue(Path(result["landing_attempt_abandoned"]).is_file())
            self.assertEqual(generated.read_text(encoding="utf-8"), "keep\n")

    def test_profile_globs_match_root_and_nested_without_star_crossing_slash(self):
        wrapup = load_wrapup()
        core = wrapup.load_worktree_cleanup_core()
        self.assertTrue(core.path_glob_matches("__pycache__/a.pyc", "**/__pycache__/**"))
        self.assertTrue(core.path_glob_matches("src/__pycache__/a.pyc", "**/__pycache__/**"))
        self.assertTrue(core.path_glob_matches("dist-kit/a", "dist-kit/**"))
        self.assertTrue(core.path_glob_matches("dist-kit/a/b", "dist-kit/**"))
        self.assertFalse(core.path_glob_matches("dist-kit/a/b", "dist-kit/*"))
        self.assertTrue(core.path_glob_matches("cache/7.tmp", "cache/[0-9].tmp"))
        self.assertFalse(core.path_glob_matches("cache/x.tmp", "cache/[0-9].tmp"))

    def test_active_profile_delegates_removal_safety_to_shared_assessment(self):
        wrapup = load_wrapup()
        calls = []

        class FakeCore:
            LifecycleError = RuntimeError

            @staticmethod
            def load_profile(path):
                calls.append(("profile", path))
                return SimpleNamespace(
                    landing_generated_artifact_policy_configured=True,
                    landing_generated_artifact_patterns=(),
                    scratch_patterns=(),
                )

            @staticmethod
            def cleanup_assessment(profile, main, target, merge_target=None):
                calls.append(("assessment", main, target, merge_target))
                return SimpleNamespace(reasons=("dirty worktree",), assumptions="reviewed")

        with tempfile.TemporaryDirectory() as tmp:
            main = Path(tmp)
            profile = main / "docs/agents/workflow-capabilities.json"
            profile.parent.mkdir(parents=True)
            profile.write_text('{"worktreeLifecycle":{"enabled":true}}\n')
            with (
                patch.object(wrapup, "load_worktree_cleanup_core", return_value=FakeCore),
                patch.object(
                    wrapup,
                    "load_canonical_landing_profile",
                    return_value=SimpleNamespace(),
                ),
            ):
                with self.assertRaises(wrapup.Stop) as stopped:
                    wrapup.ensure_worktree_removable(str(main / "wt"), str(main))

        self.assertIn("shared cleanup guard", stopped.exception.reason)
        self.assertEqual(calls[-1][-1], "origin/main")

    def test_real_build_and_python_check_after_baseline_are_cleaned_by_land(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            main, worktree = create_real_kit_merged_worktree(root)
            appendable = worktree / ".claude/logs/session.log"
            appendable.parent.mkdir(parents=True, exist_ok=True)
            appendable.write_text("appendable\n", encoding="utf-8")
            (worktree / "PLAN.md").write_text("plan\n", encoding="utf-8")
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

    def test_append_after_profile_log_assessment_is_preserved_and_stops(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(
                Path(tmp), scratch_patterns=[".claude/logs/**"]
            )
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            log = worktree / ".claude/logs/session.log"
            log.parent.mkdir(parents=True)
            log.write_text("assessed\n", encoding="utf-8")
            assessment = wrapup.ensure_worktree_removable(
                str(worktree), str(main)
            )
            with log.open("a", encoding="utf-8") as handle:
                handle.write("late\n")
            with self.assertRaises(wrapup.Stop):
                wrapup.remove_verified_worktree_scratch(
                    str(worktree), str(main), assessment
                )
            self.assertEqual(log.read_text(encoding="utf-8"), "assessed\nlate\n")

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
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
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
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            foreign = root / "foreign.txt"
            foreign.write_text("keep", encoding="utf-8")
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.symlink_to(foreign)
            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.ensure_worktree_removable(
                    str(worktree),
                    str(main),
                    verified_scratch_files=("dist-kit/package.tgz",),
                )

            self.assertIn("evidence is missing", stopped.exception.detail)
            self.assertEqual(foreign.read_text(encoding="utf-8"), "keep")
            self.assertTrue(generated.is_symlink())

    def test_late_generated_pattern_write_is_not_added_to_verified_evidence(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("package", encoding="utf-8")
            evidence = wrapup.landing_verified_scratch_evidence(
                str(worktree),
                str(main),
                landing_start_files=(),
            )
            assessment = wrapup.ensure_worktree_removable(
                str(worktree),
                str(main),
                verified_scratch_evidence=evidence,
            )
            late = worktree / "dist-kit/late.tgz"
            late.parent.mkdir(parents=True, exist_ok=True)
            late.write_text("late", encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.remove_verified_worktree_scratch(
                    str(worktree),
                    str(main),
                    assessment,
                    verified_scratch_evidence=evidence,
                )

            self.assertIn("dist-kit/late.tgz", stopped.exception.reason)
            self.assertTrue(generated.exists())
            self.assertTrue(late.exists())

    def test_same_path_generated_replacement_is_preserved_by_frozen_evidence(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
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
                verified_scratch_evidence=evidence,
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

    def test_landing_start_generated_file_is_rejected_before_attempt_is_written(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            user_file = worktree / "dist-kit/user-note.txt"
            user_file.parent.mkdir(parents=True)
            user_file.write_text("keep", encoding="utf-8")
            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_start_artifact_inventory(
                    str(worktree), str(main)
                )

            self.assertIn("landing-start generated paths", stopped.exception.reason)
            self.assertTrue(user_file.exists())
            core = wrapup.load_worktree_cleanup_core()
            self.assertFalse(
                core.artifact_baseline_path(worktree)
                .with_name(core.LANDING_ATTEMPT_FILE)
                .exists()
            )

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
            private = worktree / "dist-kit/private.log"
            private.parent.mkdir(parents=True, exist_ok=True)
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
            core = wrapup.load_worktree_cleanup_core()
            baseline_path = core.artifact_baseline_path(worktree)
            attempt_path = baseline_path.with_name(core.LANDING_ATTEMPT_FILE)
            attempt = json.loads(attempt_path.read_text(encoding="utf-8"))
            payload = {
                key: value
                for key, value in attempt.items()
                if key not in {"policyDigest", "sha256"}
            }
            payload["contractVersion"] = 1
            attempt_path.write_text(
                json.dumps({**payload, "sha256": core._baseline_digest(payload)}),
                encoding="utf-8",
            )
            baseline_path.unlink()
            ambiguous = worktree / "dist-kit/ambiguous.tgz"
            ambiguous.parent.mkdir(parents=True)
            ambiguous.write_text("unknown owner", encoding="utf-8")
            (main / "docs/agents/workflow-capabilities.json").unlink()

            archive = Path(wrapup.abandon_unfinished_landing_attempt(
                str(worktree), str(main)
            ))

            self.assertTrue(archive.is_file())
            self.assertEqual(ambiguous.read_text(encoding="utf-8"), "unknown owner")
            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_start_artifact_inventory(
                    str(worktree), str(main)
                )
            self.assertIn("consumer-owned", stopped.exception.reason)


class LandingAttemptJournalContract(unittest.TestCase):
    """#274 — one nofollow-safe journal classification and no dead v1 surface."""

    def test_symlinked_attempt_journal_is_refused_without_following_it(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            core = wrapup.load_worktree_cleanup_core()
            attempt_path = core.landing_attempt_path(worktree)
            moved = attempt_path.with_name("relocated-attempt.json")
            os.replace(attempt_path, moved)
            attempt_path.symlink_to(moved)
            frozen_bytes = moved.read_text(encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_start_artifact_inventory(str(worktree), str(main))

            self.assertIn("not a regular file", stopped.exception.reason)
            self.assertTrue(attempt_path.is_symlink())
            self.assertEqual(moved.read_text(encoding="utf-8"), frozen_bytes)

    def test_dangling_attempt_symlink_is_never_silently_replaced(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            core = wrapup.load_worktree_cleanup_core()
            attempt_path = core.landing_attempt_path(worktree)
            absent = attempt_path.with_name("absent-attempt.json")
            attempt_path.unlink()
            attempt_path.symlink_to(absent)

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_start_artifact_inventory(str(worktree), str(main))

            self.assertIn("not a regular file", stopped.exception.reason)
            self.assertTrue(attempt_path.is_symlink())
            self.assertFalse(os.path.lexists(absent))

    def test_attempt_presence_uses_one_nofollow_classification(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            core = wrapup.load_worktree_cleanup_core()
            attempt_path = core.landing_attempt_path(worktree)

            self.assertFalse(core.landing_attempt_exists(attempt_path))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            self.assertTrue(core.landing_attempt_exists(attempt_path))
            attempt_path.unlink()
            attempt_path.symlink_to(attempt_path.with_name("absent-attempt.json"))
            self.assertTrue(core.landing_attempt_exists(attempt_path))

    def test_archived_v2_receipt_name_is_not_stamped_v1(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))

            archive = Path(
                wrapup.abandon_unfinished_landing_attempt(str(worktree), str(main))
            )

            self.assertTrue(archive.is_file())
            self.assertNotIn("-v1", archive.name)
            self.assertIn(".v2.abandoned-", archive.name)
            self.assertTrue(
                archive.name.startswith(core_archive_stem(wrapup)),
                archive.name,
            )

    def test_archived_v1_receipt_name_reports_its_own_contract_version(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            core = wrapup.load_worktree_cleanup_core()
            downgrade_landing_attempt_to_v1(core, worktree)

            archive = Path(
                wrapup.abandon_unfinished_landing_attempt(str(worktree), str(main))
            )

            self.assertTrue(archive.is_file())
            self.assertIn(".v1.abandoned-", archive.name)

    def test_cleanup_authorization_always_returns_an_assessment_or_stops(self):
        """Coverage for the removed `cleanup is not None` dead branches."""
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))

            assessment = wrapup.ensure_worktree_removable(str(worktree), str(main))
            self.assertIsNotNone(assessment)
            self.assertEqual(assessment.reasons, ())

            blocker = worktree / "consumer/blocker.txt"
            blocker.parent.mkdir(parents=True)
            blocker.write_text("keep", encoding="utf-8")
            with self.assertRaises(wrapup.Stop):
                wrapup.ensure_worktree_removable(str(worktree), str(main))
            self.assertEqual(blocker.read_text(encoding="utf-8"), "keep")

    def test_land_reports_generated_files_without_a_dead_guard_flag(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("generated\n", encoding="utf-8")
            wrapup.freeze_landing_artifact_evidence(
                str(worktree), str(main), push_succeeded=True
            )

            report = run_land(wrapup, main, land_args())

            self.assertEqual(
                report["cleanup_guard"],
                {
                    "assumptions_read": False,
                    "landing_generated_files": ["dist-kit/package.tgz"],
                },
            )
            self.assertEqual(report["worktree_removed"], str(worktree))
            self.assertFalse(worktree.exists())

    def test_tampered_v2_journal_claiming_generated_files_still_stops_land(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            core = wrapup.load_worktree_cleanup_core()
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("generated\n", encoding="utf-8")
            wrapup.freeze_landing_artifact_evidence(
                str(worktree), str(main), push_succeeded=True
            )
            victim = worktree / "dist-kit/claimed.tgz"
            victim.write_text("consumer bytes", encoding="utf-8")
            rewrite_landing_attempt(
                core,
                worktree,
                lambda payload: payload.__setitem__(
                    "generatedFiles", ["dist-kit/claimed.tgz"]
                ),
            )

            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args())

            self.assertIn("consumer-owned", stopped.exception.reason)
            self.assertIn("dist-kit/claimed.tgz", stopped.exception.reason)
            self.assertEqual(victim.read_text(encoding="utf-8"), "consumer bytes")
            self.assertTrue(worktree.is_dir())


class LegacyLandingAttemptContract(unittest.TestCase):
    """#275 — a coherent v1 journal is legacy, not corruption, and has a route out."""

    def assert_legacy_stop(self, stop):
        self.assertIn("superseded v1 journal contract", stop.reason)
        self.assertIn("--abandon-unfinished-attempt", stop.reason)
        self.assertNotIn("incoherent", stop.reason)

    def test_coherent_v1_started_journal_is_classified_as_legacy(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            core = wrapup.load_worktree_cleanup_core()
            downgrade_landing_attempt_to_v1(core, worktree)

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_start_artifact_inventory(str(worktree), str(main))

            self.assert_legacy_stop(stopped.exception)

    def test_coherent_v1_frozen_journal_is_classified_as_legacy(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("generated\n", encoding="utf-8")
            wrapup.freeze_landing_artifact_evidence(
                str(worktree), str(main), push_succeeded=True
            )
            core = wrapup.load_worktree_cleanup_core()
            downgrade_landing_attempt_to_v1(core, worktree)

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_start_artifact_inventory(str(worktree), str(main))

            self.assert_legacy_stop(stopped.exception)
            self.assertEqual(generated.read_text(encoding="utf-8"), "generated\n")

    def test_incoherent_v1_journal_stays_classified_as_corruption(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            core = wrapup.load_worktree_cleanup_core()

            def mutate(payload):
                payload.pop("policyDigest", None)
                payload["contractVersion"] = 1
                payload["branch"] = "fix/999-foreign"

            rewrite_landing_attempt(core, worktree, mutate)

            with self.assertRaises(wrapup.Stop) as stopped:
                wrapup.landing_start_artifact_inventory(str(worktree), str(main))

            self.assertIn("incoherent", stopped.exception.reason)

    def test_land_names_the_safe_abandon_command_for_a_legacy_attempt(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            core = wrapup.load_worktree_cleanup_core()
            downgrade_landing_attempt_to_v1(core, worktree)
            consumer = worktree / "consumer/keep.txt"
            consumer.parent.mkdir(parents=True)
            consumer.write_text("mine", encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args())

            self.assert_legacy_stop(stopped.exception)
            self.assertTrue(worktree.is_dir())
            self.assertEqual(consumer.read_text(encoding="utf-8"), "mine")

    def test_v2_archival_stays_valid_without_baseline_or_local_main_profile(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            core = wrapup.load_worktree_cleanup_core()
            core.artifact_baseline_path(worktree).unlink()
            (main / "docs/agents/workflow-capabilities.json").unlink()
            ambiguous = worktree / "dist-kit/ambiguous.tgz"
            ambiguous.parent.mkdir(parents=True)
            ambiguous.write_text("unknown owner", encoding="utf-8")

            archive = Path(
                wrapup.abandon_unfinished_landing_attempt(str(worktree), str(main))
            )

            self.assertTrue(archive.is_file())
            self.assertIn(".v2.abandoned-", archive.name)
            self.assertEqual(ambiguous.read_text(encoding="utf-8"), "unknown owner")

    def test_legacy_abandon_claims_no_generated_or_consumer_file(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            generated = worktree / "dist-kit/package.tgz"
            generated.parent.mkdir(parents=True)
            generated.write_text("generated\n", encoding="utf-8")
            wrapup.freeze_landing_artifact_evidence(
                str(worktree), str(main), push_succeeded=True
            )
            consumer = worktree / "consumer/keep.txt"
            consumer.parent.mkdir(parents=True)
            consumer.write_text("mine", encoding="utf-8")
            core = wrapup.load_worktree_cleanup_core()
            downgrade_landing_attempt_to_v1(core, worktree)

            archive = Path(
                wrapup.abandon_unfinished_landing_attempt(str(worktree), str(main))
            )

            self.assertTrue(archive.is_file())
            self.assertIn(".v1.abandoned-", archive.name)
            self.assertEqual(generated.read_text(encoding="utf-8"), "generated\n")
            self.assertEqual(consumer.read_text(encoding="utf-8"), "mine")
            self.assertTrue(worktree.is_dir())


class CanonicalCleanupDriftRecovery(unittest.TestCase):
    """#272 — canonical policy drift stays fail-closed but has a supported route out."""

    def drifted_merged_worktree(self, root: Path, wrapup, mutate) -> tuple[Path, Path]:
        """Freeze a landing attempt, then drift canonical policy after the merge."""
        main, worktree = create_merged_worktree(
            root, scratch_patterns=[".claude/logs/**"]
        )
        wrapup.landing_start_artifact_inventory(str(worktree), str(main))
        generated = worktree / "dist-kit/package.tgz"
        generated.parent.mkdir(parents=True)
        generated.write_text("generated\n", encoding="utf-8")
        wrapup.freeze_landing_artifact_evidence(
            str(worktree), str(main), push_succeeded=True
        )
        profile_path = main / "docs/agents/workflow-capabilities.json"
        document = json.loads(profile_path.read_text(encoding="utf-8"))
        mutate(document)
        profile_path.write_text(json.dumps(document), encoding="utf-8")
        command(["git", "add", "docs/agents/workflow-capabilities.json"], main)
        command(["git", "commit", "-m", "drift canonical cleanup policy"], main)
        command(["git", "push", "origin", "main"], main)
        return main, worktree

    @staticmethod
    def widen_scratch(document):
        document["worktreeLifecycle"]["scratchPatterns"] = [
            ".claude/logs/**", "**/.cache/**",
        ]

    @staticmethod
    def drop_generator_pattern(document):
        document["wrapup"]["landingGeneratedArtifactPatterns"] = [
            "**/__pycache__/**",
        ]

    def test_first_cleanup_stops_before_every_mutation_and_names_recovery(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = self.drifted_merged_worktree(
                Path(tmp), wrapup, self.widen_scratch
            )
            generated = worktree / "dist-kit/package.tgz"

            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args())

            self.assertIn(
                "worktree cleanup policy differs from merged canonical origin/main",
                stopped.exception.reason,
            )
            self.assertIn("--recover-canonical-cleanup", stopped.exception.reason)
            self.assertTrue(worktree.is_dir())
            self.assertEqual(generated.read_text(encoding="utf-8"), "generated\n")
            self.assertIn(
                "fix/268-cleanup",
                command(["git", "branch", "--list", "fix/268-cleanup"], main).stdout,
            )

    def test_recovery_retires_the_merged_worktree_and_branch_idempotently(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = self.drifted_merged_worktree(
                Path(tmp), wrapup, self.widen_scratch
            )
            log = worktree / ".claude/logs/session.log"
            log.parent.mkdir(parents=True)
            log.write_text("session\n", encoding="utf-8")

            first = run_land(
                wrapup, main, land_args(recover_canonical_cleanup=True)
            )
            second = run_land(
                wrapup, main, land_args(recover_canonical_cleanup=True)
            )

            self.assertEqual(first["worktree_removed"], str(worktree))
            self.assertEqual(
                first["cleanup_guard"]["landing_generated_files"],
                ["dist-kit/package.tgz"],
            )
            self.assertFalse(worktree.exists())
            self.assertEqual(first["branch_retired"], True)
            self.assertEqual(second["worktree_removed"], None)
            self.assertEqual(second["branch_retired"], "already absent")
            self.assertEqual(
                command(["git", "branch", "--list", "fix/268-cleanup"], main).stdout,
                "",
            )

    def test_recovery_refuses_evidence_outside_canonical_policy(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = self.drifted_merged_worktree(
                Path(tmp), wrapup, self.drop_generator_pattern
            )
            generated = worktree / "dist-kit/package.tgz"

            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args(recover_canonical_cleanup=True))

            self.assertIn(
                "outside canonical cleanup policy", stopped.exception.reason
            )
            self.assertIn("dist-kit/package.tgz", stopped.exception.reason)
            self.assertEqual(generated.read_text(encoding="utf-8"), "generated\n")
            self.assertTrue(worktree.is_dir())

    def test_recovery_refuses_a_changed_frozen_identity(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = self.drifted_merged_worktree(
                Path(tmp), wrapup, self.widen_scratch
            )
            generated = worktree / "dist-kit/package.tgz"
            generated.write_text("replaced by a user\n", encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args(recover_canonical_cleanup=True))

            self.assertIn("evidence changed", stopped.exception.reason)
            self.assertEqual(
                generated.read_text(encoding="utf-8"), "replaced by a user\n"
            )
            self.assertTrue(worktree.is_dir())

    def test_recovery_preserves_pre_existing_and_foreign_files(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            main, worktree = self.drifted_merged_worktree(
                root, wrapup, self.widen_scratch
            )
            consumer = worktree / "consumer/private.cache"
            consumer.parent.mkdir(parents=True)
            consumer.write_text("mine", encoding="utf-8")
            foreign = root / "foreign.txt"
            foreign.write_text("keep", encoding="utf-8")

            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args(recover_canonical_cleanup=True))

            self.assertIn("consumer/private.cache", stopped.exception.detail)
            self.assertEqual(consumer.read_text(encoding="utf-8"), "mine")
            self.assertEqual(foreign.read_text(encoding="utf-8"), "keep")
            self.assertTrue((worktree / "dist-kit/package.tgz").exists())
            self.assertTrue(worktree.is_dir())

    def test_recovery_refuses_an_unmerged_branch(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = create_merged_worktree(Path(tmp))
            wrapup.landing_start_artifact_inventory(str(worktree), str(main))
            wrapup.freeze_landing_artifact_evidence(
                str(worktree), str(main), push_succeeded=True
            )
            (worktree / "later.txt").write_text("unmerged\n", encoding="utf-8")
            command(["git", "add", "later.txt"], worktree)
            command(["git", "commit", "-m", "unmerged work"], worktree)

            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args(recover_canonical_cleanup=True))

            self.assertIn("not merged into canonical origin/main",
                          stopped.exception.reason)
            self.assertTrue(worktree.is_dir())

    def test_recovery_refuses_an_unfrozen_attempt(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = self.drifted_merged_worktree(
                Path(tmp), wrapup, self.widen_scratch
            )
            core = wrapup.load_worktree_cleanup_core()
            rewrite_landing_attempt(
                core,
                worktree,
                lambda payload: payload.update(
                    {"state": "started", "authorizedEvidence": [],
                     "pushSucceeded": False},
                ),
            )

            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args(recover_canonical_cleanup=True))

            self.assertIn("frozen landing attempt", stopped.exception.reason)
            self.assertTrue((worktree / "dist-kit/package.tgz").exists())
            self.assertTrue(worktree.is_dir())

    def test_recovery_never_adopts_a_legacy_journal(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = self.drifted_merged_worktree(
                Path(tmp), wrapup, self.widen_scratch
            )
            core = wrapup.load_worktree_cleanup_core()
            downgrade_landing_attempt_to_v1(core, worktree)

            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args(recover_canonical_cleanup=True))

            self.assertIn("incoherent", stopped.exception.reason)
            self.assertTrue((worktree / "dist-kit/package.tgz").exists())
            self.assertTrue(worktree.is_dir())

    def test_abandon_and_recovery_flags_are_mutually_exclusive(self):
        result = subprocess.run(
            [
                os.sys.executable, str(WRAPUP), "land", "--branch", "fix/1-x",
                "--abandon-unfinished-attempt", "--recover-canonical-cleanup",
            ],
            cwd=REPO,
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("not allowed with argument", result.stderr)


def core_archive_stem(wrapup) -> str:
    return wrapup.load_worktree_cleanup_core().LANDING_ATTEMPT_ARCHIVE_STEM


if __name__ == "__main__":
    unittest.main()
