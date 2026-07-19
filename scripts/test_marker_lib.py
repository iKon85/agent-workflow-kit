#!/usr/bin/env python3
"""Behavior tests for marker identity lookup and reconciliation."""

from __future__ import annotations

import json
import importlib.util
import io
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from scripts.marker_lib import find_by_marker, reconcile_after_create


CLI_SPEC = importlib.util.spec_from_file_location(
    "find_by_marker_cli_test", Path(__file__).with_name("find-by-marker.py"))
cli = importlib.util.module_from_spec(CLI_SPEC)
assert CLI_SPEC.loader is not None
CLI_SPEC.loader.exec_module(cli)


class MarkerLookupTest(unittest.TestCase):
    def test_pagination_joins_all_pages(self):
        calls: list[list[str]] = []

        def fake_gh(args: list[str]) -> str:
            calls.append(args)
            return json.dumps([
                [{"number": 11, "state": "open", "body":
                  "<!-- prd-source-id: alpha -->"}],
                [{"number": 12, "state": "closed", "body":
                  "<!-- prd-source-id: alpha -->"}],
            ])

        result = find_by_marker("example/repo", "prd-source-id", "alpha", fake_gh)

        self.assertEqual(result["count"], 2)
        self.assertEqual(result["issues"], [
            {"number": 11, "state": "open"},
            {"number": 12, "state": "closed"},
        ])
        self.assertIn("--paginate", calls[0])
        self.assertIn("state=all", calls[0])

    def test_pull_requests_are_discarded_before_matching(self):
        marker = "<!-- wave-stub-source: same -->"
        payload = [[
            {"number": 21, "state": "open", "body": marker,
             "pull_request": {"url": "https://api.example/pr/21"}},
            {"number": 22, "state": "open", "body": marker},
        ]]

        result = find_by_marker(
            "example/repo", "wave-stub-source", "same",
            lambda _args: json.dumps(payload),
        )

        self.assertEqual(result["issues"], [{"number": 22, "state": "open"}])

    def test_closed_only_match_requires_user_decision(self):
        payload = [[{"number": 31, "state": "closed", "body":
                     "<!-- prd-source-id: retired -->"}]]

        result = find_by_marker(
            "example/repo", "prd-source-id", "retired",
            lambda _args: json.dumps(payload),
        )

        self.assertEqual(result["verdict"], "user-decision")

    def test_marker_value_is_exact_not_a_prefix_match(self):
        payload = [[
            {"number": 41, "state": "open", "body":
             "<!-- prd-source-id: alpha-long -->"},
            {"number": 42, "state": "open", "body":
             "<!-- prd-source-id: alpha -->"},
        ]]

        result = find_by_marker(
            "example/repo", "prd-source-id", "alpha",
            lambda _args: json.dumps(payload),
        )

        self.assertEqual(result["issues"], [{"number": 42, "state": "open"}])
        self.assertEqual(result["verdict"], "update")

    def test_post_create_rescan_stops_and_reports_both_duplicate_numbers(self):
        marker = "<!-- program-leaf-source: program-x/1a -->"
        responses = iter([
            [[]],
            [[
                {"number": 101, "state": "open", "body": marker},
                {"number": 102, "state": "open", "body": marker},
            ]],
        ])
        calls: list[list[str]] = []

        def fake_gh(args: list[str]) -> str:
            calls.append(args)
            return json.dumps(next(responses))

        before = find_by_marker(
            "example/repo", "program-leaf-source", "program-x/1a",
            fake_gh,
        )
        after = reconcile_after_create(
            "example/repo", "program-leaf-source", "program-x/1a", 101,
            fake_gh,
        )

        self.assertEqual(before["verdict"], "create")
        self.assertEqual(after["verdict"], "STOP")
        self.assertEqual([issue["number"] for issue in after["issues"]], [101, 102])
        self.assertEqual(len(calls), 2)

    def test_post_create_rescan_rejects_a_different_single_issue(self):
        payload = [[{"number": 102, "state": "open", "body":
                     "<!-- prd-source-id: alpha -->"}]]

        result = reconcile_after_create(
            "example/repo", "prd-source-id", "alpha", 101,
            lambda _args: json.dumps(payload),
        )

        self.assertEqual(result["verdict"], "STOP")
        self.assertEqual(result["issues"], [{"number": 102, "state": "open"}])

    def test_unknown_marker_kind_has_distinct_cli_error(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.main(
                ["--kind", "unknown-source", "--slug", "x"],
                repo="example/repo",
                gh=lambda _args: self.fail("unknown kinds must fail before scanning"),
            )

        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), "")
        self.assertIn("unknown marker kind", err.getvalue())

    def test_cli_bounds_a_hanging_github_call(self):
        with patch.object(
            cli.subprocess, "run",
            side_effect=subprocess.TimeoutExpired("gh", 30),
        ):
            with self.assertRaisesRegex(RuntimeError, "timed out after 30s"):
                cli._gh(["api", "--paginate", "repos/example/repo/issues"])


if __name__ == "__main__":
    unittest.main()
