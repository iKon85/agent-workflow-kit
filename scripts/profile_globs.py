#!/usr/bin/env python3
"""One repository-relative glob dialect for every consumer workflow profile.

Workflow Advisories and Worktree Lifecycle both select repository-relative
paths from consumer-owned profile globs. They share this single matcher so the
same pattern can never select one set of paths for an advisory and a different
set for a cleanup decision.

Dialect
-------
- Paths and patterns are repository-relative POSIX paths separated by ``/``.
- ``*`` matches any run of characters inside one path segment, never ``/``.
- ``?`` matches exactly one character inside one path segment.
- ``[seq]`` and ``[!seq]`` are ``fnmatch`` character classes inside one
  segment; ``/`` is always a separator and never a class member.
- ``**`` as a complete segment matches zero or more segments. A leading
  ``**/`` therefore also matches the repository root, and ``dir/**`` also
  matches ``dir`` itself.
- Matching is always case-sensitive, on every host filesystem.
- A pattern must match the whole path; there is no implicit prefix match.

Run this module to review an installed profile before trusting it:

    python3 scripts/profile_globs.py [docs/agents/workflow-capabilities.json]

It names every pattern whose match set narrows or widens against the legacy
matcher of its own capability, marks the keys that carry deletion authority,
and never edits the profile. Exit code 0 means nothing changed meaning, 1 means
at least one pattern needs review, 2 means the profile could not be read.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path, PurePosixPath

WIDENS = "widens"
NARROWS = "narrows"
CASE_NARROWS = "narrows-on-case-insensitive-hosts"

DEFAULT_PROFILE = "docs/agents/workflow-capabilities.json"
DIALECT = (
    "Repository-relative POSIX globs: `*` and `?` stay inside one path "
    "segment, `[seq]`/`[!seq]` are per-segment character classes, `**` as a "
    "whole segment matches zero or more segments (so a leading `**/` also "
    "matches the repository root and `dir/**` also matches `dir`), matching "
    "is always case-sensitive, and a pattern must match the whole path."
)
_SAMPLE_CHARS = "abcxyz0129_-"


def path_glob_matches(path: str, pattern: str) -> bool:
    """Match POSIX path segments while retaining fnmatch bracket compatibility."""
    path_parts = PurePosixPath(path).parts
    pattern_parts = PurePosixPath(pattern).parts
    memo: dict[tuple[int, int], bool] = {}

    def matches(path_index: int, pattern_index: int) -> bool:
        key = (path_index, pattern_index)
        if key in memo:
            return memo[key]
        if pattern_index == len(pattern_parts):
            result = path_index == len(path_parts)
        elif pattern_parts[pattern_index] == "**":
            result = matches(path_index, pattern_index + 1) or (
                path_index < len(path_parts)
                and matches(path_index + 1, pattern_index)
            )
        else:
            result = (
                path_index < len(path_parts)
                and fnmatchcase(path_parts[path_index], pattern_parts[pattern_index])
                and matches(path_index + 1, pattern_index + 1)
            )
        memo[key] = result
        return result

    return matches(0, 0)


@dataclass(frozen=True)
class PatternMigration:
    """Proven differences between a legacy match set and the shared dialect."""

    pattern: str
    effects: tuple[str, ...]
    witnesses: dict[str, str]


@dataclass(frozen=True)
class ProfileGlobFinding:
    location: str
    pattern: str
    deletion_authority: bool
    migration: PatternMigration


def _class_end(segment: str, start: int) -> int | None:
    index = start + 1
    if index < len(segment) and segment[index] in "!^":
        index += 1
    if index < len(segment) and segment[index] == "]":
        index += 1
    while index < len(segment) and segment[index] != "]":
        index += 1
    return index if index < len(segment) else None


def _instantiate(segment: str, *, separator_filler: str | None = None) -> str | None:
    """Build one concrete body that this single-segment pattern matches."""
    body: list[str] = []
    index = 0
    used_separator = False
    while index < len(segment):
        character = segment[index]
        if character in {"*", "?"}:
            if separator_filler is not None and not used_separator:
                body.append(separator_filler if character == "*" else "/")
                used_separator = True
            else:
                body.append("x")
            index += 1
        elif character == "[":
            end = _class_end(segment, index)
            if end is None:
                body.append(character)
                index += 1
                continue
            member = next(
                (c for c in _SAMPLE_CHARS if fnmatchcase(c, segment[index:end + 1])),
                None,
            )
            if member is None:
                return None
            body.append(member)
            index = end + 1
        else:
            body.append(character)
            index += 1
    if separator_filler is not None and not used_separator:
        return None
    return "".join(body)


def _pattern_parts(pattern: str) -> list[str]:
    return [part for part in pattern.split("/") if part]


def _witness(
    pattern: str, *, drop_globstar: bool = False, separator_part: int | None = None,
) -> str | None:
    """Instantiate one concrete repository-relative path from the pattern."""
    segments: list[str] = []
    for index, part in enumerate(_pattern_parts(pattern)):
        if part == "**":
            if drop_globstar:
                continue
            segments.append("x")
            continue
        body = _instantiate(
            part, separator_filler="a/b" if index == separator_part else None,
        )
        if body is None:
            return None
        segments.append(body)
    return "/".join(segments) if segments else "x"


def classify_pattern(
    pattern: str, *, case_insensitive_legacy: bool = False,
) -> PatternMigration:
    """Name only differences proven by a concrete witness path."""
    effects: list[str] = []
    witnesses: dict[str, str] = {}
    parts = _pattern_parts(pattern)
    if any(part == "**" for part in parts):
        witness = _witness(pattern, drop_globstar=True)
        if (
            witness
            and path_glob_matches(witness, pattern)
            and not fnmatchcase(witness, pattern)
        ):
            effects.append(WIDENS)
            witnesses[WIDENS] = witness
    for index, part in enumerate(parts):
        if part == "**" or not ("*" in part or "?" in part):
            continue
        witness = _witness(pattern, separator_part=index)
        if (
            witness
            and fnmatchcase(witness, pattern)
            and not path_glob_matches(witness, pattern)
        ):
            effects.append(NARROWS)
            witnesses[NARROWS] = witness
            break
    plain = _witness(pattern)
    if case_insensitive_legacy and plain and plain.swapcase() != plain:
        swapped = plain.swapcase()
        if (
            fnmatchcase(swapped.lower(), pattern.lower())
            and not path_glob_matches(swapped, pattern)
        ):
            effects.append(CASE_NARROWS)
            witnesses[CASE_NARROWS] = swapped
    return PatternMigration(pattern, tuple(effects), witnesses)


def _string_entries(container: object, key: str) -> list[tuple[int, str]]:
    if not isinstance(container, dict):
        return []
    value = container.get(key)
    if not isinstance(value, list):
        return []
    return [
        (index, entry) for index, entry in enumerate(value) if isinstance(entry, str)
    ]


def _surface_globs(advisories: dict, section: str) -> list[tuple[str, str]]:
    config = advisories.get(section)
    surfaces = config.get("surfaces") if isinstance(config, dict) else None
    if not isinstance(surfaces, list):
        return []
    return [
        (f"workflowAdvisories.{section}.surfaces[{outer}].globs[{index}]", pattern)
        for outer, surface in enumerate(surfaces)
        for index, pattern in _string_entries(surface, "globs")
    ]


def _profile_globs(document: object) -> list[tuple[str, str, bool]]:
    """List every shipped consumer-profile glob call site's configured patterns."""
    if not isinstance(document, dict):
        return []
    globs: list[tuple[str, str, bool]] = []
    for index, pattern in _string_entries(
        document.get("worktreeLifecycle"), "scratchPatterns",
    ):
        globs.append((f"worktreeLifecycle.scratchPatterns[{index}]", pattern, True))
    for index, pattern in _string_entries(
        document.get("wrapup"), "landingGeneratedArtifactPatterns",
    ):
        globs.append(
            (f"wrapup.landingGeneratedArtifactPatterns[{index}]", pattern, True),
        )
    advisories = document.get("workflowAdvisories")
    if isinstance(advisories, dict):
        for index, pattern in _string_entries(advisories.get("baseline"), "sourceGlobs"):
            globs.append(
                (f"workflowAdvisories.baseline.sourceGlobs[{index}]", pattern, False),
            )
        for section in ("preRefactor", "stopChecks"):
            globs.extend(
                (location, pattern, False)
                for location, pattern in _surface_globs(advisories, section)
            )
    return globs


def scan_profile(document: object) -> tuple[ProfileGlobFinding, ...]:
    """Classify every consumer-profile glob against its own legacy matcher.

    Worktree Lifecycle globs were always matched case-sensitively, while
    Workflow Advisories globs went through the case-normalizing `fnmatch`, so
    only the advisory keys can narrow on a case-insensitive host.
    """
    return tuple(
        ProfileGlobFinding(
            location,
            pattern,
            deletion_authority,
            classify_pattern(
                pattern, case_insensitive_legacy=not deletion_authority,
            ),
        )
        for location, pattern, deletion_authority in _profile_globs(document)
    )


def render_report(findings: tuple[ProfileGlobFinding, ...], source: str) -> str:
    changed = [finding for finding in findings if finding.migration.effects]
    lines = [
        f"Profile glob dialect review — {source}",
        f"Dialect: {DIALECT}",
        f"Reviewed {len(findings)} consumer-profile glob(s); "
        f"{len(changed)} change meaning.",
    ]
    for finding in changed:
        authority = " [deletion authority]" if finding.deletion_authority else ""
        lines.append("")
        lines.append(f"{finding.location}{authority}: {finding.pattern}")
        for effect in finding.migration.effects:
            witness = finding.migration.witnesses[effect]
            verb = "now also matches" if effect == WIDENS else "no longer matches"
            lines.append(f"  {effect}: {verb} {witness!r}")
    if changed:
        lines.append("")
        lines.append(
            "Review each line above and rewrite the pattern yourself. A widened "
            "deletion-authority pattern expands what cleanup may remove; this "
            "check never edits the profile and never migrates a pattern for you.",
        )
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    arguments = [argument for argument in argv if argument != "--json"]
    as_json = len(arguments) != len(argv)
    if len(arguments) > 1:
        print("usage: profile_globs.py [--json] [profile.json]", file=sys.stderr)
        return 2
    source = arguments[0] if arguments else DEFAULT_PROFILE
    try:
        document = json.loads(Path(source).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"cannot read consumer profile {source}: {error}", file=sys.stderr)
        return 2
    findings = scan_profile(document)
    changed = [finding for finding in findings if finding.migration.effects]
    if as_json:
        print(json.dumps({
            "source": source,
            "dialect": DIALECT,
            "reviewed": len(findings),
            "changed": len(changed),
            "findings": [
                {
                    "location": finding.location,
                    "pattern": finding.pattern,
                    "deletionAuthority": finding.deletion_authority,
                    "effects": list(finding.migration.effects),
                    "witnesses": finding.migration.witnesses,
                }
                for finding in changed
            ],
        }, indent=2))
    else:
        print(render_report(findings, source), end="")
    return 1 if changed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
