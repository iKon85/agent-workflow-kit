#!/usr/bin/env python3
"""Stale-skill-name lint (Welle 26 / Slice 5 / #989).

When a skill is renamed (here: `setup-matt-pocock-skills` -> `setup-workflow`),
every ACTIVE reference must move with it, or consumer skills point at a command
that no longer exists (Codex R1 #1: `to-issues/SKILL.md:10` still invoked the
deleted name). This lint fails on any active reference to a retired skill name.

ACTIVE reference = a form that would actually misroute: a slash invocation
(`/<name>`), a dollar invocation (`$<name>`), a frontmatter `name:` value, a
`.../skills/<name>` dir/path reference, or a manifest JSON key (`"<name>":`).

EXPLICITLY NOT a violation (Codex R2 #1): legitimate *attribution prose* that names
the upstream skill — the provenance upstream-path `engineering/<name>/`, a manifest
`note`, or a SKILL.md description "adapted from <name>". Those credit the upstream,
they don't route anywhere. The active-form patterns below match none of them. A
per-line `stale-name-lint: ok` marker also exempts a single line.

Two scope rules keep the lint on the routing question it actually asks:

  * The JSON-key form counts **only inside the skill manifest**. That is what
    the docstring always meant by "a manifest JSON key" — a `"<name>":` key in
    a *board profile* is consumer data keyed by the executor that reads it, not
    a skill reference, and renaming it would silently drop a consumer's setting.
  * `HISTORY_DIRS` are records that quote retired names *by design* — ADRs,
    analyses, evidence, research notes. Rewriting them would falsify the
    record; they route nobody anywhere. Same category as attribution prose,
    applied to a directory instead of a phrase.

Run: python3 scripts/test_skill_stale_name_lint.py
"""
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Retired skill names that must have zero active references anywhere we scan.
# `wrapup` was split into `make-landable` + `land`; the executor script keeps
# its `wrapup-land.py` filename (consumers and tests call it by path) and the
# board profile keeps its `wrapup` switch block, so neither is a skill name.
RETIRED_NAMES = ["setup-matt-pocock-skills", "wrapup"]

LINT_OK = "stale-name-lint: ok"

MANIFEST = REPO / ".claude/skills/skill-manifest.json"

# Records that quote retired names by design — rewriting them falsifies the
# record, and none of them routes a reader anywhere.
HISTORY_DIRS = ("docs/adr", "docs/analysis", "docs/evidence", "docs/research")


def _active_patterns(name):
    """Forms that would actually misroute to a non-existent skill.

    Boundary-guarded so neither the provenance path `engineering/<name>/` nor
    attribution prose (`adapted from <name>`, a manifest note) matches, and so
    a longer name that merely starts with this one (`wrapup-land.py`) is not a
    hit either.
    """
    n = re.escape(name)
    return [
        re.compile(rf"(?<![\w/])/{n}(?![\w/.-])"),  # slash invocation /<name>
        re.compile(rf"(?<![\w])\${n}(?![\w.-])"),   # dollar invocation $<name>
        re.compile(rf"name:\s*{n}\b(?![.-])"),      # frontmatter name:
        re.compile(rf"skills/{n}(?![\w.-])"),       # .claude|.agents/skills/<name>
    ]


def _manifest_key_pattern(name):
    """The manifest JSON key `"<name>":` — a skill reference only in there."""
    return re.compile(rf'"{re.escape(name)}"\s*:')


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
            files.extend(
                f for f in base.rglob("*.md")
                if not f.relative_to(REPO).as_posix().startswith(HISTORY_DIRS)
            )
    if MANIFEST.is_file():
        files.append(MANIFEST)
    return files


def _violations_for(name):
    """Return list of (file, lineno, line) with an active reference to `name`."""
    patterns = _active_patterns(name)
    manifest_key = _manifest_key_pattern(name)
    out = []
    for f in _scan_files():
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        active = patterns + ([manifest_key] if f == MANIFEST else [])
        for i, line in enumerate(text.splitlines(), start=1):
            if name not in line or LINT_OK in line:
                continue
            if any(p.search(line) for p in active):
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

    def test_a_longer_name_that_starts_with_a_retired_one_is_not_a_hit(self):
        """`wrapup-land.py` keeps its filename; only the bare skill name routes."""
        patterns = _active_patterns("wrapup")
        for benign in (
            "run `python3 scripts/wrapup-land.py land --branch x`",
            "the `$wrapup-land` helper is not a skill",
            ".claude/skills/wrapup-land/SKILL.md",
        ):
            self.assertFalse(
                any(p.search(benign) for p in patterns),
                f"longer name should not be flagged: {benign!r}",
            )

    def test_the_board_profile_switch_block_is_consumer_data_not_a_skill_ref(self):
        """`"wrapup": {...}` in a board profile keys the executor, not a skill."""
        line = '  "wrapup": {'
        self.assertFalse(any(p.search(line) for p in _active_patterns("wrapup")),
                         "a JSON key is not one of the routing forms")
        self.assertTrue(_manifest_key_pattern("wrapup").search(line),
                        "the same line IS a violation inside the skill manifest")
        self.assertEqual(
            [], _violations_for("wrapup"),
            "the live profile keeps its switch block without tripping the lint",
        )

    def test_history_records_are_out_of_scope(self):
        """ADRs, analyses, evidence and research quote retired names by design."""
        scanned = {f.relative_to(REPO).as_posix() for f in _scan_files()}
        self.assertFalse(
            [p for p in scanned if p.startswith(HISTORY_DIRS)],
            "history directories must not be scanned",
        )
        self.assertIn("docs/agents/board-sync.md", scanned,
                      "the live project layer stays in scope")

    def test_active_forms_are_flagged(self):
        """The misrouting forms must be caught."""
        for name in RETIRED_NAMES:
            patterns = _active_patterns(name)
            for active in (
                f"run `/{name}` if not",
                f"type `${name}` to land",
                f"name: {name}",
                f".claude/skills/{name}/SKILL.md",
            ):
                self.assertTrue(
                    any(p.search(active) for p in patterns),
                    f"active form should be flagged: {active!r}",
                )
            self.assertTrue(
                _manifest_key_pattern(name).search(f'"{name}": {{ "class": "vendored" }}'),
                f"manifest key should be flagged for {name!r}",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
