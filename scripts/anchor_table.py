#!/usr/bin/env python3
"""anchor_table.py — pure Slices-table logic for `board-sync.py anchor-sync`.

A wave-anchor issue body carries a Slices-table that duplicates board-tracked
volatile data (Status, Branch). Hand-maintenance drifts (: stale branch,
missing split-row). `anchor-sync` regenerates the volatile cells IN PLACE: the
table stays ONE combined table, stable plan columns (Slice/Modell/Gate/…) are
preserved verbatim, and only Status + Branch are refreshed — and only when the
board DISAGREES, so a no-drift run reproduces the table byte-identically (AC#4)
while a drifted cell is corrected.

This module is PURE — no gh / no I/O / no board config. The gh-backed fetch and
the command wiring live in board-sync.py; everything here is directly unit-tested
(scripts/test_board_sync.py) with plain dicts and strings.

Columns are keyed by header NAME, not position — anchors carry free-form `#`
labels (4b/6b) and a varying last column (schließt/refs vs Blocked by).
"""
from __future__ import annotations

import re
from typing import Optional

SLICE_TABLE_START = "<!-- slice-table:start -->"
SLICE_TABLE_END = "<!-- slice-table:end -->"

_SUBISSUE_NUM_RE = re.compile(r"#(\d+)")
_STATUS_BASE_RE = re.compile(r"^(✅\s*#\d+|🔄|⬜)")
_STATUS_RANK = {"⬜": 0, "🔄": 1}


# --- markdown pipe-table parse / render --------------------------------------
def split_pipe_row(line: str) -> list[str]:
    """Cells of a markdown pipe-table row (outer pipes stripped, cells trimmed)."""
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def is_separator_row(cells: list[str]) -> bool:
    """A `|---|:--:|` header-separator row (every cell only dashes/colons)."""
    return bool(cells) and all(c and set(c) <= set("-: ") for c in cells)


def parse_pipe_table(block_lines: list[str]) -> tuple[list[str], list[list[str]]]:
    """(headers, data_rows) from pipe-table lines. Rows stay as ordered cell-lists
    (not dicts) so extra columns + cell text re-render verbatim. Separator dropped."""
    rows = [split_pipe_row(ln) for ln in block_lines if ln.strip().startswith("|")]
    if not rows:
        return [], []
    return rows[0], [r for r in rows[1:] if not is_separator_row(r)]


def render_pipe_table(headers: list[str], rows: list[list[str]]) -> str:
    """Render a canonical markdown pipe table (single-space padding)."""
    lines = ["| " + " | ".join(headers) + " |",
             "|" + "|".join("---" for _ in headers) + "|"]
    for r in rows:
        cells = (list(r) + [""] * len(headers))[:len(headers)]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


_MD_EMPHASIS_RE = re.compile(r"^(\*{1,2}|_{1,2})(.+)\1$")


def _strip_markdown_emphasis(cell: str) -> str:
    """Strip one layer of wrapping markdown emphasis (`**Bold**`, `_em_`) so a
    stylised header still exact-matches. Deliberately NOT a fuzzy/substring
    strip — a genuine variant like 'Sub-Issue (native)' must stay unmatched."""
    m = _MD_EMPHASIS_RE.match(cell)
    return m.group(2) if m else cell


def col_index(headers: list[str], name: str) -> Optional[int]:
    """Index of the column whose header — trimmed and stripped of one layer of
    wrapping markdown emphasis — equals name exactly, or None."""
    for i, h in enumerate(headers):
        if _strip_markdown_emphasis(h.strip()) == name:
            return i
    return None


def require_col_index(headers: list[str], name: str) -> int:
    """`col_index(headers, name)`, or a loud ValueError if this column can't be
    pinned down — e.g. a header variant like 'Sub-Issue (native)' that
    `locate_slice_table` matched on a raw substring but `col_index` can't
    exact/tolerant-match. Never let a silent None flow downstream and get
    misread as "no row has this column": that used to make merge_slice_rows
    treat every board sub-issue as missing and append it as a duplicate row,
    on every run (proven by a 2026-07-02 double-run)."""
    idx = col_index(headers, name)
    if idx is None:
        raise ValueError(
            f"slice table found but column {name!r} not matched "
            f"(headers: {headers})")
    return idx


def first_subissue_num(cell: str) -> Optional[int]:
    """First `#<n>` in a cell — the Sub-Issue key, ignoring annotations like
    `(schließt)`."""
    m = _SUBISSUE_NUM_RE.search(cell or "")
    return int(m.group(1)) if m else None


# --- volatile-cell refresh (board → cell) ------------------------------------
def status_token_from_board(entry: dict, roles: dict) -> str:
    """Canonical Status token from board state: ✅ #<PR> (merged) · 🔄 (open PR or
    an in-flight board status) · ⬜ (otherwise).

    Which status NAMES count as in-flight comes from the profile's role map
    (`roles["inProgress"]`/`roles["review"]`) — passed in as a plain
    dict so this module stays pure (no board_config import). Empty roles →
    board-status names can't be interpreted (⬜), PR signals still work."""
    prs = entry.get("prs") or []
    merged = [p for p in prs if p.get("state") == "MERGED"]
    if merged:
        return f"✅ #{merged[-1]['number']}"
    active = {roles.get("inProgress"), roles.get("review")} - {None}
    if [p for p in prs if p.get("state") == "OPEN"] or entry.get("status") in active:
        return "🔄"
    return "⬜"


def status_base(cell: str) -> str:
    """Leading canonical token of an existing Status cell (✅ #n / 🔄 / ⬜), or ''."""
    m = _STATUS_BASE_RE.match((cell or "").strip())
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


def _status_rank(base: str) -> int:
    """Monotone progress rank of a Status base token: ⬜ < 🔄 < ✅; '' = lowest."""
    if base.startswith("✅"):
        return 2
    return _STATUS_RANK.get(base, -1)


def refresh_status_cell(existing: str, entry: dict, roles: dict) -> str:
    """Refresh a Status cell from the board, MONOTONICALLY (never regress).

    Keep the existing cell verbatim when the board agrees (preserves hand
    annotations like `(gen-a)`) OR when the board token would regress it — gen-a/gen-b
    slices `Part of` the anchor stay OPEN while a part merges, so the board shows no
    closing PR; a human ✅ must not flip back to ⬜. Only an advance (⬜→🔄→✅, or a
    corrected merge-PR number) replaces the cell."""
    token = status_token_from_board(entry, roles)
    base = status_base(existing)
    if _status_rank(token) < _status_rank(base):
        return existing
    return existing if base == token else token


def branch_from_board(entry: dict) -> Optional[str]:
    """headRefName of the relevant linked PR (merged > open > any), or None."""
    prs = entry.get("prs") or []
    chosen = ([p for p in prs if p.get("state") == "MERGED"]
              or [p for p in prs if p.get("state") == "OPEN"] or prs)
    return chosen[-1].get("headRefName") if chosen else None


def refresh_branch_cell(existing: str, entry: dict) -> str:
    """Replace the branch with the linked PR's head once a PR exists and it differs;
    keep verbatim when it agrees (preserves backticks) or when there is no PR yet
    (the planned branch stays hand-owned)."""
    head = branch_from_board(entry)
    if not head:
        return existing
    if (existing or "").strip().strip("`").strip() == head:
        return existing
    return f"`{head}`"


def merge_slice_rows(headers: list[str], rows: list[list[str]],
                     board: dict, roles: dict) -> tuple[list[list[str]], list[int]]:
    """Refresh Status/Branch per row from board (keyed by the Sub-Issue cell's first
    #n) and append board sub-issues missing from the table. Returns (rows, appended).
    Rows whose sub-issue is absent from the board stay verbatim.

    Sub-Issue and Status are REQUIRED columns (`require_col_index` raises loudly
    if a header variant can't be matched) — a silent None here used to make
    `seen` stay empty and every board sub-issue get appended as a duplicate row
    on every run."""
    si = require_col_index(headers, "Sub-Issue")
    st = require_col_index(headers, "Status")
    br = col_index(headers, "Branch")
    slice_i = col_index(headers, "Slice")
    # A board sub-issue counts as present if its #n appears ANYWHERE in the
    # Sub-Issue column — incl. a folded secondary ref like `(schließt)`
    # — so it is never appended as a duplicate row.
    seen: set = set()
    for row in rows:
        if si < len(row):
            seen.update(int(n) for n in _SUBISSUE_NUM_RE.findall(row[si]))
    out: list[list[str]] = []
    for row in rows:
        row = list(row)
        sub = first_subissue_num(row[si]) if si < len(row) else None
        if sub is not None and sub in board:
            if st < len(row):
                row[st] = refresh_status_cell(row[st], board[sub], roles)
            if br is not None and br < len(row):
                row[br] = refresh_branch_cell(row[br], board[sub])
        out.append(row)
    appended: list[int] = []
    for sub, entry in board.items():
        if sub in seen:
            continue
        new = [""] * len(headers)
        new[si] = f"#{sub}"
        new[st] = status_token_from_board(entry, roles)
        if br is not None:
            head = branch_from_board(entry)
            if head:
                new[br] = f"`{head}`"
        if slice_i is not None:
            new[slice_i] = entry.get("title", "")
        out.append(new)
        appended.append(sub)
    return out, appended


# --- locate / splice the table within the anchor body ------------------------
def locate_slice_table(lines: list[str]) -> Optional[tuple[int, int]]:
    """[start, end) of the existing slice table: the header pipe-row that names both
    Status and Sub-Issue, plus the contiguous pipe rows after it.

    Deliberately a raw substring match (lenient, to find variant tables) — that
    can locate a header whose actual Sub-Issue/Status columns don't `col_index`
    exact-match (e.g. 'Sub-Issue (native)'). That mismatch is caught downstream:
    `merge_slice_rows` requires both columns via `require_col_index`, which
    raises loudly instead of silently duplicating rows."""
    hdr = next((i for i, ln in enumerate(lines)
                if ln.strip().startswith("|") and "Status" in ln and "Sub-Issue" in ln), None)
    if hdr is None:
        return None
    end = hdr + 1
    while end < len(lines) and lines[end].strip().startswith("|"):
        end += 1
    return hdr, end


def current_slice_table(body: str) -> tuple[list[str], list[list[str]]]:
    """Parse the live slice table — between markers if present, else the located block."""
    if SLICE_TABLE_START in body and SLICE_TABLE_END in body:
        inner = body.split(SLICE_TABLE_START, 1)[1].split(SLICE_TABLE_END, 1)[0]
        return parse_pipe_table(inner.splitlines())
    bounds = locate_slice_table(body.splitlines())
    if bounds is None:
        return [], []
    return parse_pipe_table(body.splitlines()[bounds[0]:bounds[1]])


def splice_slice_table(body: str, table_str: str) -> str:
    """Splice the rendered table between the markers, leaving the rest of the body
    untouched. On the first run (no markers) the existing table block is located and
    replaced with a marked block. Raises if no slice table is found."""
    block = f"{SLICE_TABLE_START}\n{table_str}\n{SLICE_TABLE_END}"
    if SLICE_TABLE_START in body and SLICE_TABLE_END in body:
        pat = re.compile(re.escape(SLICE_TABLE_START) + r".*?" + re.escape(SLICE_TABLE_END),
                         re.DOTALL)
        return pat.sub(lambda _m: block, body)
    lines = body.splitlines()
    bounds = locate_slice_table(lines)
    if bounds is None:
        raise ValueError("no slice table found in anchor body "
                         "(needs a header row naming both Status and Sub-Issue)")
    start, end = bounds
    result = "\n".join(lines[:start] + block.splitlines() + lines[end:])
    return result + "\n" if body.endswith("\n") else result


def extract_anchor_board_data(data: dict, status_field_id: str) -> dict:
    """{sub-issue number: {title, status, prs:[{number,state,headRefName}]}} from the
    anchor sub-issues GraphQL response.

    The status is matched by FIELD ID (`status_field_id` from the profile),
    not by the display name "Status" — a consumer board may call the field
    anything (mirrors the SessionStart hook's field-ID match)."""
    issue = (data.get("data") or {}).get("repository", {}).get("issue")
    nodes = ((issue or {}).get("subIssues") or {}).get("nodes") or []
    out: dict = {}
    for n in nodes:
        prs = ((n.get("closedByPullRequestsReferences") or {}).get("nodes")) or []
        status = None
        for it in ((n.get("projectItems") or {}).get("nodes") or []):
            for fv in ((it.get("fieldValues") or {}).get("nodes") or []):
                if (fv.get("field") or {}).get("id") == status_field_id and fv.get("name"):
                    status = fv["name"]
                    break
            if status:
                break
        out[n["number"]] = {
            "title": n.get("title", ""),
            "status": status,
            "prs": [{"number": p["number"], "state": p["state"],
                     "headRefName": p.get("headRefName")} for p in prs],
        }
    return out
