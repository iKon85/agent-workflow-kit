#!/usr/bin/env python3
"""Lint fixture (Welle 26 / #980): no bare board-writing `gh` in enforced skills.

The board-sync mechanics now live behind `scripts/board-sync.py`. Skills that have
been migrated to route through the helper must not inline bare board-mutating `gh`
commands again — they drift from the SSOT and bypass the one-parent-check / preview
header / field-ID encapsulation.

Scope grows per slice: a skill joins ENFORCED_SKILLS once its slice routes it
through the helper (1b: board-to-waves; to-issues lands in 1d/#982). The legacy
two-line planning skill the helper was extracted from has since been removed
(1f/#985).

Only *runnable* lines inside ```bash/```sh fences are checked — prose mentions in
backticks are fine. A line carrying the marker `board-sync-lint: ok` is exempt
(for deliberate "don't do this" doc examples).

Run: python3 scripts/test_skill_gh_lint.py
"""
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Skills whose prose must route board writes through scripts/board-sync.py.
# Grows per slice as each skill is migrated (1b: board-to-waves; 1c/#981: to-prd
# routes creation through the helper; to-issues lands in 1d/#982; retro lands
# in Welle 49 / Slice 9 / #1880).
ENFORCED_SKILLS = ["board-to-waves", "to-prd", "to-issues", "retro"]

# Both the Claude source and the Codex mirror must stay clean.
SKILL_DIRS = [".claude/skills", ".agents/skills"]

# Board-mutating gh commands that the helper now owns.
FORBIDDEN = [
    re.compile(r"\bgh\s+issue\s+create\b"),
    re.compile(r"\bgh\s+project\s+item-add\b"),
    re.compile(r"\bgh\s+project\s+item-edit\b"),
    re.compile(r"\baddSubIssue\s*\(input"),
    re.compile(r"\bremoveSubIssue\s*\(input"),
    # workflow-state label edits the helper owns (R2#4): ready-for-agent / needs-info /
    # type:cluster / wave-stub via gh issue edit --add-label/--remove-label. priority:* etc. stay fine.
    re.compile(r"\bgh\s+issue\s+edit\b.*--(add|remove)-label\b.*"
               r"\b(ready-for-agent|needs-info|type:cluster|wave-stub)\b"),
]
FENCE_OPEN = re.compile(r"^\s*```(bash|sh|shell)\b")
FENCE_ANY = re.compile(r"^\s*```")
EXEMPT = "board-sync-lint: ok"


def find_offenders(text: str) -> list[tuple[int, str]]:
    """Return (line_no, line) for forbidden gh inside bash/sh fences."""
    offenders = []
    in_shell = False
    for n, line in enumerate(text.splitlines(), 1):
        if not in_shell and FENCE_OPEN.match(line):
            in_shell = True
            continue
        if in_shell and FENCE_ANY.match(line):
            in_shell = False
            continue
        if in_shell and EXEMPT not in line:
            if any(p.search(line) for p in FORBIDDEN):
                offenders.append((n, line.strip()))
    return offenders


class SelfCheck(unittest.TestCase):
    """The detector itself behaves."""

    def test_flags_bare_create_in_bash_fence(self):
        text = "```bash\ngh issue create --title X\n```"
        self.assertEqual(len(find_offenders(text)), 1)

    def test_flags_workflow_state_label_edit(self):
        for lbl in ("ready-for-agent", "needs-info", "type:cluster", "wave-stub"):
            text = f"```bash\ngh issue edit 982 --add-label {lbl}\n```"
            self.assertEqual(len(find_offenders(text)), 1, lbl)

    def test_flags_workflow_state_label_remove(self):
        text = "```bash\ngh issue edit 982 --remove-label ready-for-agent\n```"
        self.assertEqual(len(find_offenders(text)), 1)

    def test_ignores_non_workflow_label_edit(self):
        # priority:* is a normal label, not workflow-state — editing it is allowed
        text = "```bash\ngh issue edit 982 --add-label priority:high\n```"
        self.assertEqual(find_offenders(text), [])

    def test_ignores_prose_mention(self):
        text = "Der Helper kapselt `gh project item-edit` — nicht selbst aufrufen."
        self.assertEqual(find_offenders(text), [])

    def test_ignores_read_only_gh(self):
        text = "```bash\ngh issue list --state open\ngh project item-list 1\n```"
        self.assertEqual(find_offenders(text), [])

    def test_exempt_marker(self):
        text = "```bash\ngh issue create --title X  # board-sync-lint: ok (anti-example)\n```"
        self.assertEqual(find_offenders(text), [])

    def test_helper_call_is_clean(self):
        text = "```bash\npython3 scripts/board-sync.py create --title X --body-file b.md\n```"
        self.assertEqual(find_offenders(text), [])


class EnforcedSkillsClean(unittest.TestCase):
    def test_no_bare_board_gh_in_enforced_skills(self):
        problems = []
        for skill in ENFORCED_SKILLS:
            for d in SKILL_DIRS:
                path = REPO_ROOT / d / skill / "SKILL.md"
                if not path.exists():
                    continue
                for ln, src in find_offenders(path.read_text(encoding="utf-8")):
                    problems.append(f"{d}/{skill}/SKILL.md:{ln}: {src}")
        self.assertEqual(
            problems, [],
            "Bare board-mutating gh in enforced skill prose — route through "
            "scripts/board-sync.py:\n" + "\n".join(problems))


if __name__ == "__main__":
    unittest.main(verbosity=2)
