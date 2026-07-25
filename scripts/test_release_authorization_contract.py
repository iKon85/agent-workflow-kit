#!/usr/bin/env python3
"""Release-authorization contract (#257).

The confirmed Semver authorizes the whole release, through tag and publish.
One human gate at version choice, not two — the second gate stalled every
release at `awaiting-tag` until someone returned, which is how 0.34.2 was
skipped and buried under 0.34.3 (#243).

What this pins:

- Both `kit-release` surfaces carry the carried-through authorization, and
  neither demands a separate confirmation before tagging.
- The safety framing survives the change: irreversibility and the pre-tag
  gates stay named, so autonomy never reads as "tag whatever".
- `CLAUDE.md`, `AGENTS.md` and ADR-0004 agree with the skill.

Run: python3 scripts/test_release_authorization_contract.py
"""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SURFACES = (".claude/skills/kit-release/SKILL.md", ".agents/skills/kit-release/SKILL.md")
ADR = "docs/adr/0004-release-intent-is-a-version-tag.md"
DOCTRINE_FILES = ("CLAUDE.md", "AGENTS.md")
# Wording that would reinstate the second gate anywhere in the release surface.
SECOND_GATE = (
    "separate explicit confirmation",
    "separately confirmed publication intent",
    "obtain a separate",
    "After that confirmation",
)


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def normalized(relative: str) -> str:
    return " ".join(read(relative).split())


class SkillSurfaceContract(unittest.TestCase):
    def test_both_surfaces_carry_the_authorization_through_to_the_tag(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                prose = normalized(surface)
                self.assertIn("confirmed Semver authorizes", prose)
                self.assertIn("tag and publish", prose)
                self.assertIn("without asking again", prose)

    def test_no_surface_reinstates_a_second_confirmation_gate(self):
        for surface in SURFACES:
            for phrase in SECOND_GATE:
                with self.subTest(surface=surface, phrase=phrase):
                    self.assertNotIn(phrase, normalized(surface))

    def test_autonomy_never_drops_the_safety_framing(self):
        """Tagging stays irreversible and gated — the gates just move earlier."""
        for surface in SURFACES:
            with self.subTest(surface=surface):
                prose = normalized(surface)
                self.assertIn("irreversible", prose)
                self.assertIn("cannot be reused", prose)
                for gate in ("release:guard", "kit:staleness", "npm pack"):
                    self.assertIn(gate, prose)

    def test_the_tag_remains_the_sole_publication_intent(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                prose = normalized(surface)
                self.assertIn("Merging integrates", prose)
                self.assertIn("annotated", prose)

    def test_both_surfaces_stay_mirrored_below_the_frontmatter(self):
        bodies = [read(surface).split("\n---\n", 1)[1] for surface in SURFACES]
        self.assertEqual(bodies[0], bodies[1])


class ProjectDoctrineContract(unittest.TestCase):
    def test_root_convention_files_agree_with_the_skill(self):
        for name in DOCTRINE_FILES:
            with self.subTest(document=name):
                prose = normalized(name)
                self.assertIn("confirmed Semver authorizes", prose)
                for phrase in SECOND_GATE:
                    self.assertNotIn(phrase, prose)

    def test_the_adr_records_an_amendment_instead_of_a_silent_rewrite(self):
        prose = normalized(ADR)
        self.assertIn("Amended", prose)
        self.assertIn("2026-07-25", prose)
        self.assertIn("confirmed Semver authorizes", prose)
        # The original decision must remain readable, not be overwritten.
        self.assertIn("version tag", prose)


if __name__ == "__main__":
    unittest.main()
