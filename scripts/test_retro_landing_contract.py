"""Contract tests for retro enforcement and safe landing-pair workflow chaining.

The single `wrapup` skill was split into the two invocation moments it always
conflated: `make-landable` (post-implement — local CI, commit, PR body) and
`land` (post-acceptance — merge, board reconcile, teardown, handoff). Every
assertion that used to read one combined SKILL.md now reads whichever half owns
the contract, and the retired name must not survive anywhere it could route.
"""

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
    def test_memory_probe_is_surface_specific_and_codex_state_stays_generated(self):
        claude = skill(".claude", "retro")
        codex = skill(".agents", "retro")
        codex_contract = contract_text(".agents", "retro")

        for text in (claude, codex):
            self.assertIn("<!-- mirror-xform:start memory-store-probe -->", text)
            self.assertIn("<!-- mirror-xform:end -->", text)
            self.assertIn("test -f \"$MEMDIR/MEMORY.md\"", text)

        self.assertIn('$HOME/.claude/projects/', claude)
        self.assertIn("move deleted memory files to `archive/`", claude)

        self.assertIn('${CODEX_HOME:-$HOME/.codex}/memories', codex)
        self.assertIn("generated state", codex)
        self.assertIn("Do not propose manual deletion or archival", codex_contract)
        self.assertIn("Generated Codex memory state", codex)
        self.assertIn("no direct file mutation", codex)
        self.assertNotIn("pure Codex install) have no memory directory", codex)
        self.assertNotIn("move deleted memory files to `archive/`", codex)
        self.assertNotIn(
            "New/changed memory note | `~/.claude/projects/<project>/memory/",
            codex,
        )

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

    def test_capability_route_and_exact_sanitized_approval_survive(self):
        required = (
            "generic or project-specific",
            "recommend `own`",
            "contribute status <path> --surface=retro",
            "Missing, disabled, invalid, or unverifiable configuration",
            "never infer maintainer status",
            "sanitized exact preview",
            "separate explicit approval",
            "docs/agents/skills/<skill>.md",
        )
        for surface in SURFACES:
            with self.subTest(surface=surface):
                text = contract_text(surface, "retro")
                for phrase in required:
                    self.assertIn(phrase, text)


class LandingPairContract(unittest.TestCase):
    """The split is real: two skills, one invocation moment each."""

    def test_the_combined_skill_is_retired_on_both_surfaces(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                self.assertFalse(
                    (ROOT / surface / "skills" / "wrapup").exists(),
                    f"{surface}/skills/wrapup must be gone — make-landable + land replace it",
                )
                for name in ("make-landable", "land"):
                    self.assertTrue((ROOT / surface / "skills" / name / "SKILL.md").is_file())

    def test_each_half_names_only_its_own_moment(self):
        """make-landable stops before the remote; land starts at it."""
        for surface in SURFACES:
            with self.subTest(surface=surface):
                prepare = contract_text(surface, "make-landable")
                self.assertIn("wrapup-land.py preflight", prepare)
                self.assertIn("wrapup-land.py commit", prepare)
                self.assertIn("wrapup-land.py content-claim", prepare)
                self.assertIn("wrapup-land.py content-commit", prepare)
                self.assertIn("never pushes, never merges, never tears anything down", prepare)
                self.assertNotIn("wrapup-land.py land ", prepare)

                landing = contract_text(surface, "land")
                self.assertIn("wrapup-land.py land ", landing)
                self.assertNotIn("wrapup-land.py commit", landing)
                self.assertNotIn("wrapup-land.py content-commit", landing)

    def test_prod_readiness_degrades_reporting_without_blocking_landing(self):
        required = (
            "readiness.mjs check --skill land --json",
            "Prod readiness is pending or missing; deploy reporting omitted.",
            "landing continues normally",
            "never authorizes the agent to invent or configure a deploy target",
            "<!-- readiness:block deployReport -->",
            "<!-- readiness:end -->",
        )
        for surface in SURFACES:
            with self.subTest(surface=surface):
                text = skill(surface, "land")
                for phrase in required:
                    self.assertIn(phrase, text)
                self.assertEqual(text.count("<!-- readiness:block deployReport -->"), 1)
                self.assertEqual(text.count("<!-- readiness:end -->"), 1)

    def test_retro_is_model_invocable_on_both_surfaces(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                frontmatter = skill(surface, "retro").split("---", 2)[1]
                self.assertIn("disable-model-invocation: false", frontmatter)

    def test_retro_is_voluntary_and_never_blocks_landing(self):
        """The retro binding is cut: no question, no marker, no second run."""
        forbidden = (
            "land nothing in this run",
            "fresh explicit `$make-landable` or `/make-landable` invocation",
            "Already ran a retro?",
            "Mandatory `Retro:` line",
        )
        for surface in SURFACES:
            with self.subTest(surface=surface):
                text = contract_text(surface, "make-landable")
                self.assertIn("Retro (voluntary — never a gate)", text)
                self.assertIn("invoke the `retro` skill", text)
                for phrase in forbidden:
                    self.assertNotIn(phrase, text)

    def test_the_landing_pair_does_not_forbid_its_affirmative_retro_chain(self):
        for surface in SURFACES:
            for name in ("make-landable", "land"):
                with self.subTest(surface=surface, skill=name):
                    text = contract_text(surface, name)
                    self.assertNotIn("never run by this skill", text.lower())

    def test_only_model_invocable_non_deploying_workflows_chain(self):
        required = (
            "model-invocable",
            "non-deploying",
            "return control to the user",
            "state the reason",
        )
        for surface in SURFACES:
            with self.subTest(surface=surface):
                text = contract_text(surface, "make-landable")
                for phrase in required:
                    self.assertIn(phrase, text)
                self.assertIn(
                    "never carries this run's merge/teardown authorization into another run",
                    contract_text(surface, "land"),
                )

    def test_landing_remains_manual_and_program_propagation_remains_present(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                text = skill(surface, "land")
                self.assertIn("disable-model-invocation: true", text)
                self.assertIn(
                    "user's direct `$land` or `/land` input IS the explicit",
                    text,
                )
                self.assertIn("program-sync", text)
                self.assertIn("Phasen-Gates", text)

                prepare = skill(surface, "make-landable")
                self.assertIn("disable-model-invocation: true", prepare)
                self.assertIn(
                    "user's direct `$make-landable` or `/make-landable` input IS the explicit",
                    prepare,
                )

    def test_both_halves_accept_only_direct_user_dollar_or_slash_invocations(self):
        shared = (
            "Natural-language requests",
            "indirect skill chaining",
            "autonomous invocation",
        )
        for surface in SURFACES:
            for name, trigger in (
                ("make-landable", "direct `$make-landable` or `/make-landable`"),
                ("land", "direct `$land` or `/land`"),
            ):
                with self.subTest(surface=surface, skill=name):
                    text = contract_text(surface, name)
                    for phrase in (trigger, *shared):
                        self.assertIn(phrase, text)

    def test_new_contract_is_reference_free(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                combined = (
                    skill(surface, "retro")
                    + skill(surface, "make-landable")
                    + skill(surface, "land")
                )
                self.assertNotIn("testreporter", combined.lower())
                self.assertIsNone(re.search(r"#[0-9]{3,}", combined))


if __name__ == "__main__":
    unittest.main(verbosity=2)
