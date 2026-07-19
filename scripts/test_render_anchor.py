#!/usr/bin/env python3
"""Behavior tests for the pure Tier-2 anchor renderer."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parent
SKILLS = (
    REPO / ".claude/skills/to-issues/SKILL.md",
    REPO / ".agents/skills/to-issues/SKILL.md",
)
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location(
    "render_anchor", SCRIPTS / "render-anchor.py"
)
render_anchor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(render_anchor)


class RenderDocumentsGoldenTest(unittest.TestCase):
    def test_filled_template_and_prd_render_both_documents(self):
        template = "**Welle 12 — Safer publish.**\n\n## Slices\n| K1 |\n"
        prd = (
            "<!-- prd-source-id: safer-publish -->\n"
            "<!-- prd-content-fp: abc123 -->\n"
            "**plan_revision:** r4\n"
            "<!-- prd: awaiting-decomposition -->\n\n"
            "# Safer publish\n\nFull rationale.\n"
        )

        rendered = render_anchor.render_documents(template, prd)

        self.assertEqual(rendered.anchor_body, template)
        self.assertEqual(
            rendered.archive_body,
            "📄 Full PRD (archive, r4) — the body carries navigation/decisions only\n\n"
            "# Safer publish\n\nFull rationale.\n",
        )

    def test_only_canonical_markers_in_the_head_block_are_stripped(self):
        template = "Lean anchor\n"
        prd = (
            "<!-- wave-stub-source: safer-publish -->\n"
            "<!-- prd-source-id: safer-publish -->\n"
            "**plan_revision:** r5\n"
            "<!-- prd: awaiting-decomposition -->\n\n"
            "# PRD\n\n"
            "```md\n**plan_revision:** fake\n"
            "<!-- prd-source-id: quoted-example -->\n```\n\n"
            "> **plan_revision:** quoted-fake\n"
        )

        rendered = render_anchor.render_documents(template, prd)

        self.assertEqual(
            rendered.archive_body,
            "📄 Full PRD (archive, r5) — the body carries navigation/decisions only\n\n"
            "<!-- wave-stub-source: safer-publish -->\n\n# PRD\n\n"
            "```md\n**plan_revision:** fake\n"
            "<!-- prd-source-id: quoted-example -->\n```\n\n"
            "> **plan_revision:** quoted-fake\n",
        )

    def test_duplicate_plan_revisions_fail_closed(self):
        for revisions in (("r5", "r5"), ("r5", "r6")):
            with self.subTest(revisions=revisions):
                prd = (
                    f"**plan_revision:** {revisions[0]}\n"
                    f"**plan_revision:** {revisions[1]}\n\n# PRD\n"
                )
                with self.assertRaisesRegex(
                    ValueError, "exactly one canonical plan_revision"
                ):
                    render_anchor.render_documents("Lean anchor\n", prd)

    def test_malformed_marker_lookalikes_are_preserved(self):
        lookalikes = (
            "<!-- prd-source-id: alpha --> trailing -->",
            "<!-- prd-content-fp: abc > trailing -->",
            "<!-- prd: program > trailing -->",
        )
        for lookalike in lookalikes:
            with self.subTest(lookalike=lookalike):
                prd = (
                    f"{lookalike}\n"
                    "<!-- prd-source-id: canonical -->\n"
                    "<!-- prd-content-fp: abc123 -->\n"
                    "**plan_revision:** r5\n"
                    "<!-- prd: awaiting-decomposition -->\n\n# PRD\n"
                )

                rendered = render_anchor.render_documents("Lean anchor\n", prd)

                self.assertIn(lookalike, rendered.archive_body)
                self.assertNotIn(
                    "<!-- prd-source-id: canonical -->", rendered.archive_body
                )
                self.assertNotIn(
                    "<!-- prd-content-fp: abc123 -->", rendered.archive_body
                )
                self.assertNotIn(
                    "<!-- prd: awaiting-decomposition -->", rendered.archive_body
                )

    def test_cli_emits_each_document_without_mutating_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            template = root / "anchor.md"
            prd = root / "prd.md"
            template.write_text("Lean anchor\n", encoding="utf-8")
            prd.write_text(
                "**plan_revision:** r2\n\n# Full PRD\n", encoding="utf-8"
            )
            original = (template.read_bytes(), prd.read_bytes())

            first = self._run_cli(template, prd, "archive")
            second = self._run_cli(template, prd, "archive")
            anchor = self._run_cli(template, prd, "anchor")

            self.assertEqual(first.stdout, second.stdout)
            self.assertEqual(anchor.stdout, b"Lean anchor\n")
            self.assertEqual((template.read_bytes(), prd.read_bytes()), original)

    def test_cli_archive_is_utf8_when_python_io_encoding_is_ascii(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            template = root / "anchor.md"
            prd = root / "prd.md"
            template.write_text("Lean anchor\n", encoding="utf-8")
            prd.write_text("**plan_revision:** r2\n\n# PRD\n", encoding="utf-8")

            result = self._run_cli(
                template,
                prd,
                "archive",
                env={**os.environ, "PYTHONIOENCODING": "ascii"},
            )

            self.assertTrue(result.stdout.startswith("📄".encode("utf-8")))

    def _run_cli(
        self, template: Path, prd: Path, document: str, env: dict | None = None
    ):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "render-anchor.py"),
                "--template",
                str(template),
                "--prd",
                str(prd),
                "--document",
                document,
            ],
            check=True,
            capture_output=True,
            env=env,
        )


class PromotionStateTableTest(unittest.TestCase):
    EXPECTED_ROWS = {
        "initial": ("`B=no`, `C=0`, `P=absent`", "render + write body"),
        "body-written": (
            "`B=yes`, `C=0`, `P=absent`",
            "reconcile + write archive comment",
        ),
        "comment-written": (
            "`B=yes`, `C=exact-1`, `P=absent`",
            "promote board state",
        ),
        "promoted": (
            "`B=yes`, `C=exact-1`, `P=complete`",
            "no-op; continue publish audit",
        ),
    }
    EXPECTED_BOARD_OBSERVATIONS = {
        "ordinary-prestate": "absent",
        "stufe-1p-prestate": "absent",
        "promoted": "complete",
        "cluster-only": "partial",
        "wrong-wave": "partial",
    }

    def test_all_four_observable_states_have_one_resume_action(self):
        for path in SKILLS:
            text = path.read_text(encoding="utf-8")
            start = text.index("<!-- promotion-state-table:start -->")
            end = text.index("<!-- promotion-state-table:end -->", start)
            rows = {}
            for line in text[start:end].splitlines():
                if line.startswith("| `"):
                    cells = [cell.strip() for cell in line.strip("|").split("|")]
                    rows[cells[0].strip("`")] = (cells[1], cells[2])
            self.assertEqual(rows, self.EXPECTED_ROWS, str(path))

    def test_corrupt_comments_and_partial_board_writes_are_drift(self):
        for path in SKILLS:
            text = path.read_text(encoding="utf-8")
            self.assertIn("`C=wrong-1`", text, str(path))
            self.assertIn("`C=duplicates(<ids>)`", text, str(path))
            self.assertIn("`P=partial`", text, str(path))
            self.assertIn("drift and enters repair", text, str(path))

    def test_stufe_1p_prestamp_is_not_partial_promotion(self):
        for path in SKILLS:
            text = path.read_text(encoding="utf-8")
            start = text.index("<!-- promotion-board-observation-table:start -->")
            end = text.index("<!-- promotion-board-observation-table:end -->", start)
            rows = {}
            for line in text[start:end].splitlines():
                if line.startswith("| `"):
                    cells = [cell.strip() for cell in line.strip("|").split("|")]
                    rows[cells[0].strip("`")] = cells[2].strip("`")
            self.assertEqual(rows, self.EXPECTED_BOARD_OBSERVATIONS, str(path))

    def test_post_initial_body_drift_requires_an_operator_decision(self):
        for path in SKILLS:
            text = path.read_text(encoding="utf-8")
            self.assertIn("outside the valid `initial` tuple", text, str(path))
            self.assertIn("report the body diff", text, str(path))
            self.assertRegex(text, r"explicit\s+operator decision", str(path))
            self.assertNotIn(
                "wrong/missing `B` → rerender and rewrite the body", text, str(path)
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
