#!/usr/bin/env python3
"""board_fields.py — batched field-writes + a field-value read for Projects-v2
items (Welle 52 / Slice 3).

Three mechanics `board-sync.py` lacked before this slice:

  - `stamp-batch` — alias-batched `updateProjectV2ItemFieldValue` mutations
    (~30 aliases/request, chunked) instead of one `gh` call per field per
    item. `to-waves` (Slice 4) stamps Wave+Phase on 50+ items at publish time;
    the existing sequential `stamp_arg_list` path (still the create/add/promote
    fallback for a single item) does not scale to that.
  - `field-value` — read a project item's current field value for an issue.
    Nothing in board-sync.py read a field back before this slice; `promote`'s
    Mismatch-Guard is the first consumer.
  - the `promote` guards themselves (pure decision functions) — Wave-Mismatch
    and Program-PRD-Refusal — kept here alongside field-value since a guard IS
    the read's only consumer today.

PURE — no gh / no I/O. The `_gh`/`_gh_json` seam calls and CLI wiring live in
board-sync.py (mirrors anchor_table.py's / program_graph.py's split).
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional

# GraphQL mutations tolerate far more than this per request (GitHub's Secondary
# Rate Limit budgets ~5 "points"), but a hard chunk cap keeps one failed/timed-out
# request's blast radius small and the per-alias error report readable.
CHUNK_SIZE = 30


@dataclass
class FieldStamp:
    """One (item, field) write for the batched mutation — also the unit the
    per-alias error report and the repair command are built from."""
    item_id: str
    field_id: str
    kind: str            # "number" | "single_select"
    value: object         # the GraphQL literal value: int, or an option-id str
    issue: int             # for the report + repair command
    field_name: str        # "wave" | "phase" — doubles as the repair CLI flag name
    display_value: object  # human-readable value for the repair command
                            # (e.g. the Phase NAME, not its resolved option-id)


def build_stamps(items: list[dict], *, wave_field_id: str,
                  phase_cfg: Optional[dict]) -> tuple[list[FieldStamp], int]:
    """FieldStamp list + a skipped-phase-stamp count from raw item dicts
    (`{issue, item_id, wave?, phase?}`). A requested `phase` stamp when
    `phase_cfg` is None (profile lacks `fields.phase`) is SKIPPED and counted —
    never silently dropped without a trace (AC2)."""
    phase_field_id = (phase_cfg or {}).get("id")
    phase_options = (phase_cfg or {}).get("options", {})
    stamps: list[FieldStamp] = []
    skipped_phase = 0
    for it in items:
        issue = it["issue"]
        item_id = it["item_id"]
        wave = it.get("wave")
        phase = it.get("phase")
        if wave is not None:
            stamps.append(FieldStamp(item_id, wave_field_id, "number", wave,
                                      issue, "wave", wave))
        if phase is not None:
            if phase_field_id is None:
                skipped_phase += 1
                continue
            if phase not in phase_options:
                raise ValueError(
                    f"unknown phase {phase!r}; valid: {', '.join(phase_options) or '(none configured)'}")
            stamps.append(FieldStamp(item_id, phase_field_id, "single_select",
                                      phase_options[phase], issue, "phase", phase))
    return stamps, skipped_phase


def chunk_stamps(stamps: list[FieldStamp], size: int = CHUNK_SIZE) -> list[list[FieldStamp]]:
    """`stamps` split into ≤`size`-alias chunks, in order — one `gh api graphql`
    request per chunk."""
    return [stamps[i:i + size] for i in range(0, len(stamps), size)]


def _value_fragment(kind: str, value) -> str:
    if kind == "number":
        return f"number:{int(value)}"
    if kind == "single_select":
        return f"singleSelectOptionId:{json.dumps(str(value))}"
    raise ValueError(f"unsupported field kind {kind!r}")


def build_stamp_mutation(stamps: list[FieldStamp], project_id: str) -> tuple[str, dict[str, FieldStamp]]:
    """One aliased `updateProjectV2ItemFieldValue` mutation body for ≤CHUNK_SIZE
    stamps (GraphQL alias-batching — one `gh api graphql` request instead of N).
    Returns (mutation string, {alias: FieldStamp}) so a caller can map a
    GraphQL error's `path` back to the failing (issue, field)."""
    pid = json.dumps(project_id)
    parts = []
    alias_map: dict[str, FieldStamp] = {}
    for i, s in enumerate(stamps):
        alias = f"s{i}"
        alias_map[alias] = s
        parts.append(
            f"{alias}: updateProjectV2ItemFieldValue(input:{{"
            f"projectId:{pid}, itemId:{json.dumps(s.item_id)}, "
            f"fieldId:{json.dumps(s.field_id)}, "
            f"value:{{{_value_fragment(s.kind, s.value)}}}}}) "
            f"{{ projectV2Item {{ id }} }}"
        )
    return "mutation{" + " ".join(parts) + "}", alias_map


def parse_batch_response(response: dict, alias_map: dict[str, FieldStamp]
                          ) -> tuple[list[FieldStamp], list[tuple[FieldStamp, str]]]:
    """(succeeded, failed) for one chunk, read off the GraphQL response's
    `data`/`errors` — the counted report's ONLY source (deliberately no extra
    post-write read-back pass AC). A GraphQL partial-failure response
    carries BOTH `data` (for the aliases that succeeded) and `errors[].path`
    (the alias of each one that didn't); an alias with neither an error nor
    data is counted as failed defensively, never silently dropped."""
    errors_by_alias: dict[str, str] = {}
    for err in (response.get("errors") or []):
        path = err.get("path") or []
        if path and path[0] in alias_map:
            errors_by_alias[path[0]] = err.get("message", "unknown error")
    data = response.get("data") or {}
    succeeded: list[FieldStamp] = []
    failed: list[tuple[FieldStamp, str]] = []
    for alias, stamp in alias_map.items():
        if alias in errors_by_alias:
            failed.append((stamp, errors_by_alias[alias]))
        elif data.get(alias):
            succeeded.append(stamp)
        else:
            failed.append((stamp, "no data returned for this alias"))
    return succeeded, failed


def repair_command(stamp: FieldStamp) -> str:
    """Idempotent single-item retry for one failed alias — a GraphQL field-set
    is idempotent, so re-running just this stamp is always safe, no matter how
    many times."""
    return (f"python3 scripts/board-sync.py stamp-batch --issue {stamp.issue} "
            f"--item-id {stamp.item_id} --{stamp.field_name} {stamp.display_value}")


# --- field-value: read a project item's current field value ------------------
def extract_field_value(data: dict, project_id: str, field_id: str) -> Optional[dict]:
    """The current value of `field_id` on the issue's item in `project_id`
    (`{"number": n}` / `{"name": ..., "optionId": ...}` / `{"text": ...}`), or
    None if the issue isn't on that project / the field was never set. Matches
    by field id (not name) — the profile only carries opaque field ids, never
    the human-facing field NAME, so a name-keyed GraphQL lookup would need a
    new required key; this stays ID-driven like the rest of the profile."""
    issue = (data.get("data") or {}).get("repository", {}).get("issue")
    items = ((issue or {}).get("projectItems") or {}).get("nodes") or []
    for item in items:
        if (item.get("project") or {}).get("id") != project_id:
            continue
        for fv in ((item.get("fieldValues") or {}).get("nodes") or []):
            if (fv.get("field") or {}).get("id") != field_id:
                continue
            if "number" in fv:
                return {"number": fv["number"]}
            if "optionId" in fv:
                return {"name": fv.get("name"), "optionId": fv["optionId"]}
            if "text" in fv:
                return {"text": fv["text"]}
    return None


# --- promote guards (pure decisions; board-sync.py wires the reads) ----------
def wave_mismatch_guard(current_wave: Optional[int], target_wave: int) -> Optional[str]:
    """None when `promote` may proceed (Wave field empty, or already == target —
    an idempotent re-promote); an abort message otherwise (the field carries a
    DIFFERENT wave — never silently overwritten AC3)."""
    if current_wave is None or current_wave == target_wave:
        return None
    return (f"stub already carries Wave={current_wave} — refusing to overwrite with "
            f"--wave {target_wave} (mismatch; re-check which wave this stub belongs "
            "to, or pass the already-stamped wave to proceed idempotently)")


def program_prd_refusal(is_program: bool, issue: int) -> Optional[str]:
    """None when `promote` may proceed; a refusal message when the target is a
    Program-PRD (never a promote target — it is the native anchor OVER Wellen,
    not itself a Welle AC3)."""
    if not is_program:
        return None
    return (f"#{issue} is a Program-PRD (`<!-- prd: program -->` marker or the "
            "programType label) — refusing to promote it; a Program-PRD is a "
            "native anchor over Wellen, never itself a promote target.")
