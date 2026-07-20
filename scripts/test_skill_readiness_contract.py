#!/usr/bin/env python3
"""Manifest-derived readiness declaration and marker grammar guard."""
from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / ".claude/skills/skill-manifest.json"
START = re.compile(r"^<!-- readiness:block ([a-z][A-Za-z0-9]*) -->$")
END = "<!-- readiness:end -->"
SURFACE = {"claude": ".claude/skills", "codex": ".agents/skills"}
FIXTURES = ROOT / "test/fixtures/readiness"
REQUIRED_V1 = {
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
OPTIONAL_V1 = {
    "wrapup": {"deployReport": "prodTarget"},
    "orchestrate-wave": {"projectRecipe": "orchestrateWaveRecipe"},
    "spec-self-critique": {"projectEnrichment": "specCritiqueLayer"},
    "code-review": {"projectEnrichment": "codeReviewLayer"},
    "verify-spike": {"projectPlacement": "verifySpikeLayer"},
    "audit-skills": {"projectChecks": "auditSkillsLayer"},
    "git-worktree-recover": {"projectRecovery": "worktreeRecoveryLayer"},
}
COMPAT_UPDATE_SCRIPT = r"""
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [repo, fixturePath] = process.argv.slice(-2);
const load = async (path) => import(pathToFileURL(join(repo, path)));
const { init } = await load('src/commands/init.mjs');
const { update } = await load('src/commands/update.mjs');
const { checkSkill } = await load('scripts/readiness.mjs');
const { makeKit, makeEmptyDir, cleanup } = await load('test/helpers.mjs');
const { PACKAGE_MANIFEST_NAME, readManifest, writeManifest } = await load('src/lib/manifest.mjs');
const { sha256 } = await load('src/lib/hash.mjs');
const readinessPath = '.claude/skills/skill-manifest.json';
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const current = JSON.parse(await readFile(join(repo, readinessPath), 'utf8'));
const previous = structuredClone(current);
for (const skill of Object.keys(fixture.readinessFixture.skills)) {
  previous.skills[skill].readiness = {};
}
const kit = await makeKit({ '.claude/skills/to-prd/SKILL.md': 'fixture\n' });
const consumer = await makeEmptyDir();
async function setKitReadiness(manifest) {
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  const path = join(kit, readinessPath);
  await mkdir(join(kit, '.claude/skills'), { recursive: true });
  await writeFile(path, content);
  const pkg = await readManifest(join(kit, PACKAGE_MANIFEST_NAME));
  const entry = pkg.files.find(({ path: candidate }) => candidate === readinessPath);
  if (entry) entry.sha256 = sha256(content);
  else pkg.files.push({ path: readinessPath, kind: 'doc', sha256: sha256(content), mode: 0o644, origin: 'kit' });
  await writeManifest(join(kit, PACKAGE_MANIFEST_NAME), pkg);
}
try {
  await setKitReadiness(previous);
  await init({ kitRoot: kit, consumerRoot: consumer });
  for (const [relative, body] of Object.entries(fixture.readinessFixture.evidence)) {
    const path = join(consumer, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
  }
  const manifestPath = join(consumer, 'agent-workflow-kit.json');
  const installed = await readManifest(manifestPath);
  await writeManifest(manifestPath, {
    ...installed,
    readinessDecisions: fixture.readinessDecisions ?? {},
    readinessFixture: fixture.readinessFixture,
  });
  const before = {};
  for (const skill of Object.keys(fixture.readinessFixture.skills)) {
    before[skill] = await checkSkill({ root: consumer, skill, manifest: previous });
  }
  await setKitReadiness(current);
  const identity = { name: '@ikon85/agent-workflow-kit', version: '0.1.0', tarballIntegrity: 'sha512-fixture', manifestSha256: 'fixture-manifest' };
  const result = await update({
    kitRoot: kit, consumerRoot: consumer,
    releaseIdentities: { installed: { name: identity.name, version: identity.version, manifestSha256: identity.manifestSha256 }, npm: identity, github: identity },
    verify: async () => {},
  });
  const afterManifest = await readManifest(manifestPath);
  const after = {};
  for (const skill of Object.keys(fixture.readinessFixture.skills)) {
    after[skill] = await checkSkill({ root: consumer, skill, manifest: current });
  }
  console.log(JSON.stringify({ before, result, afterManifest, after }));
} finally {
  await cleanup(kit, consumer);
}
"""


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

    def test_locked_v1_policy_cannot_disappear_from_the_manifest(self) -> None:
        actual_required = {
            skill: entry["readiness"]["required"]
            for skill, entry in self.published.items()
            if entry.get("readiness", {}).get("required")
        }
        actual_optional = {
            skill: entry["readiness"]["optionalBlocks"]
            for skill, entry in self.published.items()
            if entry.get("readiness", {}).get("optionalBlocks")
        }
        self.assertEqual(actual_required, REQUIRED_V1)
        self.assertEqual(actual_optional, OPTIONAL_V1)

    def test_every_declared_consumer_has_the_standard_preflight(self) -> None:
        consumers = {
            skill: entry for skill, entry in self.published.items()
            if entry.get("readiness")
        }
        self.assertGreater(len(consumers), 0)
        for skill, entry in consumers.items():
            expected = f"node scripts/readiness.mjs check --skill {skill} --json"
            for surface in entry["surfaces"]:
                path = ROOT / SURFACE[surface] / skill / "SKILL.md"
                body = path.read_text(encoding="utf-8")
                self.assertEqual(body.count(expected), 1, f"{surface}:{skill}")

    def test_markers_are_balanced_declared_and_surface_equal_when_activated(self) -> None:
        for skill, entry in self.published.items():
            declared = set(entry.get("readiness", {}).get("optionalBlocks", {}))
            sequences: list[tuple[str, list[str]]] = []
            for surface in entry["surfaces"]:
                path = ROOT / SURFACE[surface] / skill / "SKILL.md"
                self.assertTrue(path.is_file(), f"missing published surface: {path}")
                sequence = marker_sequence(path.read_text(encoding="utf-8"), declared)
                self.assertEqual(set(sequence), declared, f"undeclared marker coverage: {surface}:{skill}")
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

    def test_legacy_and_current_consumers_keep_previously_ready_skill_cores(self) -> None:
        fixtures = sorted(FIXTURES.glob("*/agent-workflow-kit.json"))
        self.assertEqual([path.parent.name for path in fixtures], ["current", "legacy"])
        for fixture_path in fixtures:
            fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
            scenario = fixture["readinessFixture"]
            with self.subTest(fixture=fixture_path.parent.name):
                run = subprocess.run(
                    ["node", "--input-type=module", "-e", COMPAT_UPDATE_SCRIPT,
                     str(ROOT), str(fixture_path)],
                    check=True, capture_output=True, text=True,
                )
                proof = json.loads(run.stdout)
                self.assertEqual(proof["result"]["state"], "applied")
                self.assertEqual(proof["result"]["availability"]["newlyBlocked"], [])
                for skill, expected in scenario["skills"].items():
                    self.assertEqual(proof["before"][skill]["verdict"], "ready", skill)
                    verdict = proof["after"][skill]
                    self.assertNotEqual(verdict["verdict"], "blocked", skill)
                    self.assertEqual(verdict["verdict"], expected["verdict"], skill)
                    self.assertEqual(verdict["inactiveBlocks"], expected["inactiveBlocks"], skill)
                self.assertEqual(
                    proof["afterManifest"].get("readinessDecisions", {}),
                    scenario["expectedDecisions"],
                    "unavailable behavior must not manufacture a decision",
                )
                self.assertEqual(proof["afterManifest"]["readinessFixture"], scenario)


if __name__ == "__main__":
    unittest.main()
