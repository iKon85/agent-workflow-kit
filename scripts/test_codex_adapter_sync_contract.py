#!/usr/bin/env python3
"""Regression contract for the Codex-only adapter audit skill."""

import importlib.util
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
ADAPTER = REPO_ROOT / ".agents/skills/codex-adapter-sync/SKILL.md"
_FRONTMATTER_SPEC = importlib.util.spec_from_file_location(
    "skill_frontmatter_lint", REPO_ROOT / "scripts/test_skill_frontmatter_lint.py")
frontmatter = importlib.util.module_from_spec(_FRONTMATTER_SPEC)
_FRONTMATTER_SPEC.loader.exec_module(frontmatter)


def section(body: str, heading: str) -> str:
    """Return one second-level Markdown section, excluding the next one."""
    marker = f"## {heading}\n"
    start = body.index(marker) + len(marker)
    end = body.find("\n## ", start)
    return body[start:] if end == -1 else body[start:end]


class AdapterModesContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.body = ADAPTER.read_text(encoding="utf-8")

    def test_audit_is_read_only_and_apply_is_worktree_gated(self):
        audit = " ".join(section(self.body, "Audit mode (default)").split())
        apply = " ".join(section(self.body, "Apply mode").split())

        self.assertIn("current checkout", audit)
        self.assertIn("read-only", audit)
        self.assertIn("Do not create or switch branches or worktrees", audit)
        self.assertIn("before the first edit", apply)
        self.assertIn("Never apply adapter changes on `main`", apply)
        self.assertNotIn("before inventory or edits", self.body)


class AdapterRoutingContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.body = ADAPTER.read_text(encoding="utf-8")

    def test_durable_routing_is_provider_neutral_and_resolved_at_dispatch(self):
        routing = " ".join(section(self.body, "Routing intent").split())

        self.assertIn("`routing-intent`", routing)
        self.assertIn("`reasoning-intent`", routing)
        self.assertIn("Evidence catalog", routing)
        self.assertIn("Access graph", routing)
        self.assertIn("Routing policy", routing)
        self.assertIn("dispatch time", routing)
        self.assertIn("explicit `inherit`", routing)
        self.assertIn("Dispatch receipt", routing)
        self.assertIn("`default`, `worker`, and `explorer`", routing)

        self.assertNotRegex(self.body, r"(?<!model_)\breasoning_effort\b")
        self.assertNotRegex(self.body, r"\bagent_type\b")


class AdapterInventoryContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.body = ADAPTER.read_text(encoding="utf-8")

    def test_nested_instructions_configs_and_hooks_are_inventoried(self):
        inventory = section(self.body, "Inventory")

        for surface in (
            "`**/CLAUDE.md`",
            "`**/AGENTS.md`",
            "`**/AGENTS.override.md`",
            "`**/.codex/config.toml`",
            "`.claude/settings*.json`",
            "`.claude/hooks/**`",
            "`.codex/hooks.json`",
            "inline `[hooks]`",
        ):
            self.assertIn(surface, inventory)
        self.assertIn("trusted project layers", inventory)
        self.assertIn("Codex-adapted", inventory)
        self.assertIn("intentionally Claude-only", inventory)
        self.assertNotIn("`frontend/CLAUDE.md`", self.body)
        self.assertNotIn("`backend/CLAUDE.md`", self.body)


class AdapterAgentContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.body = ADAPTER.read_text(encoding="utf-8")

    def test_custom_agent_toml_uses_the_current_schema(self):
        agents = " ".join(section(self.body, "Custom-agent validation").split())

        self.assertIn(
            "required `name`, `description`, and `developer_instructions`", agents)
        self.assertIn("optional `model` and `model_reasoning_effort`", agents)
        self.assertIn("Parse every `.codex/agents/*.toml`", agents)
        self.assertIn("Reject a file", agents)


class AdapterValidationContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.body = ADAPTER.read_text(encoding="utf-8")

    def test_validation_covers_every_current_adapter_surface(self):
        validation = " ".join(section(self.body, "Validation").split())

        for proof in (
            "`codex --strict-config --version`",
            "skill-frontmatter guard",
            "skill metadata and loading",
            "custom-agent TOML",
            "`git check-ignore",
            "references, assets, scripts",
            "mirror-parity guard",
            "X of Y",
        ):
            self.assertIn(proof, validation)
        for maintainer_only_path in (
            "scripts/test_skill_frontmatter_lint.py",
            "scripts/test_skill_portability_lint.py",
        ):
            self.assertNotIn(maintainer_only_path, self.body)

    def test_description_cap_is_an_enforced_repository_safeguard(self):
        validation = " ".join(section(self.body, "Validation").split())
        self.assertIn("1024-character description cap", validation)
        self.assertIn("repository safeguard", validation)
        self.assertIn("not a Codex product limit", validation)

        problems = []
        for skill in (REPO_ROOT / ".agents/skills").glob("*/SKILL.md"):
            data = frontmatter.parse_frontmatter(
                frontmatter.extract_frontmatter(skill.read_text(encoding="utf-8")))
            description = data.get("description")
            if isinstance(description, str) and len(description) > 1024:
                problems.append(f"{skill.relative_to(REPO_ROOT)}: {len(description)}")
        self.assertEqual(
            problems,
            [],
            "skill descriptions over 1024 characters:\n" + "\n".join(problems),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
