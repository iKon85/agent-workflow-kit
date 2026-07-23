"""Contract tests for the user-visible Program planning route."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ProgramPlanningContractTest(unittest.TestCase):
    def skill(self, name: str) -> str:
        return (ROOT / ".claude" / "skills" / name / "SKILL.md").read_text()

    def file(self, path: str) -> str:
        return (ROOT / path).read_text()

    def test_to_issues_is_the_public_planning_facade(self):
        text = self.skill("to-issues")
        self.assertIn("single public Planning facade", text)
        self.assertIn("planning-mode=feature", text)
        self.assertIn("planning-mode=program", text)
        self.assertIn("Missing or contradictory identity", text)
        self.assertIn("Size, prose, and model judgment never select the mode", text)

    def test_program_identity_delegates_to_the_internal_graph_engine(self):
        issues = self.skill("to-issues")
        waves = self.skill("to-waves")
        self.assertIn("delegate to the internal", issues)
        self.assertIn("`to-waves` graph engine", issues)
        self.assertIn("complete Program preview", issues)
        self.assertIn("Internal Program graph engine", waves)
        self.assertIn("compatibility entrypoint", waves)
        self.assertIn("carries both", waves)
        self.assertIn("never infer Program mode", waves)

    def test_feature_identity_keeps_the_existing_decomposition_path(self):
        text = self.skill("to-issues")
        self.assertIn("Feature identity", text)
        self.assertIn("PROMOTE", text)
        self.assertIn("ATOMIC", text)

    def test_normal_routes_name_only_the_planning_facade(self):
        route_files = (
            ".claude/skills/ask-matt/SKILL.md",
            ".claude/skills/scale-check/SKILL.md",
            ".claude/skills/setup-workflow/workflow-overview.md",
            ".claude/skills/board-to-waves/SKILL.md",
            "CLAUDE.md",
            "README.md",
            "docs/workflow.html",
            "docs/methodology.html",
            "docs/methodology.svg",
        )
        for path in route_files:
            with self.subTest(path=path):
                text = self.file(path)
                self.assertIn("to-issues", text)
                self.assertNotIn("→ `to-waves`", text)
                self.assertNotIn("→ to-waves", text)

    def test_dual_surface_planning_skills_are_coherent(self):
        skill_snippets = (
            ("to-issues", "single public Planning facade"),
            ("to-waves", "Internal Program graph engine"),
            ("ask-matt", "the user never chooses that engine"),
            ("scale-check", "explicit Program identity selects the internal graph path"),
            ("setup-workflow", "explicit Program identity"),
            ("board-to-waves", "not directly to a hidden engine"),
        )
        for skill, snippet in skill_snippets:
            with self.subTest(skill=skill):
                claude = self.file(f".claude/skills/{skill}/SKILL.md")
                codex = self.file(f".agents/skills/{skill}/SKILL.md")
                self.assertIn(snippet, claude)
                self.assertIn(snippet, codex)

        support_files = ("workflow-overview.md", "board-sync.md")
        for name in support_files:
            with self.subTest(support=name):
                claude = self.file(f".claude/skills/setup-workflow/{name}")
                codex = self.file(f".agents/skills/setup-workflow/{name}")
                self.assertEqual(claude, codex)

    def test_to_waves_finishes_with_every_wave_execute_ready_by_default(self):
        text = self.skill("to-waves")
        self.assertIn("## 7. Program completion contract", text)
        self.assertIn("every published wave", text)
        self.assertIn("execute-ready-check.py", text)
        self.assertIn("X von Y Wellen ausführungsreif", text)

    def test_program_preview_is_the_single_default_user_gate(self):
        text = self.skill("to-waves")
        self.assertIn("single user approval", text)
        self.assertIn("do not ask for another per-wave approval", text)

    def test_unresolved_work_is_modeled_as_an_explicit_gate_not_generic_late_binding(self):
        text = self.skill("to-waves")
        self.assertIn("Decision Gate", text)
        self.assertIn("Verify Spike", text)
        self.assertIn("Design-Grill", text)
        self.assertIn("Late Binding is not the default", text)

    def test_to_issues_supports_program_batch_and_keeps_human_actions_out_of_afk(self):
        text = self.skill("to-issues")
        self.assertIn("Program batch handoff", text)
        self.assertIn("A mandatory human or external setup action is never AFK", text)

    def test_atomic_program_wave_preserves_its_program_identity(self):
        text = self.skill("to-issues")
        self.assertIn("Program-batch atomic exception", text)
        self.assertIn("preserve its existing Wave and Phase", text)

    def test_atomic_program_wave_never_leaves_a_preliminary_child(self):
        waves = self.skill("to-waves")
        issues = self.skill("to-issues")
        self.assertIn("do not create a preliminary child", waves)
        self.assertIn("legacy or interrupted preliminary child", issues)
        self.assertIn("superseded by atomic wave leaf", issues)
        self.assertIn("Atomic supersession", waves)
        self.assertIn("matching source marker remains discoverable after unlink", issues)

    def test_program_completion_treats_audit_findings_as_blocking(self):
        text = self.skill("to-waves")
        self.assertIn("Program completion gate", text)
        self.assertIn("do not count that wave as matured", text)

    def test_public_program_route_promises_execute_ready_waves(self):
        text = self.skill("scale-check")
        self.assertIn("all waves execute-ready by default", text)


if __name__ == "__main__":
    unittest.main()
