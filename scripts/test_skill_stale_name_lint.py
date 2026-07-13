#!/usr/bin/env python3
"""Stale-skill-name lint (Welle 26 / Slice 5 / #989).

When a skill is renamed (here: `setup-matt-pocock-skills` -> `setup-workflow`),
every ACTIVE reference must move with it, or consumer skills point at a command
that no longer exists (Codex R1 #1: `to-issues/SKILL.md:10` still invoked the
deleted name). This lint fails on any active reference to a retired skill name.

ACTIVE reference = a form that would actually misroute: a slash invocation
(`/<name>`), a frontmatter `name:` value, a `.../skills/<name>` dir/path reference,
or a manifest JSON key (`"<name>":`).

EXPLICITLY NOT a violation (Codex R2 #1): legitimate *attribution prose* that names
the upstream skill — the provenance upstream-path `engineering/<name>/`, a manifest
`note`, or a SKILL.md description "adapted from <name>". Those credit the upstream,
they don't route anywhere. The active-form patterns below match none of them. A
per-line `stale-name-lint: ok` marker also exempts a single line.

Run: python3 scripts/test_skill_stale_name_lint.py
"""
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Retired skill names that must have zero active references anywhere we scan.
RETIRED_NAMES = ["setup-matt-pocock-skills"]

LINT_OK = "stale-name-lint: ok"


def _active_patterns(name):
    """Forms that would actually misroute to a non-existent skill.

    Boundary-guarded so neither the provenance path `engineering/<name>/` nor
    attribution prose (`adapted from <name>`, a manifest note) matches.
    """
    n = re.escape(name)
    return [
        re.compile(rf"(?<![\w/])/{n}(?![\w/-])"),  # slash invocation /<name>
        re.compile(rf"name:\s*{n}\b"),             # frontmatter name:
        re.compile(rf"skills/{n}\b"),              # .claude|.agents/skills/<name>
        re.compile(rf'"{n}"\s*:'),                 # manifest JSON key
    ]


def _scan_files():
    """Files where an active reference would actually mislead a consumer."""
    files = []
    for root in ("CLAUDE.md", "AGENTS.md"):
        p = REPO / root
        if p.is_file():
            files.append(p)
    for d in (".claude/skills", ".agents/skills", "docs"):
        base = REPO / d
        if base.is_dir():
            files.extend(base.rglob("*.md"))
    manifest = REPO / ".claude/skills/skill-manifest.json"
    if manifest.is_file():
        files.append(manifest)
    return files


def _violations_for(name):
    """Return list of (file, lineno, line) with an active reference to `name`."""
    patterns = _active_patterns(name)
    out = []
    for f in _scan_files():
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for i, line in enumerate(text.splitlines(), start=1):
            if name not in line or LINT_OK in line:
                continue
            if any(p.search(line) for p in patterns):
                out.append((f.relative_to(REPO), i, line.strip()))
    return out


class StaleSkillName(unittest.TestCase):
    def test_no_active_references_to_retired_skill_names(self):
        all_v = []
        for name in RETIRED_NAMES:
            all_v.extend(_violations_for(name))
        msg = "\n".join(f"  {f}:{n}: {ln}" for f, n, ln in all_v)
        self.assertEqual(
            all_v,
            [],
            f"\nActive references to retired skill name(s) found "
            f"(rename them or add `{LINT_OK}`):\n{msg}",
        )

    def test_attribution_prose_is_not_flagged(self):
        """Credit forms that name the upstream must NOT be treated as violations."""
        for name in RETIRED_NAMES:
            patterns = _active_patterns(name)
            for benign in (
                f"| `setup-workflow` | generic | `engineering/{name}/` |",
                f"adapted from Matt Pocock's `{name}` (MIT)",
                f'"note": "evolved from {name} (Welle 26)"',
            ):
                self.assertFalse(
                    any(p.search(benign) for p in patterns),
                    f"attribution prose should be exempt: {benign!r}",
                )

    def test_active_forms_are_flagged(self):
        """The misrouting forms must be caught."""
        for name in RETIRED_NAMES:
            patterns = _active_patterns(name)
            for active in (
                f"run `/{name}` if not",
                f"name: {name}",
                f".claude/skills/{name}/SKILL.md",
                f'"{name}": {{ "class": "vendored" }}',
            ):
                self.assertTrue(
                    any(p.search(active) for p in patterns),
                    f"active form should be flagged: {active!r}",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
