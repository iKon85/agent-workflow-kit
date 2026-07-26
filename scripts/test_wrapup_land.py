#!/usr/bin/env python3
"""Focused contracts for wrapup's bounded PR-check merge gate."""

import importlib.util
import io
import json
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WRAPUP = REPO / "scripts/wrapup-land.py"


def load_wrapup():
    spec = importlib.util.spec_from_file_location("wrapup_land_check_gate", WRAPUP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def completed(payload, returncode=0, stderr=""):
    return subprocess.CompletedProcess([], returncode, json.dumps(payload), stderr)


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class WrapupCheckGateContract(unittest.TestCase):
    def setUp(self):
        self.wrapup = load_wrapup()

    def test_pending_checks_are_visible_then_green_checks_proceed(self):
        snapshots = iter([
            {
                "state": "OPEN",
                "mergeable": "UNKNOWN",
                "mergeStateStatus": "BLOCKED",
                "statusCheckRollup": [
                    {"name": "test", "status": "IN_PROGRESS", "conclusion": None},
                ],
            },
            {
                "state": "OPEN",
                "mergeable": "MERGEABLE",
                "mergeStateStatus": "CLEAN",
                "statusCheckRollup": [
                    {"name": "test", "status": "COMPLETED", "conclusion": "SUCCESS"},
                ],
            },
        ])
        calls = []

        def runner(cmd, **_kwargs):
            calls.append(cmd)
            return completed(next(snapshots))

        clock = FakeClock()
        progress = io.StringIO()
        already_merged = self.wrapup.wait_for_merge_gate(
            "42",
            timeout_seconds=30,
            poll_interval=5,
            command_runner=runner,
            clock=clock.monotonic,
            sleeper=clock.sleep,
            progress_stream=progress,
        )

        self.assertFalse(already_merged)
        self.assertEqual(len(calls), 2)
        self.assertIn("waiting for PR #42 checks", progress.getvalue())
        self.assertIn("test", progress.getvalue())

    def test_explicit_null_conclusion_waits_even_with_green_legacy_state(self):
        checks = [{
            "name": "test",
            "status": "COMPLETED",
            "conclusion": None,
            "state": "SUCCESS",
        }]

        self.assertEqual(self.wrapup.pending_checks(checks), checks)

    def test_terminal_red_check_stops_before_merge_and_names_check(self):
        snapshot = {
            "state": "OPEN",
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "BLOCKED",
            "statusCheckRollup": [
                {"name": "test", "status": "COMPLETED", "conclusion": "FAILURE"},
            ],
        }

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.wrapup.wait_for_merge_gate(
                "42", command_runner=lambda *_args, **_kwargs: completed(snapshot)
            )

        self.assertEqual(stopped.exception.step, "0c merge-gate")
        self.assertIn("test", stopped.exception.detail)
        self.assertNotIn("infrastructure failure", stopped.exception.detail)

    def test_timeout_names_pending_checks_and_elapsed_time(self):
        snapshot = {
            "state": "OPEN",
            "mergeable": "UNKNOWN",
            "mergeStateStatus": "BLOCKED",
            "statusCheckRollup": [
                {"name": "test", "status": "QUEUED", "conclusion": None},
                {"context": "lint", "state": "PENDING"},
            ],
        }
        clock = FakeClock()

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.wrapup.wait_for_merge_gate(
                "42",
                timeout_seconds=10,
                poll_interval=5,
                command_runner=lambda *_args, **_kwargs: completed(snapshot),
                clock=clock.monotonic,
                sleeper=clock.sleep,
                progress_stream=io.StringIO(),
            )

        self.assertIn("wait budget exceeded", stopped.exception.reason)
        self.assertIn("elapsed=10.0s", stopped.exception.detail)
        self.assertIn("test", stopped.exception.detail)
        self.assertIn("lint", stopped.exception.detail)

    def test_already_merged_pr_bypasses_check_wait(self):
        snapshot = {
            "state": "MERGED",
            "mergeable": "UNKNOWN",
            "mergeStateStatus": "UNKNOWN",
            "statusCheckRollup": [
                {"name": "test", "status": "IN_PROGRESS", "conclusion": None},
            ],
        }
        clock = FakeClock()

        already_merged = self.wrapup.wait_for_merge_gate(
            "42",
            command_runner=lambda *_args, **_kwargs: completed(snapshot),
            clock=clock.monotonic,
            sleeper=clock.sleep,
            progress_stream=io.StringIO(),
        )

        self.assertTrue(already_merged)
        self.assertEqual(clock.now, 0)

    def test_zero_step_failed_job_is_named_as_infrastructure_failure(self):
        snapshot = {
            "state": "OPEN",
            "mergeable": "MERGEABLE",
            "mergeStateStatus": "BLOCKED",
            "statusCheckRollup": [
                {
                    "name": "test",
                    "status": "COMPLETED",
                    "conclusion": "FAILURE",
                    "detailsUrl": "https://github.com/acme/repo/actions/runs/123",
                },
            ],
        }
        commands = []

        def runner(cmd, **_kwargs):
            commands.append(cmd)
            if cmd[:3] == ["gh", "pr", "view"]:
                return completed(snapshot)
            if "--json" in cmd:
                return completed({
                    "jobs": [{"name": "test", "conclusion": "failure", "steps": []}],
                })
            return subprocess.CompletedProcess(
                cmd, 1, "", "log unavailable"
            )

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.wrapup.wait_for_merge_gate("42", command_runner=runner)

        self.assertIn("test", stopped.exception.detail)
        self.assertIn("infrastructure failure", stopped.exception.detail)
        self.assertIn(["gh", "run", "view", "123", "--json", "jobs"], commands)
        self.assertEqual(
            [cmd[:3] for cmd in commands].count(["gh", "run", "view"]), 1
        )

    def test_billing_annotation_is_sanitized_and_bounded(self):
        noisy = (
            "The job was not started because recent account payments have failed. "
            + "TOKEN=secret "
            + "x" * 1000
        )
        check = {
            "name": "test",
            "conclusion": "FAILURE",
            "detailsUrl": "https://github.com/acme/repo/actions/runs/123",
        }

        def runner(cmd, **_kwargs):
            if "--json" in cmd:
                return completed({"jobs": [{"conclusion": "failure", "steps": [{"name": "x"}]}]})
            return subprocess.CompletedProcess(cmd, 0, noisy, "")

        diagnosis = self.wrapup.infrastructure_failure_diagnosis(
            check, command_runner=runner
        )

        self.assertIn("infrastructure failure", diagnosis)
        self.assertLessEqual(len(diagnosis), self.wrapup.MAX_EXTERNAL_DETAIL)
        self.assertNotIn("\n", diagnosis)


if __name__ == "__main__":
    unittest.main()
