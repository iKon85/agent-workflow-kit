#!/usr/bin/env python3
"""LoC-offender drive gate — PURE decision core (, Welle 37 N10, ADR-0034).

The decision logic + structured Loc-Defer parsing. No I/O. The git/subprocess
adapter + CLI live in loc_offender_gate.py, which imports this module. Splitting
keeps each file <= the 300-line size gate this very slice enforces.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# Band thresholds (changed = added + deleted LoC of the offender file in the slice).
EXEMPT_LOC = 5  # <= this: trivial touch, exempt
SUBSTANTIAL_LOC = 30  # >= this: substantial → shrink-or-defer owed; 6..29 = warn

DEFER_REASONS = {"grossfile-partial", "risky-split", "vendored-adjacent", "hotfix"}


@dataclass(frozen=True)
class FileChange:
    """One file's change in the slice diff (base..head)."""

    path: str  # current (post-rename) repo-root POSIX path
    old_path: str | None  # pre-rename path, or None if not renamed
    changed_loc: int  # added + deleted
    head_lines: int | None  # current line count; None if the file was deleted
    base_lines: int  # line count at the slice base
    binary: bool = False  # numstat reported '-'/'-' (unparseable)


@dataclass(frozen=True)
class Defer:
    """A parsed, well-formed Loc-Defer trailer."""

    file: str
    reason: str
    followup: str | None  # e.g. ''
    reduced_net: int | None


@dataclass
class Verdict:
    ok: bool = True
    reds: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def exit_code(self) -> int:
        return 0 if self.ok else 1


def normalize_defer_path(raw: str):
    """Return (path, error). repo-root POSIX path, leading './' stripped.
    Absolute paths and parent traversal ('..') are rejected (defer must name a
    repo-relative offender, never escape the tree)."""
    p = (raw or "").strip().replace("\\", "/")
    if not p:
        return None, "leerer file-Pfad"
    if p.startswith("/"):
        return None, f"absoluter Pfad nicht erlaubt: {p}"
    while p.startswith("./"):
        p = p[2:]
    if p == ".." or p.startswith("../") or "/../" in p or p.endswith("/.."):
        return None, f"Pfad-Traversal ('..') nicht erlaubt: {p}"
    return p, None


def _parse_one(value: str):
    """Parse one `file=…; reason=…; followup=…; reduced_net=…` trailer value.
    Return (Defer, error). Syntactic validity only (enum, required-field rule,
    path); the reduced_net-vs-reality check is semantic → done in evaluate()."""
    fields: dict[str, str] = {}
    for part in value.split(";"):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            return None, f"malformter Trailer-Teil (kein key=value): {part!r}"
        k, _, val = part.partition("=")
        fields[k.strip()] = val.strip()

    raw_file = fields.get("file")
    if not raw_file:
        return None, f"Loc-Defer ohne file=: {value!r}"
    path, perr = normalize_defer_path(raw_file)
    if perr:
        return None, perr

    reason = fields.get("reason")
    if reason not in DEFER_REASONS:
        return None, f"unbekannter reason={reason!r} (erlaubt: {sorted(DEFER_REASONS)})"

    followup = fields.get("followup") or None
    reduced_raw = fields.get("reduced_net")
    reduced_net = None
    if reduced_raw is not None:
        if not reduced_raw.lstrip("#").isdigit() or int(reduced_raw.lstrip("#")) <= 0:
            return None, f"reduced_net muss positive Ganzzahl sein, war {reduced_raw!r}"
        reduced_net = int(reduced_raw)

    if followup is None and reduced_net is None:
        return None, f"Loc-Defer für {path} braucht followup=#n ODER reduced_net>0"

    return Defer(file=path, reason=reason, followup=followup, reduced_net=reduced_net), None


def parse_loc_defer_trailers(values):
    """Parse all `Loc-Defer:` trailer values from the slice commits.
    Return (defers, errors). A duplicate `file=` (same offender twice) is an
    error — ambiguous intent → fail-closed."""
    defers: list[Defer] = []
    errors: list[str] = []
    seen: set[str] = set()
    for value in values:
        defer, err = _parse_one(value)
        if err:
            errors.append(err)
            continue
        if defer.file in seen:
            errors.append(f"doppelter Loc-Defer für {defer.file} — mehrdeutig.")
            continue
        seen.add(defer.file)
        defers.append(defer)
    return defers, errors


def _defer_covers(defer: Defer, change: FileChange) -> tuple[bool, str | None]:
    """Semantic check: does this (already syntactically-valid) defer actually cover
    the change? Returns (ok, error). reduced_net may not over-declare the real
    reduction; grossfile-partial needs reduced_net >= changed OR a followup."""
    actual_reduction = (change.base_lines - change.head_lines) if change.head_lines is not None else change.base_lines
    if defer.reduced_net is not None and defer.reduced_net > actual_reduction:
        return False, (
            f"{defer.file}: reduced_net={defer.reduced_net} über-deklariert "
            f"(reale Reduktion {actual_reduction}).")
    if defer.reason == "grossfile-partial":
        meets_reduced = defer.reduced_net is not None and defer.reduced_net >= change.changed_loc
        if not meets_reduced and not defer.followup:
            return False, (
                f"{defer.file}: grossfile-partial verlangt reduced_net >= "
                f"{change.changed_loc} (changed) ODER followup.")
    return True, None


def offender_key(change: FileChange) -> str:
    """The baseline path a change is matched against: the OLD path on a rename
    (the offender was listed under its pre-rename path), else the current path."""
    return change.old_path or change.path


def evaluate(changes, offenders, defers, max_lines, defer_errors=None) -> Verdict:
    """Pure decision over the slice diff. Red if any substantial offender touch
    is neither shrunk nor validly deferred. A non-empty `defer_errors` (malformed/
    duplicate trailers from parse_loc_defer_trailers) is a global fail-closed red."""
    v = Verdict()
    for err in defer_errors or []:
        v.ok = False
        v.reds.append(f"malformter Loc-Defer-Trailer → fail-closed: {err}")
    by_key = {d.file: d for d in defers}
    for ch in changes:
        key = offender_key(ch)
        if key not in offenders:
            continue
        # Binary/unparseable numstat is checked FIRST: collect_changes reports
        # changed_loc=0 for a binary file, so a band check would exempt it before
        # this defensive fail-closed could fire. (Should never hit for .ts/.tsx.)
        if ch.binary:
            v.ok = False
            v.reds.append(f"{key}: binäres/unparsebares numstat für einen Offender → fail-closed.")
            continue
        if ch.changed_loc <= EXEMPT_LOC:
            continue
        if ch.changed_loc < SUBSTANTIAL_LOC:
            v.warnings.append(
                f"{key}: {ch.changed_loc} LoC geändert (6–{SUBSTANTIAL_LOC - 1} = "
                "Warnung) — beim nächsten substanziellen Touch schrumpfen.")
            continue
        # Substantial touch (>= SUBSTANTIAL_LOC).
        if ch.head_lines is None:  # deleted = best possible shrink
            continue
        if ch.head_lines <= max_lines or ch.head_lines < ch.base_lines:
            continue  # under the limit, or net-shrunk → green (prune enforced by)
        # Still > max_lines, no net shrink → needs a valid defer.
        defer = by_key.get(key)
        if defer is not None:
            covers, derr = _defer_covers(defer, ch)
            if covers:
                continue
            v.ok = False
            v.reds.append(derr)
            continue
        v.ok = False
        v.reds.append(
            f"{key} ({ch.head_lines}>{max_lines}) ≥{SUBSTANTIAL_LOC} LoC angefasst, "
            "nicht geschrumpft, kein Loc-Defer.")
    return v
