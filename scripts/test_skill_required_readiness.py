#!/usr/bin/env python3
"""Focused contract tests for required operational-skill readiness gates."""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILLS = {
    "triage": ("issueTracker", "managedBoard", "triageLabels"),
    "local-ci": ("localCiRecipe",),
    "project-release": ("projectReleaseProfile",),
    "security-audit": ("securityAuditRunbook",),
}


def write(root: Path, relative: str, body: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def snapshot(root: Path) -> dict[str, bytes]:
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    }


def check(root: Path, skill: str) -> dict:
    run = subprocess.run(
        [
            "node",
            str(ROOT / "scripts/readiness.mjs"),
            "check",
            "--skill",
            skill,
            "--json",
            "--root",
            str(root),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(run.stdout)


def seed_manifest(root: Path, decisions: dict[str, str] | None = None) -> None:
    write(
        root,
        ".claude/skills/skill-manifest.json",
        (ROOT / ".claude/skills/skill-manifest.json").read_text(encoding="utf-8"),
    )
    write(
        root,
        "agent-workflow-kit.json",
        json.dumps(
            {
                "kitVersion": "fixture",
                "readinessContractVersion": 1,
                "readinessDecisions": decisions or {},
                "installed": [],
            }
        ),
    )


def seed_valid_evidence(root: Path) -> None:
    sentinel = "<!-- setup-workflow: state=filled -->\nconfigured\n"
    write(root, "docs/agents/issue-tracker.md", sentinel)
    write(root, "docs/agents/triage-labels.md", sentinel)
    board = {
        "repo": "owner/repo",
        "project": {"owner": "owner", "number": 1, "nodeId": "project"},
        "fields": {
            "status": {
                "id": "status",
                "options": {"Done": "done"},
                "roles": {"done": "Done"},
            },
            "wave": "wave",
            "cluster": "cluster",
        },
        "labels": {"readyForAgent": "ready-for-agent"},
    }
    write(
        root,
        "docs/agents/board-sync.md",
        f"<!-- board-sync:profile -->\n```json\n{json.dumps(board)}\n```\n",
    )
    write(root, "docs/agents/skills/local-ci.md", sentinel)
    write(
        root,
        "docs/agents/workflow-capabilities.json",
        json.dumps(
            {
                "schemaVersion": 1,
                "projectRelease": {
                    "versionFiles": ["package.json"],
                    "tagPrefix": "v",
                },
            }
        ),
    )
    write(
        root,
        "docs/agents/skills/security-audit.md",
        "<!-- setup-workflow: state=filled -->\n"
        "Use `docs/security/audit-runbook.md`.\n",
    )
    write(root, "docs/security/audit-runbook.md", "# Audit\nConcrete checks.\n")


def readiness_section(body: str) -> str:
    match = re.search(
        r"^## Required readiness preflight\n[\s\S]*?(?=^## |\Z)", body, re.MULTILINE
    )
    if not match:
        raise AssertionError("required readiness preflight section is missing")
    return match.group(0).strip()


class RequiredReadinessSkillTests(unittest.TestCase):
    def test_every_operational_skill_gates_before_mutation(self) -> None:
        first_mutation = {
            "triage": "## Triage a specific issue",
            "local-ci": "## The two profiles",
            "project-release": "## Workflow",
            "security-audit": "## Workflow — two-model run",
        }
        for skill, capabilities in SKILLS.items():
            with self.subTest(skill=skill):
                body = (ROOT / ".claude/skills" / skill / "SKILL.md").read_text(
                    encoding="utf-8"
                )
                heading = "## Required readiness preflight"
                self.assertIn(heading, body)
                self.assertLess(body.index(heading), body.index(first_mutation[skill]))
                self.assertIn(
                    f"node scripts/readiness.mjs check --skill {skill} --json", body
                )
                for capability in capabilities:
                    self.assertIn(f"`{capability}`", body)
                for state in ("missing", "pending", "not-applicable", "invalid"):
                    self.assertIn(f"`{state}`", body)
                self.assertIn("verdict is silent", body)
                self.assertIn("Never ", body)
                mirror = (ROOT / ".agents/skills" / skill / "SKILL.md").read_text(
                    encoding="utf-8"
                )
                self.assertEqual(readiness_section(mirror), readiness_section(body))

        project_release = (
            ROOT / ".claude/skills/project-release/SKILL.md"
        ).read_text(encoding="utf-8")
        preflight = project_release.index(
            "node scripts/readiness.mjs check --skill project-release --json"
        )
        helper = project_release.index("node scripts/project-release.mjs preview")
        self.assertLess(preflight, helper)
        self.assertIn("helper remains the authority", project_release)

    def test_helper_blocks_missing_prerequisites_without_side_effects(self) -> None:
        for skill, capabilities in SKILLS.items():
            with self.subTest(skill=skill), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                seed_manifest(root)
                before = snapshot(root)
                result = check(root, skill)
                self.assertEqual(result["verdict"], "blocked")
                self.assertEqual(
                    {name: result["capabilities"][name]["state"] for name in capabilities},
                    {name: "missing" for name in capabilities},
                )
                self.assertEqual(snapshot(root), before)

    def test_helper_distinguishes_pending_not_applicable_invalid_and_ready(self) -> None:
        invalid_evidence = {
            "triage": ("docs/agents/issue-tracker.md", "<!-- setup-workflow: state=stub -->\n"),
            "local-ci": ("docs/agents/skills/local-ci.md", "<!-- setup-workflow: state=stub -->\n"),
            "project-release": ("docs/agents/workflow-capabilities.json", "{}\n"),
            "security-audit": (
                "docs/agents/skills/security-audit.md",
                "<!-- setup-workflow: state=filled -->\nno project runbook\n",
            ),
        }
        for skill, capabilities in SKILLS.items():
            capability = capabilities[0]
            with self.subTest(skill=skill, state="pending"), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                seed_manifest(root, {capability: "pending"})
                self.assertEqual(check(root, skill)["capabilities"][capability]["state"], "pending")

            with self.subTest(skill=skill, state="invalid"), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                seed_manifest(root)
                seed_valid_evidence(root)
                write(root, *invalid_evidence[skill])
                result = check(root, skill)
                self.assertEqual(result["verdict"], "blocked")
                self.assertEqual(result["capabilities"][capability]["state"], "invalid")

            with self.subTest(skill=skill, state="ready"), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                seed_manifest(root)
                seed_valid_evidence(root)
                before = snapshot(root)
                result = check(root, skill)
                self.assertEqual(result["verdict"], "ready")
                self.assertTrue(
                    all(item["state"] == "ready" for item in result["capabilities"].values())
                )
                self.assertEqual(snapshot(root), before)

        with self.subTest(skill="triage", state="not-applicable"), tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            seed_manifest(root, {"managedBoard": "not-applicable"})
            seed_valid_evidence(root)
            (root / "docs/agents/board-sync.md").unlink()
            result = check(root, "triage")
            self.assertEqual(result["verdict"], "blocked")
            self.assertEqual(result["capabilities"]["managedBoard"]["state"], "not-applicable")


if __name__ == "__main__":
    unittest.main()
