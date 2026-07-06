#!/usr/bin/env python3
"""program_sync.py — Wellenplan Status-resync for `board-sync.py program-sync`
(plan step 9b(d); Status column amendment).

A Program-PRD's `## Wellenplan` table is its OWN grammar (Welle/Status/Name/
Slices/Gate/covers — parsed by `program_graph_parse.py`), one level above a
Welle-Anchor's own Slices-table. `anchor-sync` (`anchor_table.py`) already
regenerates an Anchor's Slice-row Status/Branch from its native sub-issues;
`program-sync` does the SAME KIND of thing one graph level up — a PRD's native
sub-issues are its promoted Wave-Anchor stubs — but deliberately as a SEPARATE
command over a SEPARATE grammar (plan 9b(d): "program-sync statt
anchor-sync-Überladung"), not a second table format bolted onto either module.

`WaveRow` carries a dedicated `status` field (docs/adr/0054 §Folge-Arbeit forbids
only a SECOND Wellenplan table format, not a Status COLUMN within the one
grammar). The volatile Status therefore lives in its own cell, refreshed
MONOTONICALLY (never ✅→🔄→⬜, mirroring `anchor_table.refresh_status_cell`'s
never-regress rule) — the `Name` cell is left entirely untouched by this sync:
hand annotations there always survive verbatim, and Status is the only column
`program-sync` ever rewrites.

PURE — no gh / no I/O / no board_config. Only imports `WaveRow` from
`program_graph`'s public facade (never re-implementing the Wellenplan
parser/renderer — `program_graph_parse.py` owns that grammar).
"""
from __future__ import annotations

import re
from dataclasses import replace
from typing import Optional

from program_graph import WaveRow

_WAVE_NUMBER_RE = re.compile(r"^\s*Welle\s+(\d+)\s*[—–-]", re.IGNORECASE)
_STATUS_RANK = {"⬜": 0, "🔄": 1, "✅": 2}

_WELLENPLAN_BLOCK_RE = re.compile(
    r"<!--\s*wellenplan:start\s*-->.*?<!--\s*wellenplan:end\s*-->", re.DOTALL)


def extract_wave_number_from_title(title: str) -> Optional[int]:
    """The wave number out of a promoted Wave-Anchor's `Welle <N> — <Thema>`
    title (the same convention `board-sync.py`'s `wave_title()` writes), or
    None for a title that isn't wave-prefixed (not yet promoted / foreign)."""
    m = _WAVE_NUMBER_RE.match(title or "")
    return int(m.group(1)) if m else None


def wave_status_token(entry: Optional[dict], roles: dict) -> str:
    """⬜ (no matching native child yet — not promoted) · 🔄 (an in-flight
    board status) · ✅ (the done-role status). Deliberately NOT
    `anchor_table.status_token_from_board` — a Wave-Anchor issue is never
    `closes`-referenced by a PR (board-sync.md convention: `closes` never
    targets an Anker), so a Wave's completion is read off its OWN board Status
    field, not a merged-PR check.

    Status NAMES come from the profile's role map (`roles["done"]`,
    `roles["inProgress"]`/`roles["review"]`), passed as a plain dict so
    this module stays pure. Empty roles → every status reads as ⬜ (the
    monotone refresh never regresses a hand-set cell)."""
    if entry is None:
        return "⬜"
    status = entry.get("status")
    if status and status == roles.get("done"):
        return "✅"
    if status and status in ({roles.get("inProgress"), roles.get("review")} - {None}):
        return "🔄"
    return "⬜"


def refresh_wave_status(existing_status: str, token: str) -> str:
    """Refresh a Wellenplan row's Status cell from the board, MONOTONICALLY
    (never regress ✅→🔄→⬜ — mirrors `anchor_table.refresh_status_cell`'s
    never-regress rule). An existing cell that isn't a known token (unset,
    blank, or hand-typed garbage) ranks below ⬜ (rank -1), so the first sync
    always sets it."""
    existing_rank = _STATUS_RANK.get(existing_status, -1)
    token_rank = _STATUS_RANK.get(token, -1)
    if token_rank < existing_rank:
        return existing_status
    return existing_status if existing_status == token else token


def sync_wellenplan_status(waves: list[WaveRow], board: dict, roles: dict) -> list[WaveRow]:
    """A fresh `WaveRow` list with each row's `status` field refreshed from
    `board` — the SAME `{issue: {title, status, prs}}` shape
    `anchor_table.extract_anchor_board_data` already produces (no second query,
    no second parse: the PRD's native sub-issues — its promoted Wave-Anchor
    stubs — are fetched exactly like an Anchor fetches its Slice sub-issues).
    Every other WaveRow field (Name/Phase/Slices/Gate/covers/is_enabler) round-
    trips untouched — those are stable Plan columns (or, for Name, hand-owned
    prose), never board-derived."""
    by_wave_number: dict[int, dict] = {}
    for entry in board.values():
        n = extract_wave_number_from_title(entry.get("title", ""))
        if n is not None:
            by_wave_number[n] = entry
    return [replace(w, status=refresh_wave_status(w.status, wave_status_token(by_wave_number.get(w.number), roles)))
            for w in waves]


def splice_wellenplan_table(body: str, rendered_block: str) -> str:
    """Replace the `<!-- wellenplan:start/end -->` block with a freshly
    rendered one (`program_graph.render_wellenplan_table`'s output already
    carries its own markers). Mirrors `anchor_table.splice_slice_table`'s
    marker-replace mechanic — kept HERE rather than shared with it, because
    this is a different table grammar entirely (plan 9b(d))."""
    if not _WELLENPLAN_BLOCK_RE.search(body):
        raise ValueError(
            "no Wellenplan table found in program body (needs "
            "`<!-- wellenplan:start -->`/`<!-- wellenplan:end -->` markers)")
    return _WELLENPLAN_BLOCK_RE.sub(lambda _m: rendered_block, body)
