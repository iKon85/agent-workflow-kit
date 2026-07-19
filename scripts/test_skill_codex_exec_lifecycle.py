"""Guard the Claude-only cross-model skills' thin codex-exec lifecycle."""

import json
import re
import subprocess
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

    def test_all_four_skills_use_the_thin_wrapper_lifecycle(self):
        self.assertEqual(len(self.skills), 4)
        for name, ((profile, mode), body) in self.skills.items():
            with self.subTest(skill=name):
                self.assertIn(
                    f"scripts/codex-exec.sh new --profile {profile} --mode {mode}",
                    body,
                )
                self.assertRegex(body, r"scripts/codex-exec\.sh resume [\"']?\$RUN_ID")
                self.assertRegex(body, r"scripts/codex-exec\.sh finalize [\"']?\$RUN_ID")
                self.assertEqual(body.count("scripts/codex-exec.sh handle-failure"), 2)
                self.assertNotRegex(
                    body,
                    r"scripts/codex-exec\.sh resume[^\n]*--mode",
                    "resume must inherit the persisted mode",
                )

    def test_new_and_resume_are_thin_ordered_and_valid_bash(self):
        for name, (_, body) in self.skills.items():
            blocks = re.findall(
                r"```bash\n(if ROUND_RESULT=\$\(scripts/codex-exec\.sh (?:new|resume).*?\nfi)\n```",
                body,
                re.DOTALL,
            )
            self.assertEqual(len(blocks), 2, name)
            for block in blocks:
                first_line = block.splitlines()[0]
                is_resume = "scripts/codex-exec.sh resume " in first_line
                success, failure = block.split("\nelse\n", 1)
                self.assertIn("CODEX_REPORT=", success)
                self.assertNotIn("CODEX_REPORT=", failure)
                self.assertIn("scripts/codex-exec.sh handle-failure", failure)
                self.assertIn("|| :", failure)
                self.assertNotIn("json.load", failure)
                handler = failure.index("handle-failure")
                surfaced = failure.index('printf \'%s\\n\' "$FAILURE_RESULT" >&2')
                stopped = failure.index("exit 1")
                self.assertLess(handler, surfaced)
                self.assertLess(surfaced, stopped)
                if is_resume:
                    self.assertIn('--run-id "$RUN_ID"', failure)
                    self.assertNotIn("\n  RUN_ID=", success)
                else:
                    self.assertNotIn("--run-id", failure)
                    self.assertLess(success.index("RUN_ID="), success.index("CODEX_REPORT="))
                parsed = subprocess.run(
                    ["bash", "-n"],
                    input=block,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(parsed.returncode, 0, parsed.stderr)

    def test_all_skills_abort_known_run_on_orchestration_cancellation(self):
        for name, (_, body) in self.skills.items():
            with self.subTest(skill=name):
                cancellation = re.search(
                    r"[Cc]ancellation or a decision to stop (?:orchestration|delegation)"
                    r".*?scripts/codex-exec\.sh abort \"\$RUN_ID\"",
                    body,
                    re.DOTALL,
                )
                self.assertIsNotNone(cancellation)
                self.assertRegex(body, r"scripts/codex-exec\.sh finalize [\"']?\$RUN_ID")

        build = self.skills["codex-build"][1]
        gate = build.split("## Step 5 — Human gate", 1)[1].split("## Hard rules", 1)[0]
        self.assertLess(
            gate.index("Rejected with another requested fix"),
            gate.index("Cancellation or a decision to stop delegation"),
        )

    def test_no_skill_reimplements_codex_process_or_failure_mechanics(self):
        forbidden = {
            "copied round function": re.compile(r"\brun_codex_round\b"),
            "copied status parser": re.compile(r"\bROUND_STATUS\b|\.get\(\"status\""),
            "copied run-id cleanup": re.compile(r"\bFAILED_RUN_ID\b"),
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
