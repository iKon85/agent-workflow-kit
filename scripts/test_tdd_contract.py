#!/usr/bin/env python3
"""Contract tests for existing-test-first TDD without weakening RED-first."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
SURFACES = (
    ROOT / ".claude" / "skills" / "tdd" / "SKILL.md",
    ROOT / ".agents" / "skills" / "tdd" / "SKILL.md",
)
DECISIONS = ("REUSE", "EXTEND", "REPLACE", "NEW", "RETIRE", "NO-NEW-TEST")


class TddContractTest(unittest.TestCase):
    def texts(self):
        return {path: path.read_text(encoding="utf-8") for path in SURFACES}

    def test_each_behavior_gets_exactly_one_existing_test_first_decision(self):
        for path, text in self.texts().items():
            with self.subTest(surface=path.relative_to(ROOT)):
                self.assertIn("### 2. Existing-Test-First Decision", text)
                self.assertIn("For each planned behavior, record exactly one", text)
                for decision in DECISIONS:
                    self.assertEqual(
                        len(re.findall(rf"^- \*\*{re.escape(decision)}\*\*", text, re.MULTILINE)),
                        1,
                        f"{decision} must have exactly one canonical definition",
                    )

    def test_new_files_require_rejecting_the_nearest_owner_with_a_reason(self):
        for path, text in self.texts().items():
            with self.subTest(surface=path.relative_to(ROOT)):
                self.assertIn("nearest existing owner", text)
                self.assertIn("rejected with a reason", text)

    def test_red_first_is_unconditional_for_executable_behavior_and_bug_fixes(self):
        for path, text in self.texts().items():
            with self.subTest(surface=path.relative_to(ROOT)):
                self.assertIn(
                    "Every executable new behavior and bug fix must begin with a failing assertion",
                    text,
                )
                self.assertIn("REUSE and NO-NEW-TEST never bypass this RED-first invariant", text)
                self.assertRegex(
                    text,
                    r"an already-green\s+assertion does not prove the requested change",
                )

    def test_retirement_keeps_negative_tests_only_for_durable_absence(self):
        for path, text in self.texts().items():
            with self.subTest(surface=path.relative_to(ROOT)):
                self.assertIn("delete the tests that specified the retired behavior", text)
                self.assertIn("only when absence itself is a durable", text)

    def test_worked_matrix_and_counted_handoff_cover_all_decisions(self):
        for path, text in self.texts().items():
            with self.subTest(surface=path.relative_to(ROOT)):
                matrix = re.search(
                    r"### Worked decision matrix\n(?P<body>.*?)(?=\n### |\n## )",
                    text,
                    re.DOTALL,
                )
                self.assertIsNotNone(matrix)
                body = matrix.group("body")
                for decision in DECISIONS:
                    self.assertRegex(body, rf"\|\s*{re.escape(decision)}\s*\|")
                self.assertIn("list every behavior and its one decision", text)
                self.assertIn(
                    "Reused X · Extended Y · New Z · Replaced/retired W",
                    text,
                )


if __name__ == "__main__":
    unittest.main()
