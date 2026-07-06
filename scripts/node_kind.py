#!/usr/bin/env python3
"""node_kind.py — pure node-kind classifier shared by execute-ready-check.py
.

execute-ready-check.py used to infer "is this an anchor?" structurally (no
native parent + has children). That heuristic breaks the moment an anchor gets
a NATIVE parent of its own — a Welle-Anker promoted under a Programm-PRD, or
the Programm-PRD itself: the checker would climb to the parent and audit the
anchor as if it were a plain leaf, forcing a bucket + rev-match on itself and
on its sibling anchors (which don't carry a bucket by design).

This module replaces that heuristic with an EXPLICIT classification, read off
the node's own labels/body — never off its position in the graph:

  program   — `<!-- prd: program -->` body marker. Highest precedence (a
              distinct object, wins over any label a Programm-PRD might also
              carry). Deliberately marker-only — the `type:program` label is a
              LATER slice's addition; this module needs no profile key
              for it and must keep working before that label exists.
  anchor    — `type:cluster` label. Wins over `wave-stub` when a node somehow
              carries both (a drift/transition state) — mirrors the
              to-prd/to-issues precedence ("type:cluster stops always; Wave
              stops unless wave-stub").
  wave_stub — `wave-stub` label (a board-to-waves candidate stub, OR an
              un-promoted Stufe-1p program stub — same label, two
              provenances, both structurally "not yet an anchor").
  leaf      — none of the above; an ordinary slice/child issue.

ROOT_KINDS = {program, anchor}: execute-ready-check.py evaluates these at
their OWN local root (their own children as siblings) and never lifts them to
a real parent, even when one exists. The multi-level, programme-wide graph
validation is validate-graph's job — this stays
rooted-local (target + at most one level of children).

Pure + I/O-free by design (mirrors anchor_table.py) — directly unit-tested
with plain dicts, no gh/board_config coupling.
"""
from __future__ import annotations

import re

PROGRAM = "program"
ANCHOR = "anchor"
WAVE_STUB = "wave_stub"
LEAF = "leaf"

ROOT_KINDS = frozenset({PROGRAM, ANCHOR})

PROGRAM_MARKER_RE = re.compile(r"<!--\s*prd:\s*program\s*-->")


def classify_node(node: dict, *, cluster_type_label: str | None,
                   wave_stub_label: str | None) -> str:
    """program | anchor | wave_stub | leaf for `node` ({body, labels, ...}).

    `cluster_type_label`/`wave_stub_label` come from the board profile
    (`_CFG["labels"].get(...)`) — passed in rather than read here so this
    module stays board-profile-free and directly testable.
    """
    body = node.get("body") or ""
    labels = node.get("labels") or []
    if PROGRAM_MARKER_RE.search(body):
        return PROGRAM
    if cluster_type_label and cluster_type_label in labels:
        return ANCHOR
    if wave_stub_label and wave_stub_label in labels:
        return WAVE_STUB
    return LEAF
