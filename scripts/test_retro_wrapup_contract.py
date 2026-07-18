"""Contract tests for retro enforcement and safe wrapup workflow chaining."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
SURFACES = (".claude", ".agents")


def skill(surface: str, name: str) -> str:
    return (ROOT / surface / "skills" / name / "SKILL.md").read_text(
        encoding="utf-8"
    )


def contract_text(surface: str, name: str) -> str:
    """Return prose with Markdown emphasis removed for wording assertions."""
    return re.sub(r"\s+", " ", skill(surface, name).replace("**", ""))


class RetroEnforcementContract(unittest.TestCase):
    def test_mechanical_check_precedes_target_and_weight_ladder(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                text = contract_text(surface, "retro")
                mechanical = text.index("### 3a. Mechanical enforcement check")
                ladder = text.index("### 3b. Determine target + weight")
                self.assertLess(mechanical, ladder)

    def test_machine_checkable_findings_cannot_stop_at_prose(self):
        required = (
            "Could a machine decide this",
            "implement the enforcement",
            "tracked enforcement issue",
            "explicit trade-off",
        )
        for surface in SURFACES:
            with self.subTest(surface=surface):
                text = contract_text(surface, "retro")
                for phrase in required:
                    self.assertIn(phrase, text)

    def test_upstream_or_own_and_exact_sanitized_approval_survive(self):
        required = (
            "generic or project-specific",
            "recommend `own`",
            "sanitized preview",
            "explicitly approves that exact text",
            "does not need to be the kit maintainer",
            "docs/agents/skills/<skill>.md",
        )
        for surface in SURFACES:
            with self.subTest(surface=surface):
                text = contract_text(surface, "retro")
                for phrase in required:
                    self.assertIn(phrase, text)


class WrapupChainingContract(unittest.TestCase):
    def test_retro_is_model_invocable_on_both_surfaces(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                frontmatter = skill(surface, "retro").split("---", 2)[1]
                self.assertIn("disable-model-invocation: false", frontmatter)

    def test_affirmative_retro_gate_chains_without_landing(self):
        required = (
            "invoke the `retro` skill immediately in this run",
            "land nothing in this run",
            "fresh explicit `/wrapup` invocation",
        )
        for surface in SURFACES:
            with self.subTest(surface=surface):
                text = contract_text(surface, "wrapup")
                for phrase in required:
                    self.assertIn(phrase, text)

    def test_only_model_invocable_non_deploying_workflows_chain(self):
        required = (
            "model-invocable",
            "non-deploying",
            "return control to the user",
            "state the reason",
        )
        for surface in SURFACES:
            with self.subTest(surface=surface):
                text = contract_text(surface, "wrapup")
                for phrase in required:
                    self.assertIn(phrase, text)

    def test_wrapup_remains_manual_and_program_propagation_remains_present(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                text = skill(surface, "wrapup")
                self.assertIn("disable-model-invocation: true", text)
                self.assertIn("user's `/wrapup` input IS the explicit", text)
                self.assertIn("program-sync", text)
                self.assertIn("Phasen-Gates", text)

    def test_new_contract_is_reference_free(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                combined = skill(surface, "retro") + skill(surface, "wrapup")
                self.assertNotIn("testreporter", combined.lower())
                self.assertIsNone(re.search(r"#[0-9]{3,}", combined))


if __name__ == "__main__":
    unittest.main(verbosity=2)
