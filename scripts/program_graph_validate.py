#!/usr/bin/env python3
"""program_graph_validate.py — the 8 Programm-Graph validation axes.

Structural (blocking): Zyklen, Rückwärts-Refs über Wellengrenzen, Kapazität,
Phasen-Optionen, Revisions-Kohärenz. Advisory (counted, shown, non-blocking):
Gate-Slice-Struktur-Verdacht, Rollup-Kette-Lücken, Scope-Abdeckung-Lücken — these
feed the counted Vorschau-Gate report, but a human decides whether an incomplete
draft proceeds; only structural errors are hard.

PURE — no gh / no I/O / no board_config. `phase_options` is injected as a plain
parameter (caller reads it defensively from the board profile CR#1).
"""
from __future__ import annotations

from typing import Optional

from program_graph_parse import ProgramGraph, SliceBlock, WaveRow

# Gate-Legende (docs/agents/wave-anchor-template.md): "—" = AFK/no gate; the four
# non-AFK tags mark a Gate-Slice (Struktur-Verdacht check).
GATE_TYPES = {"🧭", "🔬", "📐", "📝"}


def find_cycles(slices: list[SliceBlock]) -> list[list[str]]:
    """Cycles in the blocked_by graph, each as the ordered path incl. the repeated
    closing id. Unknown targets are ignored here (see `find_unknown_refs`)."""
    ids = {s.local_id for s in slices}
    graph = {s.local_id: [b for b in s.blocked_by if b in ids] for s in slices}
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {k: WHITE for k in graph}
    cycles: list[list[str]] = []
    path: list[str] = []

    def dfs(node: str) -> None:
        color[node] = GRAY
        path.append(node)
        for nxt in graph.get(node, []):
            if color[nxt] == GRAY:
                idx = path.index(nxt)
                cycles.append(path[idx:] + [nxt])
            elif color[nxt] == WHITE:
                dfs(nxt)
        path.pop()
        color[node] = BLACK

    for node in graph:
        if color[node] == WHITE:
            dfs(node)
    return cycles


def find_duplicate_slice_ids(slices: list[SliceBlock]) -> list[str]:
    """Duplicate `local_id`s make the slice graph ambiguous: find_cycles,
    find_backward_refs and the rollup membership dict all key slices by
    local_id (last-wins dict lookups), so a second `#### 1a` block silently
    shadows the first block's blocked_by edges — a blocking cycle living in the
    shadowed block would otherwise go undetected. Same structural error class
    as a cycle (Bug 3)."""
    seen: set[str] = set()
    dupes: list[str] = []
    for s in slices:
        if s.local_id in seen and s.local_id not in dupes:
            dupes.append(s.local_id)
        seen.add(s.local_id)
    return [f"doppelte Slice-ID '{lid}' im Wellenplan — IDs müssen eindeutig sein"
            for lid in dupes]


def find_unknown_refs(slices: list[SliceBlock]) -> list[str]:
    """blocked_by targets that name no existing slice local-id."""
    ids = {s.local_id for s in slices}
    return [f"Slice {s.local_id}: blocked_by unbekannte Referenz '{b}'"
            for s in slices for b in s.blocked_by if b not in ids]


def find_backward_refs(slices: list[SliceBlock]) -> list[str]:
    """blocked_by a LATER wave's slice = a backward ref across the wave boundary
    (a slice may only depend on its own or an earlier wave). Blocking."""
    by_id = {s.local_id: s for s in slices}
    out = []
    for s in slices:
        if s.wave is None:
            continue
        for b in s.blocked_by:
            target = by_id.get(b)
            if target is None or target.wave is None:
                continue
            if target.wave > s.wave:
                out.append(
                    f"Slice {s.local_id} (Welle {s.wave}) blockiert durch {b} "
                    f"(Welle {target.wave}) — Rückwärts-Ref über Wellengrenze")
    return out


def find_gate_dependents_outside_wave(slices: list[SliceBlock]) -> list[str]:
    """A Gate-Slice (🧭/🔬/📐/📝) with dependents in a DIFFERENT wave is a
    structural suspicion — gate-slices are meant to be wave-local (AFK-safe)."""
    warnings = []
    for s in slices:
        if s.gate not in GATE_TYPES:
            continue
        outside = [o for o in slices if s.local_id in o.blocked_by and o.wave != s.wave]
        if outside:
            names = ", ".join(f"{o.local_id} (Welle {o.wave})" for o in outside)
            warnings.append(
                f"Gate-Slice {s.local_id} (Welle {s.wave}) hat wellen-fremde "
                f"Abhängige: {names} — Struktur-Verdacht")
    return warnings


def check_capacity(waves: list[WaveRow], max_children: int = 100) -> list[str]:
    """GitHub's 100-children-per-parent limit, for the PRD→Welle + Welle→Slice fan-outs."""
    errors = []
    if len(waves) > max_children:
        errors.append(f"{len(waves)} Wellen im PRD > {max_children} "
                      f"(GitHub Sub-Issue-Limit je Parent)")
    for w in waves:
        if len(w.slice_ids) > max_children:
            errors.append(f"Welle {w.number}: {len(w.slice_ids)} Slices > "
                          f"{max_children} (GitHub Sub-Issue-Limit je Parent)")
    return errors


def check_phase_options(graph: ProgramGraph, phase_options: Optional[list[str]]) -> list[str]:
    """Every Phase value used (Wellenplan rows or Slice metadata) must be a
    configured option of the board's Phase field. `phase_options=None` means the
    profile has no `fields.phase` at all — a visible setup hint, never a crash
    (CRITICAL RECONCILIATION #2), and only if the PRD uses phases at all
    (a phase-less PRD is unaffected — Phasen sind optional)."""
    used = {w.phase for w in graph.waves if w.phase}
    used |= {s.phase for s in graph.slices if s.phase}
    if not used:
        return []
    if phase_options is None:
        return ["keine Phase-Feld-Konfiguration im Board-Profil gefunden — "
                "Setup-Hinweis: `fields.phase` ergänzen (/setup-workflow)"]
    unknown = sorted(p for p in used if p not in phase_options)
    return [f"Phase '{p}' ist keine Option des Phase-Felds im Board-Profil "
            f"— Setup-Hinweis: Option in /setup-workflow ergänzen" for p in unknown]


def _check_slice_membership(graph: ProgramGraph) -> list[str]:
    """Each Slices-column id must have a Slice-block; each Slice-block must be
    referenced by exactly one wave and belong to a wave that exists."""
    gaps: list[str] = []
    wave_by_number = {w.number: w for w in graph.waves}
    membership: dict[str, int] = {s.local_id: 0 for s in graph.slices}
    for w in graph.waves:
        for sid in w.slice_ids:
            if sid in membership:
                membership[sid] += 1
            else:
                gaps.append(f"Welle {w.number}: Slice '{sid}' in der Slices-Spalte "
                           f"hat keinen Slice-Block")
    for sid, count in membership.items():
        if count == 0:
            gaps.append(f"Slice {sid}: in keiner Wellenplan-Zeile referenziert")
        elif count > 1:
            gaps.append(f"Slice {sid}: in {count} Wellenplan-Zeilen referenziert "
                       f"(erwartet genau 1)")
    for s in graph.slices:
        if s.wave is None:
            gaps.append(f"Slice {s.local_id}: kein wave-Feld gesetzt")
        elif s.wave not in wave_by_number:
            gaps.append(f"Slice {s.local_id}: Welle {s.wave} existiert nicht im Wellenplan")
    return gaps


def _check_wave_completeness(graph: ProgramGraph) -> list[str]:
    """Every wave carries ≥1 slice + a Gate (+ a Phase if the PRD uses phases)."""
    gaps: list[str] = []
    phases_used = any(w.phase for w in graph.waves)
    for w in graph.waves:
        if not w.slice_ids:
            gaps.append(f"Welle {w.number}: keine Slices")
        if not w.gate.strip():
            gaps.append(f"Welle {w.number}: kein Gate-Wert gesetzt")
        if phases_used and not w.phase:
            gaps.append(f"Welle {w.number}: keine Phase gesetzt, obwohl das "
                       f"Programm Phasen nutzt")
    return gaps


def _check_phase_gate_pairing(graph: ProgramGraph) -> list[str]:
    """Every used Phase has a checklist Gate-Kriterium, and every checklist entry
    names a Phase some wave uses."""
    gaps: list[str] = []
    phases_used = {w.phase for w in graph.waves if w.phase}
    for phase in phases_used:
        if phase not in graph.phase_gates:
            gaps.append(f"Phase {phase}: kein Gate-Kriterium in der "
                       f"Phasen-Gates-Checkliste")
    for phase in graph.phase_gates:
        if phase not in phases_used:
            gaps.append(f"Phase {phase}: keine Welle referenziert diese Phase "
                       f"(Checklisten-Waise)")
    return gaps


def check_rollup(graph: ProgramGraph) -> list[str]:
    """Vertical completeness: the Programm→Welle→Slice rollup chain is closed
    (slice↔wave membership + per-wave completeness + phase↔gate pairing)."""
    return [*_check_slice_membership(graph), *_check_wave_completeness(graph),
            *_check_phase_gate_pairing(graph)]


def check_scope_coverage(graph: ProgramGraph) -> tuple[int, int, list[str]]:
    """Horizontal completeness: every Scope-Item is covered by ≥1 wave, every wave
    covers ≥1 Scope-Item or is explicitly marked `enabler`, and every covers token
    names a declared Scope-Item (an `S99` typo is a non-blocking gap of its own —
    advisory, and doesn't affect the covered/total count below). Returns
    (covered_count, total_count, gap_messages)."""
    gaps: list[str] = []
    covered_ids: set = set()
    for w in graph.waves:
        if not w.covers and not w.is_enabler:
            gaps.append(f"Welle {w.number}: keine Scope-Abdeckung und nicht als "
                       f"Enabler markiert")
        for token in w.covers:
            if token not in graph.scope_items:
                gaps.append(f"Welle {w.number}: covers unbekanntes Scope-Item "
                           f"'{token}'")
        covered_ids.update(w.covers)
    covered = 0
    for sid in graph.scope_items:
        if sid in covered_ids:
            covered += 1
        else:
            gaps.append(f"Scope-Item {sid}: von keiner Welle abgedeckt")
    return covered, len(graph.scope_items), gaps


def check_revision_coherence(plan_revision: Optional[int],
                             stub_revisions: Optional[list[dict]]) -> list[str]:
    """A published Welle-Stub whose `<!-- program-revision: rN -->` marker (stamped
    by `to-waves`) no longer matches the PRD's plan_revision is stale — it blocks
    loudly instead of silently building from an outdated plan.

    `stub_revisions` (`[{"label": str, "revision": int | None}, …]`) is pre-fetched
    by the caller (this module stays I/O-free); the CLI passes `[]` when no stubs
    are fetched pre-publish, and callers wire in the real fetch via the same
    signature."""
    if not stub_revisions:
        return []
    if plan_revision is None:
        return ["PRD hat kein plan_revision — Revisions-Kohärenz nicht prüfbar"]
    out = []
    for stub in stub_revisions:
        label = stub.get("label", "?")
        rev = stub.get("revision")
        if rev is None:
            out.append(f"{label}: kein program-revision-Marker gefunden")
        elif rev != plan_revision:
            out.append(f"{label}: program-revision r{rev} != PRD plan_revision "
                       f"r{plan_revision} — stale")
    return out
