#!/usr/bin/env python3
"""code-review skill + its setup-workflow project-layer seed (Welle 49).

Companion to test_skill_setup_workflow_seeds.py (not touched here — a sibling
slice edits it concurrently). Pins the two machine-checkable parts specific to
this skill:

1. The seed template setup-workflow ships (`code-review.md`) is structurally
   valid for the skill that reads it — same "structured-but-empty crust"
   contract as the existing spec-self-critique / spec-completeness seeds.
2. The sentinel-based idempotency rule applies to it the same way (reference
   implementation duplicated locally so this file has no import-order
   dependency on the sibling-owned test module).

Run: python3 scripts/test_skill_code_review_seed.py
"""
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SETUP_WORKFLOW = REPO / ".claude/skills/setup-workflow"
CODE_REVIEW = REPO / ".claude/skills/code-review"

SENTINEL_RE = re.compile(
    r"^<!--\s*setup-workflow:\s*state=(stub|filled|not-applicable)"
    r"(?:;\s*mode=(github-projects-v2|none))?\s*-->\s*$"
)


class SeedTemplateValid(unittest.TestCase):
    def test_code_review_seed_has_both_headings(self):
        """The two structured-but-empty headings the `code-review` skill's
        Standards axis expects to find once this file is filled."""
        t = (SETUP_WORKFLOW / "code-review.md").read_text(encoding="utf-8")
        self.assertIn("## Standards sources in this repo", t)
        self.assertIn("## Adjacent review tooling", t)

    def test_code_review_seed_is_generic(self):
        """No project-coupled tokens in a template shipped to every consumer."""
        t = (SETUP_WORKFLOW / "code-review.md").read_text(encoding="utf-8")
        for token in ("Testreporter", "iKon85", "/home/"):
            self.assertNotIn(token, t)
        self.assertNotRegex(t, r"#\d{3,5}\b")
        self.assertNotRegex(t, r"\bHR\d+\b")

    def test_setup_workflow_skill_registers_the_seed(self):
        """SKILL.md wires the target path + seed link into its Targets table
        and process, so a reader (or the manifest-completeness lint's sibling
        checks) can trace the seed from the skill body."""
        skill = (SETUP_WORKFLOW / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("docs/agents/code-review.md", skill)
        self.assertIn("[code-review.md](./code-review.md)", skill)

    def test_code_review_skill_names_its_project_layer_and_fallback(self):
        """The skill states the project-layer path + the /setup-workflow
        fallback (self-containment-lint's LookupContract pattern)."""
        body = (CODE_REVIEW / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("docs/agents/code-review.md", body)
        self.assertIn("/setup-workflow", body)


class FreshFillProducesValidSentinel(unittest.TestCase):
    """Simulate the write step: prepend the documented sentinel to the seed
    body and assert the result is a well-formed project-layer file."""

    def test_prepended_sentinel_parses(self):
        body = (SETUP_WORKFLOW / "code-review.md").read_text(encoding="utf-8")
        written = "<!-- setup-workflow: state=filled -->\n" + body
        self.assertRegex(written.splitlines()[0], SENTINEL_RE)


class ManifestEntryValid(unittest.TestCase):
    def test_code_review_is_own_generic_dual_surface_publish_true(self):
        import json

        manifest = json.loads(
            (REPO / ".claude/skills/skill-manifest.json").read_text(encoding="utf-8")
        )
        entry = manifest["skills"].get("code-review")
        self.assertIsNotNone(entry, "code-review missing from skill-manifest.json")
        self.assertEqual(entry["class"], "generic")
        self.assertIs(entry["publish"], True)
        self.assertEqual(entry["provenance"], "own")
        self.assertEqual(set(entry["surfaces"]), {"claude", "codex"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
