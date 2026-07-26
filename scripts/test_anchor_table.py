#!/usr/bin/env python3
"""Focused regression tests for pure anchor-table status decisions."""

from __future__ import annotations

import unittest

from scripts.anchor_table import refresh_status_cell, status_token_from_board


ROLES = {
    "inProgress": "In Progress",
    "review": "In Review",
    "done": "Done",
}


class AnchorTableStatusTest(unittest.TestCase):
    def test_closed_done_issue_without_pr_is_done(self):
        entry = {"state": "closed", "status": "Done", "prs": []}

        self.assertEqual(status_token_from_board(entry, ROLES), "✅")

    def test_open_issue_without_pr_is_never_done(self):
        cases = (
            ({"state": "open", "status": "Done", "prs": []}, "⬜"),
            ({"state": "open", "status": "In Progress", "prs": []}, "🔄"),
        )

        for entry, expected in cases:
            with self.subTest(status=entry["status"]):
                self.assertEqual(status_token_from_board(entry, ROLES), expected)

    def test_merged_pr_keeps_numbered_done_token(self):
        entry = {
            "state": "closed",
            "status": "Done",
            "prs": [{"state": "MERGED", "number": 203}],
        }

        self.assertEqual(status_token_from_board(entry, ROLES), "✅ #203")

    def test_refresh_never_regresses_existing_progress(self):
        open_unstarted = {"state": "open", "status": "To Do", "prs": []}

        self.assertEqual(
            refresh_status_cell("✅ spike proven", open_unstarted, ROLES),
            "✅ spike proven",
        )
        self.assertEqual(
            refresh_status_cell("🔄 spike running", open_unstarted, ROLES),
            "🔄 spike running",
        )
        self.assertEqual(
            refresh_status_cell("✅ #199", open_unstarted, ROLES),
            "✅ #199",
        )

    def test_refresh_advances_to_prless_done(self):
        closed_done = {"state": "closed", "status": "Done", "prs": []}

        self.assertEqual(
            refresh_status_cell("🔄 spike running", closed_done, ROLES),
            "✅",
        )


if __name__ == "__main__":
    unittest.main()
