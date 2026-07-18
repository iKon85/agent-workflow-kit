#!/usr/bin/env python3
"""Behavior tests for the PR-body convention guard."""
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path
from types import SimpleNamespace

PROFILE_PATH = Path(__file__).parent.parent / "docs/agents/board-sync.md"
TEST_ENV = os.environ.copy()
TEST_ENV["BOARD_SYNC_PROFILE"] = str(PROFILE_PATH)
_PREVIOUS_PROFILE = os.environ.get("BOARD_SYNC_PROFILE")
os.environ["BOARD_SYNC_PROFILE"] = str(PROFILE_PATH)

_SPEC = importlib.util.spec_from_file_location(
    "pr_body_check", Path(__file__).parent / "pr-body-check.py")
pbc = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(pbc)
if _PREVIOUS_PROFILE is None:
    os.environ.pop("BOARD_SYNC_PROFILE", None)
else:
    os.environ["BOARD_SYNC_PROFILE"] = _PREVIOUS_PROFILE
import pr_body_e2e as e2e  # noqa: E402

SCRIPT_PATH = Path(__file__).parent / "pr-body-check.py"

RETRO = "**Retro:** skipped — focused guard change"
VALID_LEAF_BODY = f"closes #149\n{RETRO}"


class E2eNaBodyEvidence(unittest.TestCase):
    def test_no_trailer_and_no_evidence_is_green(self):
        self.assertEqual(pbc.check_pr_body(VALID_LEAF_BODY, 149, None), [])

    def test_no_trailer_with_evidence_is_green(self):
        body = VALID_LEAF_BODY + "\nE2E: n/a — harmless extra context"
        self.assertEqual(pbc.check_pr_body(body, 149, None), [])

    def test_valid_trailer_without_body_evidence_is_actionable(self):
        violations = pbc.check_pr_body(
            VALID_LEAF_BODY,
            149,
            None,
            has_e2e_na_trailer=True,
        )
        self.assertTrue(any("E2E: n/a" in violation for violation in violations))

    def test_valid_trailer_with_non_empty_evidence_is_green(self):
        body = VALID_LEAF_BODY + "\nE2E: n/a — backend-only change"
        self.assertEqual(
            pbc.check_pr_body(body, 149, None, has_e2e_na_trailer=True), []
        )

    def test_valid_trailer_with_empty_evidence_is_actionable(self):
        body = VALID_LEAF_BODY + "\nE2E: n/a —   "
        violations = pbc.check_pr_body(
            body, 149, None, has_e2e_na_trailer=True
        )
        self.assertTrue(any("E2E: n/a" in violation for violation in violations))


class ExistingBodyRules(unittest.TestCase):
    def test_anchor_slice_still_accepts_part_of_and_leaf_close(self):
        body = f"Part of #130\ncloses #149\n{RETRO}"
        self.assertEqual(pbc.check_pr_body(body, 149, 130), [])

    def test_anchor_slice_still_rejects_close_on_anchor(self):
        body = f"Part of #130\ncloses #130\n{RETRO}"
        self.assertTrue(any("130" in item for item in pbc.check_pr_body(body, 149, 130)))

    def test_leaf_still_requires_active_close(self):
        body = f"`closes #149`\n{RETRO}"
        self.assertTrue(any("closes #149" in item for item in pbc.check_pr_body(body, 149, None)))

    def test_retro_line_still_required(self):
        self.assertTrue(any("Retro" in item for item in pbc.check_pr_body("closes #149", 149, None)))

    def test_wave_pr_still_requires_part_of_without_closing_anchor(self):
        body = f"Part of #130\ncloses #149\n{RETRO}"
        self.assertEqual(pbc.check_pr_body(body, 130, None, is_anchor=True), [])


class ImmutableRangeTrailer(unittest.TestCase):
    def test_two_commit_range_finds_one_valid_trailer(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir)
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(
                ["git", "config", "user.email", "tests@example.invalid"],
                cwd=repo,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Test User"], cwd=repo, check=True
            )
            (repo / "change.txt").write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "add", "change.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
            base = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=repo, text=True
            ).strip()
            (repo / "change.txt").write_text("head\n", encoding="utf-8")
            subprocess.run(["git", "add", "change.txt"], cwd=repo, check=True)
            subprocess.run(
                [
                    "git",
                    "commit",
                    "-qm",
                    "head\n\nE2E-NA: backend-only change",
                ],
                cwd=repo,
                check=True,
            )
            head = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=repo, text=True
            ).strip()

            self.assertTrue(e2e.fetch_has_e2e_na_trailer(base, head, cwd=repo))

    def test_unreadable_range_fails_open(self):
        self.assertFalse(e2e.fetch_has_e2e_na_trailer("missing-base", "missing-head"))

    def test_empty_or_multiple_trailers_are_not_a_single_valid_trailer(self):
        with mock.patch.object(
            e2e, "_collect_e2e_na_trailers", side_effect=[[""], ["one", "two"]]
        ):
            self.assertFalse(e2e.fetch_has_e2e_na_trailer("base", "head"))
            self.assertFalse(e2e.fetch_has_e2e_na_trailer("base", "head"))

    def test_pr_range_reads_immutable_base_and_head_oids(self):
        payload = '{"baseRefOid":"base-sha","headRefOid":"head-sha"}'
        with mock.patch.object(e2e, "_run", return_value=(0, payload)):
            self.assertEqual(e2e.fetch_pr_range("feat/149-guard"), ("base-sha", "head-sha"))

    def test_checker_defaults_to_pr_range_when_no_overrides_are_given(self):
        args = SimpleNamespace(base_sha=None, head_sha=None)
        with (
            mock.patch.object(pbc, "fetch_pr_range", return_value=("base", "head")) as get_range,
            mock.patch.object(pbc, "fetch_has_e2e_na_trailer", return_value=True) as has_trailer,
        ):
            self.assertTrue(pbc.resolve_has_e2e_na(args, "feat/149-guard"))
        get_range.assert_called_once_with("feat/149-guard")
        has_trailer.assert_called_once_with("base", "head")

    def test_unavailable_or_invalid_pr_range_fails_open(self):
        with mock.patch.object(e2e, "_run", side_effect=[(1, ""), (0, "not-json")]):
            self.assertEqual(e2e.fetch_pr_range("missing"), (None, None))
            self.assertEqual(e2e.fetch_pr_range("invalid"), (None, None))

    def test_explicit_range_requires_then_accepts_body_evidence(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repo = Path(temp_dir)
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(
                ["git", "config", "user.email", "tests@example.invalid"],
                cwd=repo,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "Test User"], cwd=repo, check=True
            )
            (repo / "change.txt").write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "add", "change.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-qm", "base"], cwd=repo, check=True)
            base = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=repo, text=True
            ).strip()
            (repo / "change.txt").write_text("head\n", encoding="utf-8")
            subprocess.run(["git", "add", "change.txt"], cwd=repo, check=True)
            subprocess.run(
                ["git", "commit", "-qm", "head\n\nE2E-NA: backend-only change"],
                cwd=repo,
                check=True,
            )
            head = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=repo, text=True
            ).strip()
            body_path = repo / "body.md"
            base_body = f"Part of #130\ncloses #149\n{RETRO}"
            command = [
                sys.executable,
                str(SCRIPT_PATH),
                "--issue",
                "149",
                "--parent",
                "130",
                "--body-file",
                str(body_path),
                "--base-sha",
                base,
                "--head-sha",
                head,
            ]

            body_path.write_text(base_body, encoding="utf-8")
            missing = subprocess.run(
                command, cwd=repo, capture_output=True, text=True, env=TEST_ENV
            )
            self.assertEqual(missing.returncode, 1, missing.stdout + missing.stderr)
            self.assertIn("E2E: n/a", missing.stdout)

            body_path.write_text(
                base_body + "\nE2E: n/a — backend-only change\n", encoding="utf-8"
            )
            matching = subprocess.run(
                command, cwd=repo, capture_output=True, text=True, env=TEST_ENV
            )
            self.assertEqual(matching.returncode, 0, matching.stdout + matching.stderr)


class ExistingExitCodes(unittest.TestCase):
    def test_no_issue_is_still_exit_two(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT_PATH), "--branch", "main"],
            capture_output=True,
            text=True,
            env=TEST_ENV,
        )
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)

    def test_unreadable_body_file_is_still_exit_two(self):
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "--issue",
                "149",
                "--parent",
                "130",
                "--body-file",
                "/definitely/missing/body.md",
            ],
            capture_output=True,
            text=True,
            env=TEST_ENV,
        )
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
