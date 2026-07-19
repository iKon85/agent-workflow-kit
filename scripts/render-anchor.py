#!/usr/bin/env python3
"""Pure rendering for a lean Tier-2 anchor and its full PRD archive."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import NamedTuple

from marker_lib import marker_value


PLAN_REVISION_RE = re.compile(
    r"^\s*\*\*plan_revision:\*\*\s*(r[^\s]+)\s*$"
)
HTML_MARKER_RE = re.compile(
    r"^\s*<!--\s*(prd-source-id|prd-content-fp|prd):\s*.+?\s*-->\s*$"
)
HTML_COMMENT_RE = re.compile(r"^\s*<!--.*-->\s*$")


class RenderedDocuments(NamedTuple):
    """The two byte-stable documents produced by one render."""

    anchor_body: str
    archive_body: str


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
        if not bare.strip() or marker or HTML_COMMENT_RE.fullmatch(bare):
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


def render_documents(anchor_template: str, prd_body: str) -> RenderedDocuments:
    """Return the filled anchor template and marker-free PRD archive."""
    revisions, archive_source = _strip_head_markers(prd_body)
    if len(revisions) != 1:
        raise ValueError("source PRD head must have exactly one canonical plan_revision")
    revision = revisions[0]
    archive_header = (
        f"📄 Full PRD (archive, {revision}) — "
        "the body carries navigation/decisions only\n\n"
    )
    return RenderedDocuments(anchor_template, archive_header + archive_source)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render one filled Tier-2 anchor or its marker-free PRD archive."
    )
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--prd", type=Path, required=True)
    parser.add_argument("--document", choices=("anchor", "archive"), required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    rendered = render_documents(
        args.template.read_bytes().decode("utf-8"),
        args.prd.read_bytes().decode("utf-8"),
    )
    output = (
        rendered.anchor_body if args.document == "anchor" else rendered.archive_body
    )
    sys.stdout.buffer.write(output.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
