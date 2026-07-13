#!/usr/bin/env python3
"""portability_profile_scan.py — profile-VALUE literal scan (#1878, Welle 49
Slice 7, extends the portability lint in test_skill_portability_lint.py).

A published (generic/vendored) skill body must reference the board profile
(`docs/agents/board-sync.md`, loaded by `board_config.py`) by KEY —
`prMarkers.retroValues`, `headings.vorBau` — never MANDATE the literal VALUE
a profile happens to configure (e.g. testreporter's `gefahren`/`übersprungen`,
`Vor Bau zu klären`). A consumer whose profile configures different words
silently fails a skill that hardcoded testreporter's wording as required —
the same drift class `test_skill_portability_lint.py`'s CONSTANT_PATTERNS
scan already closes for opaque board node/option ids; this closes it for the
human-facing convention words instead.

A line that also names the profile key is a reference, not a hardcode —
exempt (mirrors CONSTANT_PATTERNS' own exempt rule). A line carrying
`portability-lint: ok` is exempt too (deliberate doc example, e.g. a
copy-paste-ready marker/heading example where inlining the key would corrupt
the example).
"""
from __future__ import annotations

import re

EXEMPT = "portability-lint: ok"

# (label, literal pattern, profile-key substring whose presence on the same
# line exempts the match — a reference, not a hardcode).
PROFILE_VALUE_PATTERNS = [
    # prMarkers.retroValues — the two configured PR "**Retro:**"-line words.
    # Backtick-quoted only: bare "gefahren"/"übersprungen" are ordinary German
    # words (past participles of fahren/überspringen) outside this
    # convention — unquoted would false-positive on normal prose (e.g. "Retro
    # schon gefahren?").
    ("prMarkers.retroValues literal", re.compile(r"`(?:gefahren|übersprungen)`"), "retroValues"),
    # headings.vorBau — the configured HITL heading text. The phrase is
    # specific enough that no quoting requirement is needed.
    ("headings.vorBau literal", re.compile(r"Vor Bau zu klären"), "vorBau"),
]


def find_profile_value_literals(text: str) -> list[tuple[int, str, str]]:
    """Return (line_no, label, line) for every hardcoded MANDATORY profile-value
    literal, minus lines that also reference the profile key (a profile-driven
    reference, not a hardcode) or carry the exempt marker."""
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        if EXEMPT in line:
            continue
        for label, pattern, key in PROFILE_VALUE_PATTERNS:
            if pattern.search(line) and key not in line:
                out.append((n, label, line.strip()))
    return out
