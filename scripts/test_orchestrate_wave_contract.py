#!/usr/bin/env python3
"""Reference-free behavioral contract for the portable orchestrate-wave skill.

The parity table names outcomes, not the consumer that first proved them.  That
keeps the regression test useful in every repository that installs the kit.

Run: python3 scripts/test_orchestrate_wave_contract.py
"""

import re
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
CLAUDE_SKILL = REPO / ".claude/skills/orchestrate-wave/SKILL.md"
CODEX_SKILL = REPO / ".agents/skills/orchestrate-wave/SKILL.md"
CLAUDE_BUILDER = (
    REPO / ".claude/skills/orchestrate-wave/references/builder-contract.md"
)
CODEX_BUILDER = (
    REPO / ".agents/skills/orchestrate-wave/references/builder-contract.md"
)


# Outcome -> fragments whose conjunction proves that portable behavior.
BEHAVIORAL_PARITY = {
    "collision-safe claim": (
        "wave-active/<anchor>",
        "ahead",
        "uncommitted changes",
        "LOCAL annotated tag",
        "never push",
    ),
    "owner-safe abort cleanup": (
        "this run planted",
        "On ANY wave STOP/abort",
        "Never delete a claim marker observed during a preflight collision",
    ),
    "dependency-aware retirement": (
        "topological",
        "internal import graph",
        "ONE atomic slice",
        "cycle",
    ),
    "safe stacked landing": (
        "Do NOT rely on auto-retarget",
        "FRESH PR",
        "merge order",
        "manual gate",
    ),
    "completion propagation": (
        "Closing Conditions",
        "completion status",
        "native parent",
        "Program-PRD",
        "program sync",
    ),
}


def markdown_body(text: str) -> str:
    """Ignore frontmatter representation differences between adapters."""
    if not text.startswith("---\n"):
        return text
    return text.split("\n---\n", 1)[1]


class OrchestrateWaveContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = CLAUDE_SKILL.read_text(encoding="utf-8")
        cls.builder = CLAUDE_BUILDER.read_text(encoding="utf-8")

    def test_reference_free_behavioral_parity_table(self):
        prose = " ".join(self.skill.split())
        for outcome, fragments in BEHAVIORAL_PARITY.items():
            with self.subTest(outcome=outcome):
                for fragment in fragments:
                    self.assertIn(" ".join(fragment.split()), prose)

        self.assertNotRegex(self.skill, re.compile(r"/home/|#[0-9]{3,}"))

    def test_builder_commands_finish_in_the_foreground(self):
        prose = " ".join(self.builder.split())
        for fragment in (
            "IN THE FOREGROUND",
            "never background a test/gate command",
            "completed command results",
            "exit status",
        ):
            self.assertIn(" ".join(fragment.split()), prose)

    def test_current_portable_contracts_survive_the_port(self):
        for fragment in (
            "project layer",
            "Native blocking edges are the frontier authority",
            "AFK heartbeat",
            "Re-run your project's full CI/verify gate CENTRALLY yourself",
            "already authenticated",
        ):
            self.assertIn(fragment, self.skill)

    def test_capability_selector_routes_exactly_one_orchestration_mechanic(self):
        for fragment in (
            "## Orchestration mechanics",
            "literal `Workflow`",
            "do not emulate",
            "returns exactly one",
            "references/dispatch-workflow.md",
            "references/dispatch-subagents.md",
            "Path C",
            "Phase 1 uses the selected orchestration mechanics",
            "Phase 2 uses the selected orchestration mechanics",
        ):
            self.assertIn(fragment, self.skill)

        self.assertLessEqual(len(self.skill.splitlines()), 345)

    def test_registry_ownership_distinguishes_safe_from_eager_registries(self):
        prose = " ".join(self.skill.split())
        for fragment in (
            "declaration-only registries",
            "may be predeclared by one hub",
            "eager/validated registries",
            "each appending only its own existing artifact after creation",
            "dependency edges",
        ):
            self.assertIn(fragment, prose)

        phase_one = prose.split("## Phase 1", 1)[1].split("## Phase 2", 1)[0]
        done = phase_one.split("**Done when:**", 1)[1]
        for fragment in (
            "either one declaration-only owner",
            "verbatim consume-only dependents",
            "or an explicit serialized owner sequence",
            "each owner appends only its own existing artifact",
        ):
            self.assertIn(fragment, done)

    def test_phase_two_keeps_per_slice_routing_decisions(self):
        prose = " ".join(self.skill.split())
        self.assertIn("(a) inline vs delegate", prose)
        self.assertIn("(b) tier + effort", prose)
        self.assertIn("Standing rules", prose)

    def test_claude_and_codex_surfaces_match(self):
        self.assertEqual(
            markdown_body(self.skill),
            markdown_body(CODEX_SKILL.read_text(encoding="utf-8")),
        )
        self.assertEqual(
            self.builder,
            CODEX_BUILDER.read_text(encoding="utf-8"),
        )


if __name__ == "__main__":
    unittest.main()
