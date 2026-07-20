#!/usr/bin/env python3
"""Manifest-derived readiness declaration and marker grammar guard."""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / ".claude/skills/skill-manifest.json"
START = re.compile(r"^<!-- readiness:block ([a-z][A-Za-z0-9]*) -->$")
END = "<!-- readiness:end -->"
SURFACE = {"claude": ".claude/skills", "codex": ".agents/skills"}
REQUIRED = {
    "to-prd": ["issueTracker", "managedBoard"],
    "to-issues": ["issueTracker", "managedBoard", "specCompleteness"],
    "to-waves": ["issueTracker", "managedBoard", "specCompleteness"],
    "board-to-waves": ["issueTracker", "managedBoard"],
    "triage": ["issueTracker", "managedBoard", "triageLabels"],
    "orchestrate-wave": ["issueTracker", "managedBoard"],
    "local-ci": ["localCiRecipe"],
    "project-release": ["projectReleaseProfile"],
    "security-audit": ["securityAuditRunbook"],
}
OPTIONAL = {
    "wrapup": {"deployReport": "prodTarget"},
    "orchestrate-wave": {"projectRecipe": "orchestrateWaveRecipe"},
    "spec-self-critique": {"projectEnrichment": "specCritiqueLayer"},
    "code-review": {"projectEnrichment": "codeReviewLayer"},
    "verify-spike": {"projectPlacement": "verifySpikeLayer"},
    "audit-skills": {"projectChecks": "auditSkillsLayer"},
    "git-worktree-recover": {"projectRecovery": "worktreeRecoveryLayer"},
}


def load_manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def marker_sequence(body: str, declared: set[str]) -> list[str]:
    sequence: list[str] = []
    active: str | None = None
    seen: set[str] = set()
    for number, line in enumerate(body.splitlines(), 1):
        match = START.fullmatch(line)
        if match:
            block = match.group(1)
            if active:
                raise AssertionError(f"nested readiness block at line {number}")
            if block in seen:
                raise AssertionError(f"duplicate readiness block {block}")
            if block not in declared:
                raise AssertionError(f"unknown readiness block {block}")
            active = block
            seen.add(block)
            sequence.append(block)
        elif line == END:
            if not active:
                raise AssertionError(f"unbalanced readiness end at line {number}")
            active = None
        elif "readiness:block" in line or "readiness:end" in line:
            raise AssertionError(f"invalid readiness marker grammar at line {number}")
    if active:
        raise AssertionError(f"unbalanced readiness block {active}")
    return sequence


def validate_surface_sequences(sequences: list[list[str]]) -> None:
    if any(sequence != sequences[0] for sequence in sequences[1:]):
        raise AssertionError("cross-surface readiness marker drift")


class ReadinessContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = load_manifest()
        self.catalog = self.manifest["readiness"]["capabilities"]
        self.published = {
            name: entry for name, entry in self.manifest["skills"].items()
            if entry.get("publish")
        }

    def test_contract_and_skill_denominator_come_from_publish_manifest(self) -> None:
        self.assertEqual(self.manifest["readiness"]["contractVersion"], 1)
        manifest_source = (ROOT / "src/lib/manifest.mjs").read_text(encoding="utf-8")
        version = re.search(r"READINESS_CONTRACT_VERSION = (\d+);", manifest_source)
        self.assertIsNotNone(version)
        self.assertEqual(int(version.group(1)), self.manifest["readiness"]["contractVersion"])
        self.assertGreater(len(self.published), 0)
        for name, entry in self.published.items():
            self.assertTrue(entry.get("surfaces"), name)

    def test_every_declaration_references_the_single_capability_catalog(self) -> None:
        for skill, entry in self.published.items():
            declaration = entry.get("readiness", {})
            references = list(declaration.get("required", []))
            references += list(declaration.get("optionalBlocks", {}).values())
            for capability in references:
                self.assertIn(capability, self.catalog, f"{skill}: {capability}")
            blocks = list(declaration.get("optionalBlocks", {}))
            self.assertEqual(len(blocks), len(set(blocks)), skill)

    def test_initial_enforcement_mapping_is_exact(self) -> None:
        for skill, required in REQUIRED.items():
            self.assertEqual(self.published[skill]["readiness"]["required"], required)
        for skill, blocks in OPTIONAL.items():
            self.assertEqual(self.published[skill]["readiness"]["optionalBlocks"], blocks)

    def test_markers_are_balanced_declared_and_surface_equal_when_activated(self) -> None:
        for skill, entry in self.published.items():
            declared = set(entry.get("readiness", {}).get("optionalBlocks", {}))
            sequences: list[tuple[str, list[str]]] = []
            for surface in entry["surfaces"]:
                path = ROOT / SURFACE[surface] / skill / "SKILL.md"
                self.assertTrue(path.is_file(), f"missing published surface: {path}")
                sequence = marker_sequence(path.read_text(encoding="utf-8"), declared)
                sequences.append((surface, sequence))
            if len(sequences) > 1:
                validate_surface_sequences([sequence for _, sequence in sequences])

    def test_marker_parser_rejects_each_structural_failure(self) -> None:
        declared = {"projectEnrichment"}
        bad = [
            "<!-- readiness:block projectEnrichment -->\n<!-- readiness:block projectEnrichment -->",
            "<!-- readiness:block projectEnrichment -->\n<!-- readiness:end -->\n<!-- readiness:block projectEnrichment -->",
            "<!-- readiness:end -->",
            "<!-- readiness:block projectEnrichment -->",
            "<!-- readiness:block unknownBlock -->\n<!-- readiness:end -->",
            " <!-- readiness:block projectEnrichment -->",
        ]
        for body in bad:
            with self.subTest(body=body), self.assertRaises(AssertionError):
                marker_sequence(body, declared)
        with self.assertRaises(AssertionError):
            validate_surface_sequences([["projectEnrichment"], []])


if __name__ == "__main__":
    unittest.main()
