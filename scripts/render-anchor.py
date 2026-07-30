#!/usr/bin/env python3
"""Pure rendering of the one Tier-2 anchor body a publish run writes.

One document, one write: the filled anchor template with the full PRD folded
into a collapsed `<details>` section underneath it. The PRD is not moved into a
separate archive comment — a second remote artifact would need its own
existence classification on every resume, which is exactly the machinery the
publish reconciler replaces.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from marker_lib import marker_value


PLAN_REVISION_RE = re.compile(
    r"^\s*\*\*plan_revision:\*\*\s*(r\d+)\s*$"
)
PLAN_REVISION_LOOKALIKE_RE = re.compile(r"^\s*\*\*plan_revision:\*\*.*$")
HTML_MARKER_RE = re.compile(
    r"^\s*<!--\s*(prd-source-id|prd-content-fp|prd):\s*([^>\r\n]+?)\s*-->\s*$"
)
HTML_COMMENT_RE = re.compile(r"^\s*<!--.*-->\s*$")


def _canonical_marker(line: str) -> tuple[str, str] | None:
    revision = PLAN_REVISION_RE.fullmatch(line)
    if revision:
        return ("plan_revision", revision.group(1))
    marker = HTML_MARKER_RE.fullmatch(line)
    if not marker:
        return None
    kind = marker.group(1)
    if kind == "prd-source-id":
        value = marker_value(line, kind)
        return (kind, value) if value is not None else None
    return (kind, "")


def _strip_head_markers(source: str) -> tuple[list[str], str]:
    revisions: list[str] = []
    end = 0
    kept: list[str] = []
    for line in source.splitlines(keepends=True):
        bare = line.rstrip("\r\n")
        marker = _canonical_marker(bare)
        if (
            not bare.strip()
            or marker
            or HTML_COMMENT_RE.fullmatch(bare)
            or PLAN_REVISION_LOOKALIKE_RE.fullmatch(bare)
        ):
            end += len(line)
            if marker:
                if marker[0] == "plan_revision":
                    revisions.append(marker[1])
            else:
                kept.append(line)
            continue
        break
    if not any(line.strip() for line in kept):
        kept = []
    while kept and not kept[0].strip():
        kept.pop(0)
    return revisions, "".join(kept) + source[end:]


def render_anchor_body(anchor_template: str, prd_body: str) -> str:
    """The single anchor body: filled template + the marker-free PRD, folded."""
    revisions, prd_source = _strip_head_markers(prd_body)
    if len(revisions) != 1:
        raise ValueError("source PRD head must have exactly one canonical plan_revision")
    summary = (
        f"📄 Full PRD ({revisions[0]}) — "
        "the anchor above carries navigation/decisions only"
    )
    return (
        f"{anchor_template.rstrip(chr(10))}\n\n"
        f"<details>\n<summary>{summary}</summary>\n\n"
        f"{prd_source.rstrip(chr(10))}\n\n</details>\n"
    )


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render the one anchor body a publish run writes."
    )
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--prd", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    body = render_anchor_body(
        args.template.read_bytes().decode("utf-8"),
        args.prd.read_bytes().decode("utf-8"),
    )
    sys.stdout.buffer.write(body.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
