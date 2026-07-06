#!/usr/bin/env python3
"""board_config.py — shared loader for the board-sync profile.

The planning scripts (board-sync.py / execute-ready-check.py / pr-body-check.py)
carry NO inline board IDs. They read every board-specific value — field IDs,
status option names, labels, branch prefixes, PR-body markers, headings — from a
single machine-readable profile embedded in `docs/agents/board-sync.md`:

    <!-- board-sync:profile -->
    ```json
    { "repo": "...", "project": {...}, "fields": {...}, ... }
    ```

A fenced ```json block is the SSOT (board discovery via
`gh project field-list --format json` already emits JSON, so a fill is a paste,
and `json` is stdlib). The human field-catalog table in the doc is documentation
only; the IDs live solely in this block, so the two can't drift.

`/setup-workflow` seeds + fills this block per consumer. Override the path with
the `BOARD_SYNC_PROFILE` env var (tests / non-default layouts).
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

# Default: <repo-root>/docs/agents/board-sync.md, resolved relative to THIS file
# (scripts/board_config.py → parent.parent == repo root) so it works regardless
# of the caller's cwd, in this repo and in a consumer install alike.
_DEFAULT_PROFILE = Path(__file__).resolve().parent.parent / "docs" / "agents" / "board-sync.md"

_MARKER_RE = re.compile(r"<!--\s*board-sync:profile\s*-->")
_FENCE_RE = re.compile(r"```json\s*\n(.*?)\n```", re.DOTALL)

# Required dotted paths — every value a planning script dereferences. A consumer
# who mis-fills the profile gets a clear "missing key X" at startup, not a deep
# KeyError mid-command.
_REQUIRED_PATHS = (
    ("repo",),
    ("project", "number"), ("project", "owner"), ("project", "nodeId"),
    ("fields", "status", "id"), ("fields", "status", "options"),
    ("fields", "wave"), ("fields", "cluster"),
    ("fields", "specPath"), ("fields", "planPath"),
    ("labels", "readyForAgent"), ("labels", "typePrefix"), ("labels", "clusterType"),
    ("labels", "waveStub"),
    ("branchPrefixes",),
    ("prMarkers", "partOf"), ("prMarkers", "retroMarker"), ("prMarkers", "retroValues"),
    ("headings", "vorBau"),
)


class ConfigError(RuntimeError):
    """Raised when the board profile is absent, malformed, or incomplete."""


def _profile_path(path=None) -> Path:
    if path is not None:
        return Path(path)
    env = os.environ.get("BOARD_SYNC_PROFILE")
    return Path(env) if env else _DEFAULT_PROFILE


def _extract_block(text: str, src: str) -> str:
    marker = _MARKER_RE.search(text)
    if not marker:
        raise ConfigError(
            f"{src}: no `<!-- board-sync:profile -->` marker found — "
            "run /setup-workflow to seed the board profile.")
    fence = _FENCE_RE.search(text, marker.end())
    if not fence:
        raise ConfigError(
            f"{src}: the `board-sync:profile` marker is not followed by a "
            "```json block.")
    return fence.group(1)


def _check_required(cfg, src: str) -> None:
    for path in _REQUIRED_PATHS:
        node = cfg
        for key in path:
            if not isinstance(node, dict) or key not in node:
                raise ConfigError(
                    f"{src}: profile is missing required key "
                    f"'{'.'.join(path)}'.")
            node = node[key]


def load_board_config(path=None) -> dict:
    """Parse + validate the board profile. Raises ConfigError on any problem."""
    p = _profile_path(path)
    if not p.exists():
        raise ConfigError(
            f"board profile not found at {p} — run /setup-workflow to seed "
            "docs/agents/board-sync.md.")
    raw = _extract_block(p.read_text(encoding="utf-8"), str(p))
    try:
        cfg = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError(
            f"{p}: the board-sync:profile block is not valid JSON: {exc}") from exc
    if not isinstance(cfg, dict):
        raise ConfigError(f"{p}: the board-sync:profile block must be a JSON object.")
    _check_required(cfg, str(p))
    return cfg


# --- optional Programm-Flughöhe keys ------------------------------------------
# `fields.phase` and `labels.programType` are deliberately NOT in _REQUIRED_PATHS
# — Phasen are optional per the program-altitude design (§2) and a Program-PRD's
# type label has a literal default, so an existing consumer profile without
# either key keeps loading unchanged (no migration forced by this slice).
def phase_field_id(cfg: dict):
    """The `fields.phase.id` (a Projects-v2 single-select field id), or None when
    the profile hasn't configured a Phase field yet. Callers must degrade to a
    visible skip/hint on None, never a KeyError (mirrors `validate-graph`'s
    existing defensive read of this same optional key)."""
    return (cfg.get("fields", {}).get("phase") or {}).get("id")


def program_type_label(cfg: dict) -> str:
    """The `labels.programType` label, or the literal default `"type:program"`
    when the profile hasn't set one — a Program-PRD's board-filterable type
    label (the `<!-- prd: program -->` body marker is not filterable)."""
    return cfg.get("labels", {}).get("programType", "type:program")


# The semantic role keys of the workflow — schema, not
# vocabulary; stable once shipped, extend additively, never rename. Single
# home so CLI `choices`, docs, and future consumers reference one list.
STATUS_ROLE_KEYS = ("idea", "triaged", "spec", "inProgress", "review", "done")


def status_roles(cfg: dict) -> dict:
    """The `fields.status.roles` map: semantic role keys (`idea`,
    `triaged`, `spec`, `inProgress`, `review`, `done`) → this board's own
    status option NAMES. This is where the workflow's status vocabulary lives —
    scripts read roles, never option-name literals, so any board language works.

    Optional (not in _REQUIRED_PATHS, like `fields.phase`): a profile without
    the key returns an EMPTY DICT — deliberately no language default in code
    (a German default would leak vocabulary into consumer installs, an English
    one would be silently wrong for German boards). Callers degrade visibly:
    passive paths (SessionStart hook, status-token sync) log a skip/hint;
    explicit `--status-role` CLI calls fail loud with a migration snippet."""
    return (cfg.get("fields", {}).get("status") or {}).get("roles") or {}
