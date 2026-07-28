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


def raw(stdout, returncode=0, stderr=""):
    """One platform answer exactly as `gh` wrote it — not a re-encoded payload."""
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


def pr_snapshot(**overrides):
    snapshot = {
        "state": "OPEN",
        "mergeable": "MERGEABLE",
        "mergeStateStatus": "CLEAN",
        "statusCheckRollup": [],
        "baseRefName": "main",
    }
    snapshot.update(overrides)
    return snapshot


def gate_runner(snapshots, required_checks):
    snapshots = iter(snapshots)
    required_checks = iter(required_checks)

    def runner(cmd, **_kwargs):
        if cmd[:3] == ["gh", "pr", "view"]:
            return completed(next(snapshots))
        if cmd[:3] == ["gh", "pr", "checks"]:
            checks = next(required_checks)
            if isinstance(checks, subprocess.CompletedProcess):
                return checks
            return completed(checks, returncode=1 if any(
                check.get("state") == "FAILURE" for check in checks
            ) else 0)
        raise AssertionError(f"unexpected command: {cmd}")

    return runner


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

    def test_required_check_names_come_from_active_base_branch_rules(self):
        commands = []

        def runner(cmd, **_kwargs):
            commands.append(cmd)
            if cmd[:3] == ["gh", "repo", "view"]:
                return completed({"nameWithOwner": "acme/repo"})
            if cmd[:2] == ["gh", "api"]:
                return completed([
                    {"type": "pull_request"},
                    {
                        "type": "required_status_checks",
                        "parameters": {
                            "required_status_checks": [
                                {"context": "test", "integration_id": 1},
                                {"context": "lint", "integration_id": 1},
                            ],
                        },
                    },
                ])
            raise AssertionError(f"unexpected command: {cmd}")

        self.assertEqual(
            self.wrapup._configured_required_check_names(
                pr_snapshot(baseRefName="release/next"), runner
            ),
            {"test", "lint"},
        )
        self.assertIn(
            ["gh", "api", "repos/acme/repo/rules/branches/release%2Fnext"],
            commands,
        )

    def test_pending_checks_are_visible_then_green_checks_proceed(self):
        snapshots = iter([
            pr_snapshot(mergeable="UNKNOWN", mergeStateStatus="BLOCKED"),
            pr_snapshot(),
        ])
        checks = iter([
            [{"name": "test", "state": "PENDING", "link": "https://example.test"}],
            [{"name": "test", "state": "SUCCESS", "link": "https://example.test"}],
        ])
        calls = []

        def runner(cmd, **_kwargs):
            calls.append(cmd)
            if cmd[:3] == ["gh", "pr", "view"]:
                return completed(next(snapshots))
            if cmd[:3] == ["gh", "pr", "checks"]:
                return completed(next(checks))
            raise AssertionError(f"unexpected command: {cmd}")

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
            configured_required_names={"test"},
        )

        self.assertFalse(already_merged)
        self.assertEqual(len(calls), 4)
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
        snapshot = pr_snapshot(mergeStateStatus="BLOCKED")
        checks = [[{
            "name": "test",
            "state": "FAILURE",
            "link": "https://example.test",
        }]]

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.wrapup.wait_for_merge_gate(
                "42",
                command_runner=gate_runner([snapshot], checks),
                configured_required_names={"test"},
            )

        self.assertEqual(stopped.exception.step, "0c merge-gate")
        self.assertIn("test", stopped.exception.detail)
        self.assertNotIn("infrastructure failure", stopped.exception.detail)

    def test_timeout_names_pending_checks_and_elapsed_time(self):
        snapshot = pr_snapshot(mergeable="UNKNOWN", mergeStateStatus="BLOCKED")
        checks = [
            {"name": "test", "state": "QUEUED"},
            {"name": "lint", "state": "PENDING"},
        ]
        clock = FakeClock()

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.wrapup.wait_for_merge_gate(
                "42",
                timeout_seconds=10,
                poll_interval=5,
                command_runner=gate_runner(
                    [snapshot, snapshot, snapshot],
                    [checks, checks, checks],
                ),
                clock=clock.monotonic,
                sleeper=clock.sleep,
                progress_stream=io.StringIO(),
                configured_required_names={"test", "lint"},
            )

        self.assertIn("wait budget exceeded", stopped.exception.reason)
        self.assertIn("elapsed=10.0s", stopped.exception.detail)
        self.assertIn("test", stopped.exception.detail)
        self.assertIn("lint", stopped.exception.detail)

    def test_already_merged_pr_bypasses_check_wait(self):
        snapshot = pr_snapshot(
            state="MERGED", mergeable="UNKNOWN", mergeStateStatus="UNKNOWN"
        )
        clock = FakeClock()
        commands = []

        def runner(cmd, **_kwargs):
            commands.append(cmd)
            return completed(snapshot)

        already_merged = self.wrapup.wait_for_merge_gate(
            "42",
            command_runner=runner,
            clock=clock.monotonic,
            sleeper=clock.sleep,
            progress_stream=io.StringIO(),
            configured_required_names={"test"},
        )

        self.assertTrue(already_merged)
        self.assertEqual(clock.now, 0)
        self.assertEqual(len(commands), 1)

    def test_optional_red_check_does_not_block_when_required_check_is_green(self):
        snapshot = pr_snapshot(
            mergeStateStatus="BLOCKED",
            statusCheckRollup=[{
                "name": "advisory-browser",
                "status": "COMPLETED",
                "conclusion": "FAILURE",
            }],
        )
        runner = gate_runner([snapshot], [[{
            "name": "test",
            "state": "SUCCESS",
            "link": "https://example.test",
        }]])

        self.assertFalse(self.wrapup.wait_for_merge_gate(
            "42", command_runner=runner, configured_required_names={"test"}
        ))

    def test_fresh_pr_waits_until_required_checks_become_visible(self):
        snapshots = [
            pr_snapshot(mergeable="UNKNOWN", mergeStateStatus="BLOCKED"),
            pr_snapshot(mergeable="UNKNOWN", mergeStateStatus="BLOCKED"),
            pr_snapshot(),
        ]
        required = [
            [],
            [{"name": "test", "state": "PENDING"}],
            [{"name": "test", "state": "SUCCESS"}],
        ]
        clock = FakeClock()
        progress = io.StringIO()

        self.assertFalse(self.wrapup.wait_for_merge_gate(
            "42",
            timeout_seconds=30,
            poll_interval=5,
            command_runner=gate_runner(snapshots, required),
            clock=clock.monotonic,
            sleeper=clock.sleep,
            progress_stream=progress,
            configured_required_names={"test"},
        ))
        self.assertIn("test (awaiting discovery)", progress.getvalue())
        self.assertIn("test", progress.getvalue())

    def test_an_empty_required_check_response_waits_instead_of_stopping(self):
        """No check has been reported yet — the ordinary state seconds after a
        PR is opened, and exactly what the poll exists to wait through (#387).

        `gh pr checks --required --json …` answers with an empty body and exit
        8 while the workflow has registered nothing yet; parsing that as JSON
        is where `Expecting value: line 1 column 1 (char 0)` came from.
        """
        snapshots = [
            pr_snapshot(mergeable="UNKNOWN", mergeStateStatus="BLOCKED"),
            pr_snapshot(mergeable="UNKNOWN", mergeStateStatus="BLOCKED"),
            pr_snapshot(),
        ]
        required = [
            raw("", returncode=8, stderr="no checks reported on the 'x' branch"),
            [{"name": "test", "state": "IN_PROGRESS", "bucket": "pending"}],
            [{"name": "test", "state": "SUCCESS"}],
        ]
        clock = FakeClock()
        progress = io.StringIO()

        self.assertFalse(self.wrapup.wait_for_merge_gate(
            "42",
            timeout_seconds=30,
            poll_interval=5,
            command_runner=gate_runner(snapshots, required),
            clock=clock.monotonic,
            sleeper=clock.sleep,
            progress_stream=progress,
            configured_required_names={"test"},
        ))
        self.assertIn("test (awaiting discovery)", progress.getvalue())

    def test_a_malformed_required_check_response_stops_and_names_itself(self):
        """Positive control for the empty case: a non-empty body that is not
        JSON is still a STOP, and says so in words an empty body never gets."""
        snapshot = pr_snapshot(mergeStateStatus="BLOCKED")

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.wrapup.wait_for_merge_gate(
                "42",
                command_runner=gate_runner(
                    [snapshot], [raw("<html>504 Gateway Timeout</html>")]
                ),
                configured_required_names={"test"},
            )

        self.assertEqual(stopped.exception.step, "0c merge-gate")
        self.assertIn("malformed", stopped.exception.reason)
        self.assertIn("504 Gateway Timeout", stopped.exception.detail)

    def test_visible_optional_check_cannot_mask_required_discovery(self):
        snapshot = pr_snapshot(
            mergeStateStatus="BLOCKED",
            statusCheckRollup=[{
                "name": "advisory-browser",
                "status": "COMPLETED",
                "conclusion": "FAILURE",
            }],
        )

        clock = FakeClock()
        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.wrapup.wait_for_merge_gate(
                "42",
                timeout_seconds=0,
                command_runner=gate_runner([snapshot], [[]]),
                clock=clock.monotonic,
                sleeper=clock.sleep,
                progress_stream=io.StringIO(),
                configured_required_names={"test"},
            )
        self.assertIn("test (awaiting discovery)", stopped.exception.detail)

    def test_zero_step_failed_job_is_named_as_infrastructure_failure(self):
        snapshot = pr_snapshot(mergeStateStatus="BLOCKED")
        check = {
            "name": "test",
            "state": "FAILURE",
            "link": "https://github.com/acme/repo/actions/runs/123/job/456",
        }
        commands = []

        def runner(cmd, **_kwargs):
            commands.append(cmd)
            if cmd[:3] == ["gh", "pr", "view"]:
                return completed(snapshot)
            if cmd[:3] == ["gh", "pr", "checks"]:
                return completed([check], returncode=1)
            if "--json" in cmd:
                return completed({
                    "jobs": [{
                        "databaseId": 456,
                        "name": "test",
                        "conclusion": "failure",
                        "steps": [],
                    }],
                })
            return subprocess.CompletedProcess(
                cmd, 1, "", "log unavailable"
            )

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.wrapup.wait_for_merge_gate(
                "42", command_runner=runner, configured_required_names={"test"}
            )

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
            "state": "FAILURE",
            "link": "https://github.com/acme/repo/actions/runs/123/job/456",
        }

        def runner(cmd, **_kwargs):
            if "--json" in cmd:
                return completed({"jobs": [{
                    "databaseId": 456,
                    "name": "test",
                    "conclusion": "failure",
                    "steps": [{"name": "x"}],
                }]})
            self.assertIn("--job", cmd)
            self.assertIn("456", cmd)
            return subprocess.CompletedProcess(cmd, 0, noisy, "")

        diagnosis = self.wrapup.infrastructure_failure_diagnosis(
            check, command_runner=runner
        )

        self.assertIn("infrastructure failure", diagnosis)
        self.assertLessEqual(len(diagnosis), self.wrapup.MAX_EXTERNAL_DETAIL)
        self.assertNotIn("\n", diagnosis)

    def test_mixed_run_does_not_misclassify_real_test_failure_as_infra(self):
        check = {
            "name": "test",
            "state": "FAILURE",
            "link": "https://github.com/acme/repo/actions/runs/123/job/456",
        }
        commands = []

        def runner(cmd, **_kwargs):
            commands.append(cmd)
            if "--json" in cmd:
                return completed({"jobs": [
                    {
                        "databaseId": 111,
                        "name": "setup",
                        "conclusion": "startup_failure",
                        "steps": [],
                    },
                    {
                        "databaseId": 456,
                        "name": "test",
                        "conclusion": "failure",
                        "steps": [{"name": "Run tests", "conclusion": "failure"}],
                    },
                ]})
            return subprocess.CompletedProcess(
                cmd, 0, "AssertionError: expected green", ""
            )

        diagnosis = self.wrapup.infrastructure_failure_diagnosis(
            check, command_runner=runner
        )

        self.assertEqual(diagnosis, "")
        self.assertIn(
            ["gh", "run", "view", "123", "--job", "456", "--log-failed"],
            commands,
        )

    def test_check_without_unique_job_match_is_not_classified_from_run_logs(self):
        check = {
            "name": "test",
            "state": "FAILURE",
            "link": "https://github.com/acme/repo/actions/runs/123",
        }
        commands = []

        def runner(cmd, **_kwargs):
            commands.append(cmd)
            if "--json" in cmd:
                return completed({"jobs": [
                    {"name": "test", "conclusion": "failure", "steps": []},
                    {"name": "test", "conclusion": "failure", "steps": []},
                ]})
            raise AssertionError("aggregate run logs must not be inspected")

        self.assertEqual(
            self.wrapup.infrastructure_failure_diagnosis(
                check, command_runner=runner
            ),
            "",
        )
        self.assertEqual(len(commands), 1)


if __name__ == "__main__":
    unittest.main()
