"""Guard the Claude-only cross-model skills' codex-exec lifecycle contract."""

import json
import os
import re
import subprocess
import tempfile
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
                self.assertRegex(body, r"scripts/codex-exec\.sh abort [\"']?\$FAILED_RUN_ID")
                self.assertNotRegex(
                    body,
                    r"scripts/codex-exec\.sh resume[^\n]*--mode",
                    "resume must inherit the persisted mode",
                )

    def test_guard_orders_failure_cleanup_before_report_extraction(self):
        ordered = (
            'if ROUND_RESULT=$("$@"); then',
            "ROUND_STATUS=",
            'if (( ROUND_EXIT != 0 )) || [[ "$ROUND_STATUS" != OK ]]; then',
            'printf \'%s\\n\' "$ROUND_RESULT" >&2',
            "FAILED_RUN_ID=",
            'if [[ -n "$FAILED_RUN_ID" ]]; then',
            'scripts/codex-exec.sh abort "$FAILED_RUN_ID"',
            "return 1",
            "\n  RUN_ID=",
            "\n  CODEX_REPORT=",
        )
        for name, (_, body) in self.skills.items():
            with self.subTest(skill=name):
                positions = [body.index(token) for token in ordered]
                self.assertEqual(positions, sorted(positions))

    def test_guard_is_set_e_safe_and_handles_structured_outcomes(self):
        for name, (_, body) in self.skills.items():
            match = re.search(
                r"```bash\n(run_codex_round\(\) \{\n.*?\n\})\n```",
                body,
                re.DOTALL,
            )
            self.assertIsNotNone(match, name)
            function = match.group(1)
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                scripts = root / "scripts"
                scripts.mkdir()
                fake = scripts / "codex-exec.sh"
                fake.write_text(
                    """#!/usr/bin/env bash
if [[ "$1" == abort ]]; then
  printf 'abort:%s\\n' "$2" >>"$ACTION_LOG"
  printf '%s\\n' '{"status":"OK","action":"abort"}'
  exit 0
fi
case "$FAKE_SCENARIO" in
  no-run-id)
    printf '%s\\n' '{"status":"AUTH","error":"AUTH_REQUIRED","message":"login required"}'
    exit 1 ;;
  failed-resume)
    printf '%s\\n' '{"status":"AUTH","error":"AUTH_REQUIRED","message":"resume preflight failed"}'
    exit 1 ;;
  hung)
    printf '%s\\n' '{"status":"HUNG","error":"ROUND_FAILED","message":"no pre-thread activity","runId":"hung123"}'
    exit 1 ;;
  ok)
    printf '%s\\n' '{"status":"OK","runId":"ok123","verdict":"final report"}' ;;
esac
""",
                    encoding="utf-8",
                )
                os.chmod(fake, 0o755)
                action_log = root / "actions.log"
                shell = f"""set -euo pipefail
{function}
if [[ "$1" == failed-resume ]]; then
  if run_codex_round scripts/codex-exec.sh resume known123; then
    ROUND_RC=0
  else
    ROUND_RC=$?
  fi
elif run_codex_round scripts/codex-exec.sh new; then
  ROUND_RC=0
else
  ROUND_RC=$?
fi
printf 'rc=%s\\nrun=%s\\nreport=%s\\n' "$ROUND_RC" "${{RUN_ID-}}" "${{CODEX_REPORT-}}"
"""

                def run(scenario):
                    return subprocess.run(
                        ["bash", "-c", shell, "guard-test", scenario],
                        cwd=root,
                        env={
                            **os.environ,
                            "ACTION_LOG": str(action_log),
                            "FAKE_SCENARIO": scenario,
                        },
                        text=True,
                        capture_output=True,
                        check=False,
                    )

                with self.subTest(skill=name, scenario="failed-new-no-run-id"):
                    result = run("no-run-id")
                    self.assertEqual(result.returncode, 0)
                    self.assertIn("rc=1\nrun=\nreport=", result.stdout)
                    self.assertIn('"message":"login required"', result.stderr)
                    self.assertFalse(action_log.exists())

                with self.subTest(skill=name, scenario="failed-resume-aborts"):
                    result = run("failed-resume")
                    self.assertEqual(result.returncode, 0)
                    self.assertIn("rc=1\nrun=\nreport=", result.stdout)
                    self.assertIn('"message":"resume preflight failed"', result.stderr)
                    self.assertEqual(action_log.read_text(encoding="utf-8"), "abort:known123\n")
                    action_log.unlink()

                with self.subTest(skill=name, scenario="hung-user-choice"):
                    result = run("hung")
                    self.assertEqual(result.returncode, 0)
                    self.assertIn("STOP: ask the user", result.stderr)
                    self.assertEqual(action_log.read_text(encoding="utf-8"), "abort:hung123\n")
                    action_log.unlink()

                with self.subTest(skill=name, scenario="ok-report"):
                    result = run("ok")
                    self.assertEqual(result.returncode, 0)
                    self.assertIn("rc=0\nrun=ok123\nreport=final report", result.stdout)
                    self.assertFalse(action_log.exists())

    def test_codex_build_human_gate_distinguishes_rejection_and_cancellation(self):
        body = self.skills["codex-build"][1]
        gate = body.split("## Step 5 — Human gate", 1)[1].split("## Hard rules", 1)[0]
        rejection = gate.index("Rejected with another requested fix")
        cancellation = gate.index("Cancellation or a decision to stop delegation")
        abort = gate.index('scripts/codex-exec.sh abort "$RUN_ID"')
        self.assertLess(rejection, cancellation)
        self.assertLess(cancellation, abort)

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
