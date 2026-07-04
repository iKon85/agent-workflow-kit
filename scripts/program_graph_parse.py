#!/usr/bin/env python3
"""program_graph_parse.py — pure parser for the Programm-PRD grammar.

Parses a Program-PRD issue body (per `.claude/skills/to-prd/PROGRAM-PRD-FORMAT.md`)
into structured dataclasses: plan_revision, Scope-Items (S1, S2, …), the Wellenplan
table (Welle/Status/Name/Phase/Slices/Gate/covers), the Phasen-Gates checklist,
and the per-Slice metadata blocks (per
`.claude/skills/to-waves/SLICE-METADATA-FORMAT.md`).

PURE — no gh / no I/O / no board_config. Reuses the generic pipe-table primitives
from anchor_table.py (a different table GRAMMAR — different columns, different
node kinds — but the same markdown mechanics, so the parse/render primitives are
shared rather than re-implemented design decision).

The Wellenplan-table renderer lives here too (parser↔renderer roundtrip pair,
consumed later by `program-sync`, Welle 52 Slice 3).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from anchor_table import col_index, parse_pipe_table, render_pipe_table

PLAN_REV_RE = re.compile(r"\*\*plan_revision:\*\*\s*r(\d+)\b")
_H2_RE = re.compile(r"^##\s+(.+?)\s*$")
SCOPE_ITEM_RE = re.compile(r"^-\s+\*\*(S\d+):\*\*\s*(.+)$")
PHASE_GATE_RE = re.compile(r"^-\s+\[([ xX])\]\s*(P\d+):\s*(.+)$")

WELLENPLAN_START = "<!-- wellenplan:start -->"
WELLENPLAN_END = "<!-- wellenplan:end -->"

WELLENPLAN_HEADERS = ["Welle", "Status", "Name", "Phase", "Slices", "Gate", "covers"]
_ENABLER = "enabler"
# Tokens that mean "no value" in an optional cell — shared by the Wellenplan phase
# and covers cells and the Slice-block phase/blocked_by fields so `—` normalizes
# consistently everywhere.
_NONE_TOKENS = {"none", "", "—", "-"}


def _none_if_blank(value: str) -> Optional[str]:
    """The trimmed value, or None if it is one of the `_NONE_TOKENS` sentinels."""
    v = (value or "").strip()
    return None if v.lower() in _NONE_TOKENS else v


@dataclass
class WaveRow:
    number: int
    name: str
    phase: Optional[str]
    slice_ids: list[str]
    gate: str
    covers: list[str]
    is_enabler: bool = False
    # Volatile, board-derived — ⬜ (not started) at authoring, regenerated
    # monotonically by `program-sync` (see program_sync.refresh_wave_status).
    # Not a validate-graph input (no axis reads it) and — unlike the semantic
    # columns above — TOLERANT-optional on parse (docs/adr/0054 Folge-Arbeit:
    # one Wellenplan grammar, this is a column within it, not a second table).
    status: str = "⬜"


@dataclass
class SliceBlock:
    local_id: str
    title: str
    wave: Optional[int]
    phase: Optional[str]
    area: Optional[str]
    gate: str
    blocked_by: list[str] = field(default_factory=list)


@dataclass
class ProgramGraph:
    plan_revision: Optional[int]
    scope_items: dict[str, str]
    waves: list[WaveRow]
    slices: list[SliceBlock]
    phase_gates: dict[str, str]


def parse_plan_revision(body: str) -> Optional[int]:
    """The PRD's top-level `**plan_revision:** rN`, or None if absent/malformed."""
    m = PLAN_REV_RE.search(body or "")
    return int(m.group(1)) if m else None


def _section_lines(body: str, heading: str) -> list[str]:
    """Lines of a `## <heading>` section, up to (excl.) the next `##` heading."""
    lines = (body or "").splitlines()
    start = None
    for i, ln in enumerate(lines):
        m = _H2_RE.match(ln)
        if m and m.group(1).strip() == heading:
            start = i + 1
            break
    if start is None:
        return []
    end = len(lines)
    for j in range(start, len(lines)):
        if _H2_RE.match(lines[j]):
            end = j
            break
    return lines[start:end]


def parse_scope_items(body: str) -> dict[str, str]:
    """`{S1: "description", ...}` from the `## Scope` chapter's `- **S1:** …` list."""
    items: dict[str, str] = {}
    for ln in _section_lines(body, "Scope"):
        m = SCOPE_ITEM_RE.match(ln.strip())
        if m:
            items[m.group(1)] = m.group(2).strip()
    return items


def parse_phase_gates(body: str) -> dict[str, str]:
    """`{P1: "criterion text", ...}` from the `## Phasen-Gates` checklist."""
    gates: dict[str, str] = {}
    for ln in _section_lines(body, "Phasen-Gates"):
        m = PHASE_GATE_RE.match(ln.strip())
        if m:
            gates[m.group(2)] = m.group(3).strip()
    return gates


def _split_csv(cell: str) -> list[str]:
    return [t.strip() for t in (cell or "").split(",") if t.strip()]


def _parse_covers_cell(cell: str) -> tuple[list[str], bool]:
    tokens = _split_csv(cell)
    if len(tokens) == 1 and tokens[0].lower() == _ENABLER:
        return [], True
    # `—`/`-`/`none` tokens are the same "no value" sentinels as the phase and
    # blocked_by cells — an all-sentinel covers cell must normalize to [], not
    # a phantom covers=['—'] that then fools check_scope_coverage (Bug 1).
    tokens = [t for t in tokens if t.lower() not in _NONE_TOKENS]
    return tokens, False


def parse_wellenplan_table(body: str) -> list[WaveRow]:
    """The Wellenplan table between the `wellenplan:start/end` markers. `Phase` is an
    optional column (Phasen sind optional) — absent column ⇒ every row's phase=None.
    `Status` is likewise optional, but for a different reason: it is volatile,
    board-derived state (never authored by hand), so an absent column or blank
    cell ⇒ every row's status defaults to `⬜` rather than raising — same
    tolerant treatment as Phase, distinct from the required semantic columns."""
    if WELLENPLAN_START not in body or WELLENPLAN_END not in body:
        return []
    inner = body.split(WELLENPLAN_START, 1)[1].split(WELLENPLAN_END, 1)[0]
    headers, rows = parse_pipe_table(inner.splitlines())
    if not headers:
        return []
    idx = {name: col_index(headers, name) for name in WELLENPLAN_HEADERS}
    i_phase = idx["Phase"]  # optional column — may be None
    i_status = idx["Status"]  # optional column — may be None, defaults to ⬜
    missing = [name for name in WELLENPLAN_HEADERS
               if name not in ("Phase", "Status") and idx[name] is None]
    if missing:
        raise ValueError(
            f"Wellenplan table missing column(s) {', '.join(missing)} "
            f"(headers: {headers})")
    out: list[WaveRow] = []
    for row in rows:
        cell = lambda i: row[i].strip() if i is not None and i < len(row) else ""
        covers, is_enabler = _parse_covers_cell(cell(idx["covers"]))
        out.append(WaveRow(
            number=int(cell(idx["Welle"])),
            name=cell(idx["Name"]),
            phase=_none_if_blank(cell(i_phase)),
            slice_ids=_split_csv(cell(idx["Slices"])),
            gate=cell(idx["Gate"]) or "—",
            covers=covers,
            is_enabler=is_enabler,
            status=cell(i_status) or "⬜",
        ))
    return out


def render_wellenplan_table(waves: list[WaveRow], *, include_phase: bool = True) -> str:
    """Render the Wellenplan table (markers + pipe table) — inverse of
    `parse_wellenplan_table` (roundtrip pair). `Status` is always emitted (it is
    always present, unlike `Phase` which is toggled by `include_phase` — the
    only column `program-sync` ever rewrites)."""
    headers = [h for h in WELLENPLAN_HEADERS if include_phase or h != "Phase"]
    rows = []
    for w in waves:
        covers_cell = _ENABLER if w.is_enabler else ", ".join(w.covers)
        cells = {
            "Welle": str(w.number),
            "Status": w.status,
            "Name": w.name,
            "Phase": w.phase or "",
            "Slices": ", ".join(w.slice_ids),
            "Gate": w.gate,
            "covers": covers_cell,
        }
        rows.append([cells[h] for h in headers])
    table = render_pipe_table(headers, rows)
    return f"{WELLENPLAN_START}\n{table}\n{WELLENPLAN_END}"


SLICE_HEADING_RE = re.compile(r"^####\s+(\S+)\s+—\s+(.+)$")
META_FIELD_RE = re.compile(r"^<!--\s*(wave|phase|area|gate|blocked_by):\s*(.*?)\s*-->$")


def parse_slice_blocks(body: str) -> list[SliceBlock]:
    """The `#### <local-id> — <Title>` sections of `## Slices`, each carrying a
    5-field HTML-comment metadata block (SLICE-METADATA-FORMAT.md)."""
    lines = (body or "").splitlines()
    heads = []
    for i, ln in enumerate(lines):
        m = SLICE_HEADING_RE.match(ln.strip())
        if m:
            heads.append((i, m.group(1), m.group(2).strip()))
    blocks: list[SliceBlock] = []
    for idx, (start, local_id, title) in enumerate(heads):
        end = heads[idx + 1][0] if idx + 1 < len(heads) else len(lines)
        fields: dict[str, str] = {}
        for ln in lines[start + 1:end]:
            m = META_FIELD_RE.match(ln.strip())
            if m:
                fields[m.group(1)] = m.group(2)
        wave_raw = fields.get("wave", "").strip()
        blocked_raw = fields.get("blocked_by", "none").strip()
        blocked_by = [] if blocked_raw.lower() in _NONE_TOKENS else _split_csv(blocked_raw)
        blocks.append(SliceBlock(
            local_id=local_id,
            title=title,
            wave=int(wave_raw) if wave_raw.isdigit() else None,
            phase=_none_if_blank(fields.get("phase", "")),
            area=(fields.get("area") or "").strip() or None,
            gate=(fields.get("gate") or "").strip() or "—",
            blocked_by=blocked_by,
        ))
    return blocks


def render_slice_block(s: SliceBlock) -> str:
    """Render one Slice section — inverse of the per-block parse in
    `parse_slice_blocks` (roundtrip pair)."""
    blocked = "none" if not s.blocked_by else ", ".join(s.blocked_by)
    return (
        f"#### {s.local_id} — {s.title}\n"
        f"<!-- wave: {s.wave if s.wave is not None else ''} -->\n"
        f"<!-- phase: {s.phase or '—'} -->\n"
        f"<!-- area: {s.area or ''} -->\n"
        f"<!-- gate: {s.gate} -->\n"
        f"<!-- blocked_by: {blocked} -->\n"
    )


def parse_program_prd(body: str) -> ProgramGraph:
    """The full ProgramGraph parsed from a Program-PRD issue body."""
    return ProgramGraph(
        plan_revision=parse_plan_revision(body),
        scope_items=parse_scope_items(body),
        waves=parse_wellenplan_table(body),
        slices=parse_slice_blocks(body),
        phase_gates=parse_phase_gates(body),
    )
