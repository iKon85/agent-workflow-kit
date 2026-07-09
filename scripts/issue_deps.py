#!/usr/bin/env python3
"""issue_deps.py — pure `## Blocked by` body-mirror logic.

Native GitHub issue dependencies (REST `dependencies/blocked_by`) are the SSOT
for blocking edges; the `## Blocked by` body section is a MACHINE-WRITTEN
mirror kept for readability (mail/export/search) and for trackers without
native dependencies (kit portability). On conflict the API wins.

Pure module by design (same rationale as anchor_table.py): render/splice/parse
carry no gh calls and no board_config, so board-sync.py (writer) and
execute-ready-check.py (drift reader) share one grammar without a subprocess
seam. Writers: board-sync.py `dep-add`/`dep-remove` — never hand-edited.
"""
from __future__ import annotations

import re

_SECTION_HEADING = "## Blocked by"
_HEADING_RE = re.compile(r"^#{1,6}\s")
_BULLET_NUM_RE = re.compile(r"^-\s+#(\d+)\b")

_MIRROR_NOTE = ("*(Maschinell gepflegter Spiegel — die nativen "
                "Issue-Dependencies (API) sind die Wahrheit; Pflege via "
                "`scripts/board-sync.py dep-add`/`dep-remove`.)*")


def render_blocked_by_section(blockers: list[dict]) -> str:
    """The full mirror section for a non-empty blocker list."""
    lines = [_SECTION_HEADING, ""]
    lines += [f"- #{b['number']} ({b['state']}) — {b['title']}".rstrip()
              for b in blockers]
    lines += ["", _MIRROR_NOTE]
    return "\n".join(lines)


def _locate_section(lines: list[str]) -> tuple[int, int] | None:
    """(start, end) line span of the existing section, end exclusive."""
    start = next((i for i, ln in enumerate(lines)
                  if ln.strip() == _SECTION_HEADING), None)
    if start is None:
        return None
    end = next((i for i in range(start + 1, len(lines))
                if _HEADING_RE.match(lines[i])), len(lines))
    return start, end


def splice_blocked_by_section(body: str, blockers: list[dict]) -> str:
    """Replace/append/remove the mirror section in `body`. Idempotent."""
    lines = (body or "").splitlines()
    span = _locate_section(lines)
    section = render_blocked_by_section(blockers).splitlines() if blockers else []
    if span is None:
        if not section:
            return body
        head = "\n".join(lines).rstrip("\n")
        return f"{head}\n\n" + "\n".join(section) + "\n"
    start, end = span
    new = lines[:start] + section + (["" ] if section and end < len(lines) else []) + lines[end:]
    # collapse a doubled blank line left by removal
    out = re.sub(r"\n{3,}", "\n\n", "\n".join(new))
    return out if out.endswith("\n") else out + "\n"


def open_blocker_numbers(blockers: list[dict]) -> list[int]:
    """Numbers of the still-open blockers — the only ones that gate a build.
    Lives here (not in board-sync.py) so writer AND drift reader share the
    one "open" predicate."""
    return [b["number"] for b in blockers if b.get("state") == "open"]


def parse_blocked_by_numbers(body: str) -> list[int]:
    """Issue numbers listed in the mirror section (drift-check reader side)."""
    lines = (body or "").splitlines()
    span = _locate_section(lines)
    if span is None:
        return []
    start, end = span
    return [int(m.group(1)) for ln in lines[start + 1:end]
            if (m := _BULLET_NUM_RE.match(ln.strip()))]
