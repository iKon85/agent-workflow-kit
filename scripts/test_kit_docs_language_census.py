#!/usr/bin/env python3
"""dist-kit doc language census (#1953) — a coarse net over EVERY shipped
`.md` file (docs/templates, README, SKILL.md bodies alike), not just
`publish: true` skill bodies (that zero-tolerance census already exists in
`test_skill_language_census.py`). This guard is a percentage smoke test: a
kit doc is red once ≥10% of its lines carry German prose, so an
English-speaking consumer never again silently gets a majority-German
template the way `docs/agents/wave-anchor-template.md` shipped before this
slice (23/100 lines German — the census #1953 was written to catch).

Reuses `test_skill_language_census.py`'s wordlist + line-classification
helpers (`_line_hits`, `strip_frontmatter`, the bilingual
`<user-story-example lang="de">` block skip) rather than a parallel
heuristic — same STRONG/WEAK wordlist, same allowlist exemptions (contract
literals, `Welle <N>` title format, the inline `language-census: ok`
marker).

Two test classes:
  - `RatioFixtures` — pure-function unit tests, no build. Proves the ratio
    computation goes RED on an artificially-German fixture and GREEN on an
    all-English one, independent of the real dist-kit build.
  - `DistKitDocsCensus` — builds the REAL dist-kit (subprocess, like
    `test_dist_kit_smoke.py`) and asserts every shipped `.md` file is under
    the threshold.

Run: python3 scripts/test_kit_docs_language_census.py
"""
import subprocess
import sys
import unittest
from pathlib import Path

from test_skill_language_census import (
    BILINGUAL_BLOCK_END,
    BILINGUAL_BLOCK_START,
    _line_hits,
    strip_frontmatter,
)

REPO = Path(__file__).resolve().parent.parent
DIST = REPO / "dist-kit"

GERMAN_LINE_THRESHOLD_PCT = 10.0


def german_line_ratio(text: str) -> tuple[int, int]:
    """(german_hit_lines, total_lines) for a doc body — frontmatter stripped,
    bilingual `<user-story-example lang="de">...</user-story-example>` blocks
    skipped (same exemptions as the publish:true skill census)."""
    body = strip_frontmatter(text)
    lines = body.splitlines()
    total = len(lines)
    hits = 0
    in_bilingual_de_block = False
    for line in lines:
        if BILINGUAL_BLOCK_START.search(line):
            in_bilingual_de_block = True
        if in_bilingual_de_block:
            if BILINGUAL_BLOCK_END.search(line):
                in_bilingual_de_block = False
            continue
        if _line_hits(line):
            hits += 1
    return hits, total


def is_below_threshold(text: str) -> tuple[bool, float]:
    """(clean, pct) — clean is False once pct >= GERMAN_LINE_THRESHOLD_PCT."""
    hits, total = german_line_ratio(text)
    if total == 0:
        return True, 0.0
    pct = hits / total * 100
    return pct < GERMAN_LINE_THRESHOLD_PCT, pct


class RatioFixtures(unittest.TestCase):
    """Pure-function proof: the census heuristic actually catches German
    prose (RED) and does not false-positive on clean English (GREEN) —
    independent of whether dist-kit can be built in this environment."""

    def test_mostly_german_doc_is_red(self):
        # Mirrors the pre-translation wave-anchor-template.md shape: a title
        # line + a handful of English structural lines + a majority of dense
        # German prose paragraphs — comfortably over the 10% line threshold.
        german_doc = "\n".join(
            ["# Title", "", "## Section", ""]
            + ["Diese Zeile beschreibt eine Änderung und ist auf Deutsch geschrieben."] * 3
            + ["Der Anker wird für die Wellen-Planung genutzt und muss gepflegt werden."] * 3
            + [""] * 14  # padding so German lines are a clear >10% share, not 100%
        )
        clean, pct = is_below_threshold(german_doc)
        self.assertFalse(clean, f"expected RED (>= {GERMAN_LINE_THRESHOLD_PCT}%), got {pct:.1f}%")
        self.assertGreaterEqual(pct, GERMAN_LINE_THRESHOLD_PCT)

    def test_all_english_doc_is_green(self):
        english_doc = "\n".join(
            ["# Title", "", "## Section", "",
             "This line describes a change and is written in English.",
             "The anchor is used for wave planning and must be maintained.",
             ""]
        )
        clean, pct = is_below_threshold(english_doc)
        self.assertTrue(clean, f"expected GREEN (< {GERMAN_LINE_THRESHOLD_PCT}%), got {pct:.1f}%")

    def test_frontmatter_excluded_from_ratio(self):
        # A German `description:` inside frontmatter (legitimate — quotes a
        # German trigger phrase) must not count toward the body ratio.
        text = (
            "---\n"
            "name: x\n"
            'description: Use when "lass uns das Board durchgehen und die Wellen planen".\n'
            "---\n\n"
            "This body is English only, nothing else in here at all.\n"
        )
        clean, pct = is_below_threshold(text)
        self.assertTrue(clean, f"frontmatter leaked into ratio: {pct:.1f}%")

    def test_exempt_marker_line_does_not_count_as_a_hit(self):
        text = "\n".join(
            ["# Title", "Dies ist deutsch und bleibt es.  <!-- language-census: ok -->"]
            + ["English line."] * 10
        )
        clean, pct = is_below_threshold(text)
        self.assertTrue(clean, f"exempt marker line still counted: {pct:.1f}%")


def _build_dist_kit():
    """Run the real build (subprocess), mirroring test_dist_kit_smoke.py.
    Returns (CompletedProcess, skip_reason); skip_reason set only when node
    itself is unavailable in this environment."""
    build = REPO / "scripts/build-kit.mjs"
    try:
        r = subprocess.run(["node", str(build)], cwd=REPO,
                            capture_output=True, text=True, timeout=120)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    return r, None


class DistKitDocsCensus(unittest.TestCase):
    """Smoke test over the actually-shipped dist-kit/**/*.md — the ONLY
    thing a consumer ever reads, so this is what must stay clean."""

    @classmethod
    def setUpClass(cls):
        r, skip_reason = _build_dist_kit()
        if skip_reason:
            raise unittest.SkipTest(f"node/build unavailable: {skip_reason}")
        if r.returncode != 0:
            raise AssertionError(f"build-kit.mjs failed: {r.stderr}")
        if not DIST.is_dir():
            raise AssertionError("dist-kit/ missing after build")

    def test_every_shipped_doc_is_under_the_german_line_threshold(self):
        violations = []
        checked = 0
        for path in sorted(DIST.rglob("*.md")):
            if not path.is_file():
                continue
            checked += 1
            text = path.read_text(encoding="utf-8", errors="ignore")
            clean, pct = is_below_threshold(text)
            if not clean:
                violations.append((str(path.relative_to(DIST)), pct))

        self.assertGreater(checked, 0, "no dist-kit/**/*.md found — build produced nothing?")
        msg = "\n".join(f"  {p}: {pct:.1f}% German lines" for p, pct in violations)
        self.assertEqual(
            violations, [],
            f"Census: {checked - len(violations)} of {checked} shipped docs under "
            f"{GERMAN_LINE_THRESHOLD_PCT}% German lines.\n\n"
            "Translate the residual German prose (or, for a genuine intentional "
            "literal, mark the line `<!-- language-census: ok -->`):\n" + msg,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
