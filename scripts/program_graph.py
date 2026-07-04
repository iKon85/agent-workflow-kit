#!/usr/bin/env python3
"""program_graph.py — public assembly + report layer for the Programm-Graph.

board-sync.py's `validate-graph` command imports from this one module. The
implementation is split by concern across three cohesive files (a single file
would exceed the 300-line size gate):

  - program_graph_parse.py     — parse the Program-PRD body into dataclasses +
                                  the Wellenplan-table / Slice-block renderers
                                  (parser↔renderer roundtrip pairs).
  - program_graph_validate.py  — the 8 pure validation axes over the parsed graph.
  - this file                  — the `GraphReport` model, the `validate_program_graph`
                                  orchestrator wiring the axes together, the counted
                                  `render_report`, plus a flat re-export of the
                                  parse/validate symbols consumers use.

PURE — no gh / no I/O / no board_config (mirrors anchor_table.py's purity
contract). The CLI handler in board-sync.py reads `phase_options`
defensively from the board profile and passes it in (CR#1).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from program_graph_parse import (  # noqa: F401
    ProgramGraph,
    SliceBlock,
    WaveRow,
    parse_phase_gates,
    parse_plan_revision,
    parse_program_prd,
    parse_scope_items,
    parse_slice_blocks,
    parse_wellenplan_table,
    render_slice_block,
    render_wellenplan_table,
)
from program_graph_validate import (  # noqa: F401
    GATE_TYPES,
    check_capacity,
    check_phase_options,
    check_revision_coherence,
    check_rollup,
    check_scope_coverage,
    find_backward_refs,
    find_cycles,
    find_duplicate_slice_ids,
    find_gate_dependents_outside_wave,
    find_unknown_refs,
)


@dataclass
class GraphReport:
    scope_total: int
    scope_covered: int
    scope_gaps: list[str]
    rollup_gaps: list[str]
    cycles: list[list[str]]
    backward_refs: list[str]
    gate_warnings: list[str]
    capacity_errors: list[str]
    phase_errors: list[str]
    revision_mismatches: list[str]
    duplicate_id_errors: list[str]

    @property
    def cycle_messages(self) -> list[str]:
        return [f"Zyklus: {' → '.join(c)}" for c in self.cycles]

    @property
    def errors(self) -> list[str]:
        """Blocking findings — Vorschau-Gate publish must not proceed."""
        return [*self.cycle_messages, *self.backward_refs, *self.capacity_errors,
                *self.phase_errors, *self.revision_mismatches, *self.duplicate_id_errors]

    @property
    def warnings(self) -> list[str]:
        """Advisory findings — shown + counted, but a human decides."""
        return [*self.gate_warnings, *self.rollup_gaps, *self.scope_gaps]

    @property
    def blocking(self) -> bool:
        return bool(self.errors)


def validate_program_graph(prd_body: str, *, phase_options: Optional[list[str]] = None,
                           max_children: int = 100,
                           stub_revisions: Optional[list[dict]] = None) -> GraphReport:
    """The single entry point: parse a Program-PRD body and run all 8 axes."""
    graph = parse_program_prd(prd_body)
    covered, total, scope_gaps = check_scope_coverage(graph)
    return GraphReport(
        scope_total=total,
        scope_covered=covered,
        scope_gaps=scope_gaps,
        rollup_gaps=check_rollup(graph),
        cycles=find_cycles(graph.slices),
        backward_refs=[*find_backward_refs(graph.slices), *find_unknown_refs(graph.slices)],
        gate_warnings=find_gate_dependents_outside_wave(graph.slices),
        capacity_errors=check_capacity(graph.waves, max_children),
        phase_errors=check_phase_options(graph, phase_options),
        revision_mismatches=check_revision_coherence(graph.plan_revision, stub_revisions),
        duplicate_id_errors=find_duplicate_slice_ids(graph.slices),
    )


def render_report(report: GraphReport) -> str:
    """The counted Vorschau-Gate summary line + detail lines (AC1)."""
    summary = (
        f"Scope-Abdeckung {report.scope_covered} von {report.scope_total} · "
        f"Rollup-Kette {'✓' if not report.rollup_gaps else 'Lücken'} · "
        f"zyklenfrei {'✓' if not report.cycles else '✗'} · "
        f"Kapazität {'✓' if not report.capacity_errors else '✗'} · "
        f"Phasen-Optionen {'✓' if not report.phase_errors else '✗'}"
    )
    lines = [summary]
    for msg in report.errors:
        lines.append(f"  FEHLER: {msg}")
    for msg in report.warnings:
        lines.append(f"  WARNUNG: {msg}")
    if not report.errors and not report.warnings:
        lines.append("  keine weiteren Befunde")
    return "\n".join(lines)
