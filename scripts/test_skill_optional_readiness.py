#!/usr/bin/env python3
"""Behavior contract for optional review and spike readiness layers."""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
READINESS = ROOT / "scripts/readiness.mjs"
MANIFEST = ROOT / ".claude/skills/skill-manifest.json"
SURFACES = (".claude/skills", ".agents/skills")
SKILLS = {
    "spec-self-critique": {
        "block": "projectEnrichment",
        "capability": "specCritiqueLayer",
        "path": "docs/agents/skills/spec-self-critique.md",
        "core": ("## The 12-point checklist", "Self-Critique complete"),
        "enrichment": ("per-point enrichment", "project-specific incidents"),
    },
    "code-review": {
        "block": "projectEnrichment",
        "capability": "codeReviewLayer",
        "path": "docs/agents/code-review.md",
        "core": ("## Axis 1 — Standards", "## Axis 2 — Spec"),
        "enrichment": ("which sources count", "adjacent tools"),
    },
    "verify-spike": {
        "block": "projectPlacement",
        "capability": "verifySpikeLayer",
        "path": "docs/agents/skills/verify-spike.md",
        "core": ("Frame one falsifiable question", "Delete the harness"),
        "enrichment": ("harness-placement", "import rules"),
    },
}
PREFLIGHT_START = "<!-- readiness:optional-preflight:start -->"
PREFLIGHT_END = "<!-- readiness:optional-preflight:end -->"


def write(root: Path, relative: str, body: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


class OptionalReadinessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        write(
            self.root,
            ".claude/skills/skill-manifest.json",
            MANIFEST.read_text(encoding="utf-8"),
        )
        self.consumer = {
            "kitVersion": "0.0.0-test",
            "readinessContractVersion": 1,
            "readinessDecisions": {},
            "installed": [],
        }
        self.write_consumer()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_consumer(self) -> None:
        write(self.root, "agent-workflow-kit.json", json.dumps(self.consumer))

    def check(self, skill: str) -> dict:
        completed = subprocess.run(
            [
                "node",
                str(READINESS),
                "check",
                "--skill",
                skill,
                "--json",
                "--root",
                str(self.root),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(completed.stdout)

    def test_missing_and_pending_subtract_exactly_one_optional_block(self) -> None:
        for decision in (None, "pending"):
            for skill, contract in SKILLS.items():
                with self.subTest(skill=skill, decision=decision):
                    self.consumer["readinessDecisions"] = {}
                    if decision:
                        self.consumer["readinessDecisions"][contract["capability"]] = decision
                    self.write_consumer()
                    result = self.check(skill)
                    self.assertEqual(result["verdict"], "degraded")
                    self.assertEqual(
                        result["capabilities"][contract["capability"]]["state"],
                        decision or "missing",
                    )
                    self.assertEqual(result["inactiveBlocks"], [contract["block"]])
                    self.assertEqual(result["activeBlocks"], [])

    def test_invalid_enrichment_is_visible_and_never_an_opt_out(self) -> None:
        for skill, contract in SKILLS.items():
            with self.subTest(skill=skill):
                write(
                    self.root,
                    contract["path"],
                    "<!-- setup-workflow: state=stub -->\npartial configuration\n",
                )
                self.consumer["readinessDecisions"][contract["capability"]] = "pending"
                self.write_consumer()
                result = self.check(skill)
                self.assertEqual(result["verdict"], "degraded")
                self.assertEqual(
                    result["capabilities"][contract["capability"]]["state"],
                    "invalid",
                )
                self.assertEqual(result["inactiveBlocks"], [contract["block"]])

    def test_ready_enrichment_activates_the_block(self) -> None:
        for skill, contract in SKILLS.items():
            with self.subTest(skill=skill):
                write(
                    self.root,
                    contract["path"],
                    "<!-- setup-workflow: state=filled -->\nProject guidance.\n",
                )
                self.consumer["readinessDecisions"] = {}
                self.write_consumer()
                result = self.check(skill)
                self.assertEqual(result["verdict"], "ready")
                self.assertEqual(result["activeBlocks"], [contract["block"]])
                self.assertEqual(result["inactiveBlocks"], [])

    def test_preflight_and_exact_subtraction_match_across_both_surfaces(self) -> None:
        for skill, contract in SKILLS.items():
            blocks = []
            preflights = []
            for surface in SURFACES:
                body = (ROOT / surface / skill / "SKILL.md").read_text(encoding="utf-8")
                start = f"<!-- readiness:block {contract['block']} -->"
                self.assertEqual(body.count(start), 1)
                self.assertEqual(body.count("<!-- readiness:end -->"), 1)
                block = body.split(start, 1)[1].split("<!-- readiness:end -->", 1)[0]
                preflight = body.split(PREFLIGHT_START, 1)[1].split(PREFLIGHT_END, 1)[0]
                generic = body.replace(start + block + "<!-- readiness:end -->", "")
                for anchor in contract["core"]:
                    self.assertIn(anchor, generic)
                for anchor in contract["enrichment"]:
                    self.assertIn(anchor, block)
                self.assertLess(body.index(PREFLIGHT_START), body.index(start))
                self.assertIn(
                    f"node scripts/readiness.mjs check --skill {skill} --json",
                    preflight,
                )
                self.assertIn(f"inactive block `{contract['block']}`", preflight)
                self.assertIn(contract["capability"], preflight)
                self.assertIn("Ready is silent", preflight)
                self.assertIn("Invalid is always visible", preflight)
                blocks.append(block)
                preflights.append(preflight)
            self.assertEqual(blocks[0], blocks[1])
            self.assertEqual(preflights[0], preflights[1])


if __name__ == "__main__":
    unittest.main()
