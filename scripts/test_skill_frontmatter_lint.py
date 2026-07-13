#!/usr/bin/env python3
"""Skill-frontmatter parse-parity lint (#1603-Retro).

Why: every other skill-lint reads `name`/`description` with a *regex* (e.g.
stale_name_lint `re.compile(rf"name:\\s*{n}\\b")`), while the real consumer —
Claude Code's skill loader — parses the frontmatter as **strict YAML**. A
SKILL.md whose frontmatter does not parse therefore passes `ci:local` green but
silently fails to load. That actually happened building the `impact-census`
skill: the description carried an ASCII `"` instead of the German `"`, which
terminated the YAML double-quoted scalar early — green CI, dead skill, caught
only by an ad-hoc `yaml.safe_load`.

This lint closes the parse-parity gap: it loads the frontmatter the same way the
consumer does and asserts the keys the loader needs. Scope is the whole class
(unparseable frontmatter — ASCII quotes, tabs, bad indentation, unbalanced
colons), not just the one quote char; it adds NO speculative content rules.

Checks, per SKILL.md in both trees (.claude/skills + .agents/skills):
  1. the frontmatter block parses as YAML;
  2. `name` is a non-empty string AND equals the skill directory name;
  3. `description` is a non-empty string.

Run: python3 scripts/test_skill_frontmatter_lint.py
"""
import re
import json
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SKILL_DIRS = [".claude/skills", ".agents/skills"]


def skill_md_files() -> list[Path]:
    """Every <tree>/<skill>/SKILL.md across both surface trees."""
    out = []
    for tree in SKILL_DIRS:
        base = REPO_ROOT / tree
        if not base.is_dir():
            continue
        for d in sorted(base.iterdir()):
            md = d / "SKILL.md"
            if d.is_dir() and md.is_file():
                out.append(md)
    return out


def extract_frontmatter(text: str) -> str:
    """Return the YAML block between the first two `---` fences.

    Raises ValueError when the file has no leading frontmatter fence — the
    loader requires it, so its absence is itself a failure.
    """
    if not text.startswith("---"):
        raise ValueError("no leading `---` frontmatter fence")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise ValueError("unterminated frontmatter (missing closing `---`)")
    return parts[1]


class FrontmatterError(ValueError):
    pass


def parse_scalar(value: str) -> str:
    value = value.strip()
    if value.startswith('"'):
        try:
            return json.loads(value)
        except json.JSONDecodeError as exc:
            raise FrontmatterError(str(exc)) from exc
    if value.startswith("'"):
        if len(value) < 2 or not value.endswith("'"):
            raise FrontmatterError("unterminated single-quoted scalar")
        return value[1:-1].replace("''", "'")
    return value.split(" #", 1)[0].strip()


def parse_frontmatter(block: str) -> dict:
    """Parse the loader-relevant YAML subset without a third-party package."""
    if "\t" in block:
        raise FrontmatterError("tabs are not valid indentation")
    data = {}
    lines = block.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.match(r'^((?:[A-Za-z][\w-]*)|(?:"[A-Za-z][\w-]*")):(?:[ ]*(.*))$', line)
        if not match:
            raise FrontmatterError(f"invalid top-level mapping line: {line!r}")
        key, value = match.groups()
        key = key.strip('"')
        if value in (">", ">-", "|", "|-"):
            chunks = []
            while i < len(lines) and (not lines[i].strip() or lines[i].startswith("  ")):
                chunks.append(lines[i].strip())
                i += 1
            data[key] = " ".join(filter(None, chunks))
        else:
            data[key] = parse_scalar(value)
    return data


def validate(md: Path) -> list[str]:
    """Return human-readable problems for one SKILL.md (empty = clean)."""
    try:
        rel = md.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        rel = md.as_posix()  # tmp paths in the validator's own unit tests
    skill_name = md.parent.name
    text = md.read_text(encoding="utf-8")
    try:
        block = extract_frontmatter(text)
        data = parse_frontmatter(block)
    except (ValueError, FrontmatterError) as exc:
        # one-line message — YAML errors are multi-line, keep only the gist
        return [f"{rel}: frontmatter does not parse — {str(exc).splitlines()[0]}"]
    problems = []
    if not isinstance(data, dict):
        return [f"{rel}: frontmatter is not a YAML mapping"]
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        problems.append(f"{rel}: `name` missing or empty")
    elif name != skill_name:
        problems.append(f"{rel}: `name` is '{name}' but directory is '{skill_name}'")
    desc = data.get("description")
    if not isinstance(desc, str) or not desc.strip():
        problems.append(f"{rel}: `description` missing or empty")
    elif plain_desc_has_comment(block):
        problems.append(
            f"{rel}: plain-scalar `description` contains ' #' — YAML silently "
            "truncates the rest as a comment (board-to-waves lost its anti-trigger "
            "this way, PR #1914); quote it or fold with '>-'"
        )
    return problems


DESC_LINE = re.compile(r"^description:[ \t]*(.*)$", re.M)


def plain_desc_has_comment(block: str) -> bool:
    """True when a PLAIN-style description scalar carries a ' #' — YAML reads
    everything from the '#' on as a comment and silently shortens the value
    (the file still parses, so the parse check above cannot catch it)."""
    m = DESC_LINE.search(block)
    if not m:
        return False
    first = m.group(1).strip()
    if first[:1] in ('"', "'", ">", "|"):
        return False  # quoted or block scalar — '#' is literal there
    lines = [m.group(1)]
    for ln in block[m.end():].splitlines():
        # plain multi-line scalars continue on indented lines; stop at the
        # next top-level key or a blank line
        if ln.startswith((" ", "\t")) and ln.strip():
            lines.append(ln)
        else:
            break
    return any(" #" in ln for ln in lines)


class FrontmatterParses(unittest.TestCase):
    """Every SKILL.md frontmatter loads as the consumer (strict YAML) sees it."""

    def test_all_skill_frontmatter_valid(self):
        problems = [p for md in skill_md_files() for p in validate(md)]
        self.assertEqual(
            problems,
            [],
            "SKILL.md frontmatter that the loader would reject (regex lints miss "
            "this — see #1603-Retro):\n" + "\n".join(problems),
        )


class ValidatorBehaves(unittest.TestCase):
    """The validator itself catches the incident class (regression guard)."""

    def _tmp_skill(self, body: str) -> Path:
        import tempfile

        d = Path(tempfile.mkdtemp()) / "demo"
        d.mkdir()
        md = d / "SKILL.md"
        md.write_text(body, encoding="utf-8")
        return md

    def test_ascii_quote_in_description_is_flagged(self):
        # the exact #1603 incident: an ASCII " closes the scalar early
        md = self._tmp_skill('---\nname: demo\ndescription: "Use „x" then y, z"\n---\nbody\n')
        self.assertTrue(any("does not parse" in p for p in validate(md)))

    def test_name_dir_mismatch_is_flagged(self):
        md = self._tmp_skill("---\nname: wrong\ndescription: ok\n---\nbody\n")
        self.assertTrue(any("but directory is 'demo'" in p for p in validate(md)))

    def test_missing_description_is_flagged(self):
        md = self._tmp_skill("---\nname: demo\n---\nbody\n")
        self.assertTrue(any("`description` missing" in p for p in validate(md)))

    def test_clean_frontmatter_passes(self):
        md = self._tmp_skill('---\nname: demo\ndescription: "Use when foo: bar, baz."\n---\nbody\n')
        self.assertEqual(validate(md), [])

    def test_plain_desc_with_hash_comment_is_flagged(self):
        # the PR-#1914 incident class: an unquoted ' #' turns the rest of a
        # plain scalar into a YAML comment — parses fine, value silently short
        md = self._tmp_skill(
            "---\nname: demo\ndescription: Use for sweeps (e.g. #602); the anti-trigger after this vanishes.\n---\nbody\n"
        )
        self.assertTrue(any("silently" in p for p in validate(md)))

    def test_quoted_and_folded_desc_with_hash_pass(self):
        md = self._tmp_skill('---\nname: demo\ndescription: "Use for sweeps (e.g. #602); all kept."\n---\nbody\n')
        self.assertEqual(validate(md), [])
        md2 = self._tmp_skill(
            "---\nname: demo\ndescription: >-\n  Use for sweeps\n  (e.g. #602); all kept.\n---\nbody\n"
        )
        self.assertEqual(validate(md2), [])


if __name__ == "__main__":
    unittest.main()
