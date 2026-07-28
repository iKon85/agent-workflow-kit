#!/usr/bin/env python3
"""Manifest-derived rollout contract for published delegating surfaces.

Completeness here is counted, never recalled.  The class of delegating surfaces
is declared in `.claude/skills/skill-manifest.json` — the single manifest both
surfaces read — as `routing.dispatch`: the list of markdown contracts a skill
must carry on every surface it hosts.  The denominator is re-derived from that
manifest on every run and reported as `X of Y`, so a shrinking class fails loud
instead of quietly passing.

Two directions are checked, because one alone is not a census:

* declared -> present: every declared contract file exists and carries the
  shared-dispatcher paragraph verbatim, on every surface the entry hosts;
* delegating -> declared: every published skill file that actually dispatches
  another agent (a cross-model `scripts/codex-exec.sh` run, or a direct native
  spawn as the orchestrate-wave census detects it) is declared, so the class
  cannot be narrowed by leaving a delegating surface out of the manifest.

`routing.writesIntent` names the planning surface that writes a machine-readable
Routing intent into the issues it creates; its keys are cross-checked against
the intent schema in `src/lib/routingIntent.mjs` rather than restated here.

Run: python3 scripts/test_skill_delegating_dispatch.py
"""

import importlib.util
import json
import re
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent
MANIFEST = REPO / ".claude/skills/skill-manifest.json"
INTENT_MODULE = REPO / "src/lib/routingIntent.mjs"
SURFACE_TREES = {"claude": ".claude/skills", "codex": ".agents/skills"}

_SPAWN_SPEC = importlib.util.spec_from_file_location(
    "orchestrate_wave_contract", REPO / "scripts/test_orchestrate_wave_contract.py")
_spawn = importlib.util.module_from_spec(_SPAWN_SPEC)
_SPAWN_SPEC.loader.exec_module(_spawn)
DIRECT_SPAWN_PATTERN = _spawn.DIRECT_SPAWN_PATTERN
CROSS_MODEL_DISPATCH = "scripts/codex-exec.sh"

# The one paragraph every delegating surface carries verbatim — "the same way"
# is a literal, not a paraphrase.  Compared against whitespace-normalized prose
# so line wrapping stays an editorial choice.
SHARED_DISPATCH_CONTRACT = " ".join("""
Before dispatch, resolve a provider-neutral Routing intent — an explicit intent
block first, otherwise the workflow classifier — and authorize the whole run
once through a Dispatch plan whose hash binds every unit, intent, route and
reason. Dispatch only through `src/lib/routeDispatcher.mjs`, and require a
Dispatch receipt from the shared spawn guard that carries the authorization id
the plan recorded. A detected transport is not authorization; AFK dispatch
stops unless requested/applied route, model/effort enforcement, environment
precedence, and catalog/access/policy revisions are proved.
""".split())


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def _declared(manifest: dict, key: str) -> tuple[tuple[str, str, str], ...]:
    """Every (skill, surface, relative path) the manifest declares under `key`."""
    surfaces = []
    for name, entry in sorted(manifest.get("skills", {}).items()):
        if not entry.get("publish"):
            continue
        contracts = (entry.get("routing") or {}).get(key) or []
        for surface in entry.get("surfaces", []):
            for relative in contracts:
                surfaces.append((name, surface, relative))
    return tuple(sorted(surfaces))


def delegating_surfaces(manifest: dict) -> tuple[tuple[str, str, str], ...]:
    return _declared(manifest, "dispatch")


def intent_author_surfaces(manifest: dict) -> tuple[tuple[str, str, str], ...]:
    return _declared(manifest, "writesIntent")


def surface_path(skill: str, surface: str, relative: str) -> Path:
    return REPO / SURFACE_TREES[surface] / skill / relative


def missing_contract(surfaces, read, contract=SHARED_DISPATCH_CONTRACT):
    """Pure census core: the declared surfaces whose prose lacks `contract`."""
    missing = []
    for skill, surface, relative in surfaces:
        body = read(skill, surface, relative)
        if body is None:
            missing.append(f"{surface}:{skill}/{relative}: no such file")
        elif contract not in " ".join(body.split()):
            missing.append(f"{surface}:{skill}/{relative}: missing shared dispatch contract")
    return missing


def _read_surface(skill: str, surface: str, relative: str):
    path = surface_path(skill, surface, relative)
    return path.read_text(encoding="utf-8") if path.is_file() else None


def intent_keys() -> tuple[str, ...]:
    """The v2 Routing intent keys, read from the schema that owns them."""
    source = INTENT_MODULE.read_text(encoding="utf-8")
    version = re.search(r"const VERSION_KEY = '([a-z-]+)'", source)
    dimensions = source[source.index("const DIMENSIONS"):source.index("const VERSION_KEY")]
    keys = re.findall(r"key: '([a-z-]+)'", dimensions)
    assert version and keys, "routing intent schema keys are unreadable"
    return (version.group(1), *keys)


class DelegatingCensus(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = load_manifest()
        cls.surfaces = delegating_surfaces(cls.manifest)

    def test_the_denominator_is_derived_and_covers_both_surface_trees(self):
        self.assertTrue(self.surfaces, "no delegating surface is declared in the manifest")
        hosted = {surface for _, surface, _ in self.surfaces}
        self.assertEqual(hosted, set(SURFACE_TREES), f"declared surfaces: {sorted(hosted)}")

    def test_every_declared_delegating_surface_carries_the_shared_contract(self):
        missing = missing_contract(self.surfaces, _read_surface)
        total = len(self.surfaces)
        self.assertEqual(
            missing, [],
            f"shared dispatch contract rollout {total - len(missing)} of {total}:\n"
            + "\n".join(missing))

    def test_every_delegating_skill_file_is_declared(self):
        declared = {(skill, relative) for skill, _, relative in self.surfaces}
        undeclared = []
        for name, entry in sorted(self.manifest.get("skills", {}).items()):
            if not entry.get("publish"):
                continue
            for surface in entry.get("surfaces", []):
                root = REPO / SURFACE_TREES[surface] / name
                for path in sorted(root.rglob("*.md")) if root.is_dir() else []:
                    body = path.read_text(encoding="utf-8")
                    if CROSS_MODEL_DISPATCH not in body \
                            and not DIRECT_SPAWN_PATTERN.search(body):
                        continue
                    relative = str(path.relative_to(root))
                    if (name, relative) not in declared:
                        undeclared.append(f"{surface}:{name}/{relative}")
        self.assertEqual(
            sorted(set(undeclared)), [],
            "delegating skill file missing from the manifest `routing.dispatch` "
            "class — the denominator would silently shrink")

    def test_a_declared_surface_missing_the_contract_is_reported(self):
        surfaces = (("example", "claude", "SKILL.md"), ("example", "codex", "SKILL.md"))
        bodies = {
            ("example", "claude", "SKILL.md"): f"intro\n\n{SHARED_DISPATCH_CONTRACT}\n",
            ("example", "codex", "SKILL.md"): "intro only\n",
        }
        missing = missing_contract(surfaces, lambda *key: bodies.get(key))
        self.assertEqual(missing, ["codex:example/SKILL.md: missing shared dispatch contract"])

    def test_a_declared_surface_without_a_file_is_reported(self):
        missing = missing_contract((("ghost", "codex", "SKILL.md"),), lambda *key: None)
        self.assertEqual(missing, ["codex:ghost/SKILL.md: no such file"])

    def test_a_claude_only_skill_declares_no_codex_mirror(self):
        for skill, surface, relative in self.surfaces:
            with self.subTest(surface=f"{surface}:{skill}/{relative}"):
                self.assertTrue(surface_path(skill, surface, relative).is_file())


class RoutingIntentAuthor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = load_manifest()
        cls.surfaces = intent_author_surfaces(cls.manifest)

    def test_a_planning_surface_declares_that_it_writes_the_intent(self):
        self.assertTrue(self.surfaces, "no surface declares `routing.writesIntent`")

    def test_the_written_block_names_exactly_the_schema_keys(self):
        keys = intent_keys()
        problems = []
        for skill, surface, relative in self.surfaces:
            body = _read_surface(skill, surface, relative)
            if body is None:
                problems.append(f"{surface}:{skill}/{relative}: no such file")
                continue
            blocks = [block for block in re.split(r"\n[ \t]*\n", body)
                      if re.search(r"^\s*routing-intent\s*:", block, re.MULTILINE)]
            if len(blocks) != 1:
                problems.append(
                    f"{surface}:{skill}/{relative}: {len(blocks)} routing-intent blocks, want 1")
                continue
            written = re.findall(r"^\s*([a-z][a-z-]*)\s*:", blocks[0], re.MULTILINE)
            if written != list(keys):
                problems.append(
                    f"{surface}:{skill}/{relative}: writes {written}, schema wants {list(keys)}")
        self.assertEqual(problems, [], "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
