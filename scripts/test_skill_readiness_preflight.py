#!/usr/bin/env python3
"""Behavior contract for required-readiness planning preflights."""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
READINESS = ROOT / "scripts/readiness.mjs"
MANIFEST = ROOT / ".claude/skills/skill-manifest.json"
SKILLS = ("to-prd", "to-issues", "to-waves", "board-to-waves")
SPEC_SKILLS = ("to-issues", "to-waves")
PREFLIGHT_START = "<!-- readiness:required-preflight:start -->"
PREFLIGHT_END = "<!-- readiness:required-preflight:end -->"


def write(root: Path, relative: str, body: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def configure_issue_tracker(root: Path) -> None:
    write(
        root,
        "docs/agents/issue-tracker.md",
        "<!-- setup-workflow: state=filled -->\nGitHub Issues.\n",
    )


def configure_board(root: Path) -> None:
    profile = {
        "repo": "owner/repo",
        "project": {"owner": "owner", "number": 1, "nodeId": "project"},
        "fields": {
            "status": {
                "id": "status",
                "options": {"Todo": "todo"},
                "roles": {"triaged": "Todo"},
            },
            "wave": "wave",
            "cluster": "cluster",
        },
        "labels": {"readyForAgent": "ready-for-agent"},
    }
    write(
        root,
        "docs/agents/board-sync.md",
        "<!-- board-sync:profile -->\n```json\n"
        f"{json.dumps(profile)}\n```\n",
    )


def configure_spec_completeness(root: Path) -> None:
    write(
        root,
        "docs/conventions/spec-completeness.md",
        "<!-- setup-workflow: state=filled -->\nVertical slice rules.\n",
    )


class PlanningReadinessPreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        write(
            self.root,
            ".claude/skills/skill-manifest.json",
            MANIFEST.read_text(encoding="utf-8"),
        )
        write(
            self.root,
            "agent-workflow-kit.json",
            json.dumps({
                "kitVersion": "0.0.0-test",
                "readinessContractVersion": 1,
                "readinessDecisions": {},
                "installed": [],
            }),
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def check(self, skill: str) -> dict:
        completed = subprocess.run(
            ["node", str(READINESS), "check", "--skill", skill, "--json", "--root", str(self.root)],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(completed.stdout)

    def snapshot(self) -> dict[Path, bytes]:
        return {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*") if path.is_file()
        }

    def test_missing_requirements_block_without_writing_fixture(self) -> None:
        before = self.snapshot()
        for skill in SKILLS:
            with self.subTest(skill=skill):
                result = self.check(skill)
                self.assertEqual(result["verdict"], "blocked")
                self.assertEqual(result["capabilities"]["issueTracker"]["state"], "missing")
                self.assertEqual(result["capabilities"]["managedBoard"]["state"], "missing")
        self.assertEqual(self.snapshot(), before)

    def test_invalid_requirement_is_visible_and_check_remains_read_only(self) -> None:
        configure_board(self.root)
        configure_spec_completeness(self.root)
        write(
            self.root,
            "docs/agents/issue-tracker.md",
            "<!-- setup-workflow: state=stub -->\npartial\n",
        )
        before = self.snapshot()
        result = self.check("to-prd")
        self.assertEqual(result["verdict"], "blocked")
        self.assertEqual(result["capabilities"]["issueTracker"]["state"], "invalid")
        self.assertEqual(self.snapshot(), before)

    def test_managed_board_not_applicable_makes_every_board_writer_inapplicable(self) -> None:
        configure_issue_tracker(self.root)
        configure_spec_completeness(self.root)
        manifest = json.loads((self.root / "agent-workflow-kit.json").read_text(encoding="utf-8"))
        manifest["readinessDecisions"]["managedBoard"] = "not-applicable"
        write(self.root, "agent-workflow-kit.json", json.dumps(manifest))
        for skill in SKILLS:
            with self.subTest(skill=skill):
                result = self.check(skill)
                self.assertEqual(result["verdict"], "blocked")
                self.assertEqual(
                    result["capabilities"]["managedBoard"]["state"],
                    "not-applicable",
                )

    def test_spec_completeness_blocks_only_the_slicing_flows(self) -> None:
        configure_issue_tracker(self.root)
        configure_board(self.root)
        for skill in SKILLS:
            with self.subTest(skill=skill):
                result = self.check(skill)
                expected = "blocked" if skill in SPEC_SKILLS else "ready"
                self.assertEqual(result["verdict"], expected)
                if skill in SPEC_SKILLS:
                    self.assertEqual(
                        result["capabilities"]["specCompleteness"]["state"],
                        "missing",
                    )

    def test_ready_state_and_skill_prose_share_one_silent_first_step(self) -> None:
        configure_issue_tracker(self.root)
        configure_board(self.root)
        configure_spec_completeness(self.root)
        for skill in SKILLS:
            with self.subTest(skill=skill):
                self.assertEqual(self.check(skill)["verdict"], "ready")
                source = (ROOT / ".claude/skills" / skill / "SKILL.md").read_text(encoding="utf-8")
                mirror = (ROOT / ".agents/skills" / skill / "SKILL.md").read_text(encoding="utf-8")
                source_block = source.split(PREFLIGHT_START, 1)[1].split(PREFLIGHT_END, 1)[0]
                mirror_block = mirror.split(PREFLIGHT_START, 1)[1].split(PREFLIGHT_END, 1)[0]
                self.assertEqual(source_block, mirror_block)
                self.assertIn(f"node scripts/readiness.mjs check --skill {skill} --json", source_block)
                self.assertIn("before any remote write", source_block)
                self.assertIn("Ready is silent", source_block)
                self.assertIn("Run `/setup-workflow`, then rerun", source_block)
                first_mutation = min(
                    position for token in ("board-sync.py create", "gh issue edit")
                    if (position := source.find(token)) >= 0
                )
                self.assertLess(source.find(PREFLIGHT_START), first_mutation)


if __name__ == "__main__":
    unittest.main()
