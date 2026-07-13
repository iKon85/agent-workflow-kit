#!/usr/bin/env python3
"""Trailing paste-artifact lint (#1991 retro).

Skill bodies and agent docs are often assembled by pasting rendered tool output.
That paste can drag a literal harness closing tag along — a stray `</content>`
or `</invoke>` line at the end of the file. It is invisible in most renders but
ships verbatim (one such line sat in a publish:true skill and would have shipped
in the kit). The 2026-07-09 census found 8 of them across both skill surfaces
and docs/agents.

This lint fails when the LAST non-empty line of a scanned file is a known paste
artifact. Deliberately trailing-only: the same token inside a fenced code block
mid-file can be a legitimate example, but as the file's final line it is always
garbage. Extend ARTIFACTS only with verified occurrences, not speculation.

Run: python3 scripts/test_skill_trailing_artifact_lint.py
"""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SCAN_DIRS = [".claude/skills", ".agents/skills", "docs/agents"]

# Verified paste artifacts (both seen in the 2026-07-09 census). Extend on sight.
ARTIFACTS = {"</content>", "</invoke>"}


def _last_nonempty_line(path):
    last = None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.strip():
            last = line.strip()
    return last


def _scan():
    hits = []
    for d in SCAN_DIRS:
        base = ROOT / d
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*.md")):
            if _last_nonempty_line(p) in ARTIFACTS:
                hits.append(str(p.relative_to(ROOT)))
    return hits


class TrailingPasteArtifact(unittest.TestCase):
    def test_no_file_ends_on_a_paste_artifact(self):
        hits = _scan()
        self.assertEqual(
            hits, [],
            "file(s) end on a literal harness closing tag — a paste artifact "
            f"from assembling the body out of rendered tool output; delete the "
            f"trailing line(s): {hits}",
        )

    def test_detector_fires_on_synthetic_artifact(self):
        """Negative proof: the detector actually recognizes an artifact tail."""
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "x.md"
            p.write_text("# Title\n\nbody\n</content>\n\n")
            self.assertEqual(_last_nonempty_line(p), "</content>")
            self.assertIn(_last_nonempty_line(p), ARTIFACTS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
