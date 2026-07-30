#!/usr/bin/env python3
"""Behavior tests for the anchor renderer and the publish reconciler contract."""

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


class RenderAnchorBodyGoldenTest(unittest.TestCase):
    def test_template_and_prd_render_one_writable_body(self):
        template = "**Welle 12 — Safer publish.**\n\n## Slices\n| K1 |\n"
        prd = (
            "<!-- prd-source-id: safer-publish -->\n"
            "<!-- prd-content-fp: abc123 -->\n"
            "**plan_revision:** r4\n"
            "<!-- prd: awaiting-decomposition -->\n\n"
            "# Safer publish\n\nFull rationale.\n"
        )

        self.assertEqual(
            render_anchor.render_anchor_body(template, prd),
            "**Welle 12 — Safer publish.**\n\n## Slices\n| K1 |\n\n"
            "<details>\n<summary>📄 Full PRD (r4) — "
            "the anchor above carries navigation/decisions only</summary>\n\n"
            "# Safer publish\n\nFull rationale.\n\n</details>\n",
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

        self.assertEqual(
            render_anchor.render_anchor_body(template, prd),
            "Lean anchor\n\n"
            "<details>\n<summary>📄 Full PRD (r5) — "
            "the anchor above carries navigation/decisions only</summary>\n\n"
            "<!-- wave-stub-source: safer-publish -->\n\n# PRD\n\n"
            "```md\n**plan_revision:** fake\n"
            "<!-- prd-source-id: quoted-example -->\n```\n\n"
            "> **plan_revision:** quoted-fake\n\n</details>\n",
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
                    render_anchor.render_anchor_body("Lean anchor\n", prd)

    def test_plan_revision_requires_numeric_canonical_value(self):
        for lookalike in ("rfoo", "r5!"):
            with self.subTest(lookalike=lookalike, valid_revision=True):
                malformed = f"**plan_revision:** {lookalike}"
                prd = f"{malformed}\n**plan_revision:** r5\n\n# PRD\n"
                rendered = render_anchor.render_anchor_body("Lean anchor\n", prd)
                self.assertIn(malformed, rendered)

            with self.subTest(lookalike=lookalike, valid_revision=False):
                with self.assertRaisesRegex(
                    ValueError, "exactly one canonical plan_revision"
                ):
                    render_anchor.render_anchor_body(
                        "Lean anchor\n", f"**plan_revision:** {lookalike}\n# PRD\n"
                    )

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

                rendered = render_anchor.render_anchor_body("Lean anchor\n", prd)

                self.assertIn(lookalike, rendered)
                self.assertNotIn(
                    "<!-- prd-source-id: canonical -->", rendered
                )
                self.assertNotIn(
                    "<!-- prd-content-fp: abc123 -->", rendered
                )
                self.assertNotIn(
                    "<!-- prd: awaiting-decomposition -->", rendered
                )

    def test_cli_emits_a_stable_body_without_mutating_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            template = root / "anchor.md"
            prd = root / "prd.md"
            template.write_text("Lean anchor\n", encoding="utf-8")
            prd.write_text(
                "**plan_revision:** r2\n\n# Full PRD\n", encoding="utf-8"
            )
            original = (template.read_bytes(), prd.read_bytes())

            first = self._run_cli(template, prd)
            second = self._run_cli(template, prd)

            self.assertEqual(first.stdout, second.stdout)
            self.assertTrue(first.stdout.startswith(b"Lean anchor\n\n<details>"))
            self.assertEqual((template.read_bytes(), prd.read_bytes()), original)

    def test_cli_output_is_utf8_when_python_io_encoding_is_ascii(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            template = root / "anchor.md"
            prd = root / "prd.md"
            template.write_text("Lean anchor\n", encoding="utf-8")
            prd.write_text("**plan_revision:** r2\n\n# PRD\n", encoding="utf-8")

            result = self._run_cli(
                template, prd, env={**os.environ, "PYTHONIOENCODING": "ascii"}
            )

            self.assertIn("📄".encode("utf-8"), result.stdout)

    def _run_cli(self, template: Path, prd: Path, env: dict | None = None):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "render-anchor.py"),
                "--template",
                str(template),
                "--prd",
                str(prd),
            ],
            check=True,
            capture_output=True,
            env=env,
        )


class PublishReconcilerContractTest(unittest.TestCase):
    """The publish path is one reconciler run — on both skill surfaces."""

    RETIRED = (
        "promotion-state-table",
        "promotion-board-observation-table",
        "byte-identical",
        "byte-for-byte",
        "archive comment",
        "prd-archive",
        "--document archive",
        "`S=yes`",
        "`B=yes`",
        "`C=exact-1`",
        "`P=absent`",
    )

    def test_no_observation_state_or_body_byte_compare_survives(self):
        for path in SKILLS:
            text = path.read_text(encoding="utf-8")
            for retired in self.RETIRED:
                self.assertNotIn(retired, text, f"{path}: {retired}")

    def test_both_surfaces_carry_the_reconciler_invocation(self):
        for path in SKILLS:
            text = path.read_text(encoding="utf-8")
            self.assertIn("board-sync.py publish-anchor", text, str(path))
            self.assertIn("--dry-run", text, str(path))
            self.assertRegex(text, r"re-run", str(path))


if __name__ == "__main__":
    unittest.main(verbosity=2)
