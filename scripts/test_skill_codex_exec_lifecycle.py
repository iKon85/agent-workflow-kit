"""Guard the Claude-only cross-model skills' codex-exec lifecycle contract."""

import json
import re
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
MANIFEST = REPO / ".claude/skills/skill-manifest.json"
TARGETS = {
    "codex-review": ("review", "read-only"),
    "codex-build": ("build", "workspace-write"),
    "grill-me-codex": ("review", "read-only"),
    "grill-with-docs-codex": ("review", "read-only"),
}


class CodexExecSkillLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))["skills"]
        cls.skills = {}
        for name, expected in TARGETS.items():
            entry = manifest[name]
            if entry["surfaces"] != ["claude"]:
                raise AssertionError(f"{name} must remain Claude-only")
            path = REPO / ".claude/skills" / name / "SKILL.md"
            cls.skills[name] = (expected, path.read_text(encoding="utf-8"))

    def test_all_four_skills_use_the_wrapper_lifecycle(self):
        self.assertEqual(len(self.skills), 4)
        for name, ((profile, mode), body) in self.skills.items():
            with self.subTest(skill=name):
                self.assertIn(
                    f"scripts/codex-exec.sh new --profile {profile} --mode {mode}",
                    body,
                )
                self.assertRegex(body, r"scripts/codex-exec\.sh resume [\"']?\$RUN_ID")
                self.assertRegex(body, r"scripts/codex-exec\.sh finalize [\"']?\$RUN_ID")
                self.assertRegex(body, r"scripts/codex-exec\.sh abort [\"']?\$RUN_ID")
                self.assertNotRegex(
                    body,
                    r"scripts/codex-exec\.sh resume[^\n]*--mode",
                    "resume must inherit the persisted mode",
                )

    def test_no_skill_reimplements_codex_process_mechanics(self):
        forbidden = {
            "raw codex exec": re.compile(r"(?m)^\s*codex\s+exec\b"),
            "manual liveness sleep": re.compile(r"\bsleep\s+90\b"),
            "manual sandbox override": re.compile(r"\bsandbox_mode\s*="),
            "manual process probe": re.compile(r"\bkill\s+-0\b"),
            "manual codex pid": re.compile(r"\bCODEX_PID\b"),
        }
        for name, (_, body) in self.skills.items():
            for label, pattern in forbidden.items():
                with self.subTest(skill=name, forbidden=label):
                    self.assertIsNone(pattern.search(body))


if __name__ == "__main__":
    unittest.main()
