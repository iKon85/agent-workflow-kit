#!/usr/bin/env python3
"""
execute-ready-check.py — single source of truth for "execute-ready" graph
coherence (Welle 26 / Slice 1g, #983).

Four callers share this one checker so the parse/coherence rules live + are
tested ONCE:
  - .claude/hooks/drift-guard.py   --mode handoff   (blocks handoff on deny_recommended)
  - to-issues §7 exit              --mode audit     (non-blocking warn — as in 1d)
  - grill-with-docs Re-Grill       --mode audit
  - wrapup Land-Reconcile          --mode audit

Two separate axes (Codex R1/R2):
  - graph_coherent   : every node in the rooted local graph is well-formed
                       (Anker: plan_revision + no bucket/ready-for-agent;
                        child/leaf: exactly one bucket, plan_revision coherent).
  - target_buildable : only for the handoff target — AFK = buildable,
                       HITL = valid-but-not-buildable.
  deny_recommended = !graph_coherent
                     OR (mode==handoff AND intent==build AND target leaf AND !buildable).
  - shape_warnings  : (#1342) provenance-NEUTRAL anchor form check (template
                       sections + body header). audit-only, anchor-only, and
                       NEVER part of graph_coherent/deny_recommended — a loud
                       nudge for output-uniformity, not a gate.

Rooted local graph = handoff-target → its native parent (lift) → that parent's
direct children. NOT a board-wide scan. Atomar leaf (no parent) = its own node only.

gh access is a thin, mockable layer (reuses scripts/board-sync.py parent-of /
children-of). The pure functions below carry the logic + the unit tests.

Usage:
  execute-ready-check.py --issue <n> --mode handoff|audit [--intent build|grill] [--json]
Exit 0 always (it is a checker, not a gate); the hook decides blocking.

Marker conventions (CANONICAL — the skills cross-reference this block; all are
grep-bar HTML comments living in issue/PR/handoff bodies):
  <!-- guard-ack: #<n> r<N> reason:<text> by-user -->   deliberate handoff override (drift-guard.py)
  <!-- guard-legacy -->                                  grandfathered alt-anchor → warn, not block
  <!-- handoff-intent: build|grill -->                   handoff intent (else inferred from a /grill cmd)
  <!-- final-cut-depends-on: #<n> -->                    leaf's final cut hangs on #n; #n CLOSED → block
  <!-- annahme-drift: {"target":"#<n>",...} -->          drift propagation — consumed by wrapup Step 5e
                                                         (NOT parsed here)

Audit log: .claude/logs/execute-ready-check.log
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from board_config import load_board_config  # noqa: E402

# Project-specific label + heading come from the board profile (no inline
# constants → published kit stays project-neutral).
_CFG = load_board_config()

LOG_DIR = Path(".claude/logs")
LOG_NAME = "execute-ready-check"

# --- markers / patterns -----------------------------------------------------
# Broad: a line that *intends* to be the plan_revision marker (for malformed detection).
PLAN_REV_BROAD = re.compile(r"\*\*plan_revision:\*\*")
# Strict: a well-formed `**plan_revision:** r<N>`.
PLAN_REV_STRICT = re.compile(r"\*\*plan_revision:\*\*\s*r(\d+)\b")
HEADING_RE = re.compile(r"^#{1,6}\s")
VOR_BAU_RE = re.compile(r"^#{1,6}\s*" + re.escape(_CFG["headings"]["vorBau"]), re.MULTILINE)
FINAL_CUT_RE = re.compile(r"<!--\s*final-cut-depends-on:\s*#?(\d+)\s*-->")
GUARD_LEGACY_RE = re.compile(r"<!--\s*guard-legacy\s*-->")
HANDOFF_INTENT_RE = re.compile(r"<!--\s*handoff-intent:\s*(build|grill)\s*-->")
GRILL_CMD_RE = re.compile(r"/grill(?:-me|-with-docs)?(?:-codex)?\b")
READY_LABEL = _CFG["labels"]["readyForAgent"]


# NOTE: log() + _run() below are intentional small isolation copies of
# _hook_utils.{log,run_with_status} — scripts/ tools (cf. board-sync.py) do not
# import from .claude/hooks/. Keep them thin; do not add a third copy elsewhere.
def log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        from datetime import datetime
        with (LOG_DIR / f"{LOG_NAME}.log").open("a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat(timespec='seconds')} {msg}\n")
    except Exception:
        pass


# --- pure parsers -----------------------------------------------------------
def parse_plan_revision(body: str):
    """Return (rev:int|None, status). status ∈ {ok, missing, malformed, multiple, misplaced}.

    'Top' = after leading metadata HTML comments, before the first Markdown
    heading. Blockquote lines (quoted old bodies) are ignored so a stale marker
    inside a `>` quote cannot fake coherence.
    """
    if not body:
        return None, "missing"
    lines = body.splitlines()
    marker_idx = [
        i for i, ln in enumerate(lines)
        if not ln.lstrip().startswith(">") and PLAN_REV_BROAD.search(ln)
    ]
    if not marker_idx:
        return None, "missing"
    if len(marker_idx) > 1:
        return None, "multiple"
    i = marker_idx[0]
    m = PLAN_REV_STRICT.search(lines[i])
    if not m:
        return None, "malformed"
    first_heading = next((j for j, ln in enumerate(lines) if HEADING_RE.match(ln)), len(lines))
    if i > first_heading:
        return int(m.group(1)), "misplaced"
    return int(m.group(1)), "ok"


def parse_bucket(labels, body: str) -> str:
    """afk | hitl | ambiguous. AFK = ready-for-agent + no Vor-Bau; HITL = no
    ready-for-agent + Vor-Bau present. Both or neither → ambiguous."""
    has_ready = READY_LABEL in (labels or [])
    has_vorbau = bool(VOR_BAU_RE.search(body or ""))
    if has_ready and not has_vorbau:
        return "afk"
    if has_vorbau and not has_ready:
        return "hitl"
    return "ambiguous"


def infer_intent(content: str, marker_intent: str = None) -> str:
    """build | grill. Explicit handoff-intent marker wins; else infer from a
    grill command in the handoff content; else default build."""
    if marker_intent in ("build", "grill"):
        return marker_intent
    if content:
        mk = HANDOFF_INTENT_RE.search(content)
        if mk:
            return mk.group(1)
        if GRILL_CMD_RE.search(content):
            return "grill"
    return "build"


def parse_final_cut_depends(body: str):
    m = FINAL_CUT_RE.search(body or "")
    return int(m.group(1)) if m else None


def is_legacy(body: str) -> bool:
    # Marker-only by design. Date-based grandfathering (createdAt < enforcement
    # date) is intentionally NOT implemented — the explicit `<!-- guard-legacy -->`
    # marker is the single grandfather path (alt-anchors like #685 get tagged once).
    return bool(GUARD_LEGACY_RE.search(body or ""))


# --- anchor shape audit (non-blocking, #1342) -------------------------------
# Provenance-NEUTRAL form check: does a promoted anchor carry the uniform
# wave-anchor-template shape? Emitted ONLY as shape_warnings in --mode audit;
# NEVER fed into violations / graph_coherent / deny_recommended. A missing
# section is a loud nudge, never a handoff block — folding it into deny would
# recreate exactly the provenance-harness #1342 rejected. The hard block stays
# bucket + coherence only.
_WAVE_HEADER_RE = re.compile(r"\*\*\s*Welle\s+\d+\s*[—–-]", re.IGNORECASE)
# `## Herkunft` (new) or the legacy `## Cluster-Herkunft` both satisfy the check.
_SHAPE_SECTIONS = (
    ("Herkunft", re.compile(r"^#{1,6}\s*(?:Cluster-)?Herkunft\b", re.MULTILINE)),
    ("Entscheidungen", re.compile(r"^#{1,6}\s*Entscheidungen\b", re.MULTILINE)),
    ("Slices", re.compile(r"^#{1,6}\s*Slices\b", re.MULTILINE)),
)


def evaluate_anchor_shape(body: str) -> list[str]:
    """Non-blocking form check for a promoted anchor body (#1342).

    Returns human-readable shape warnings (missing template sections / body
    header). NEVER contributes to violations — uniformity is a loud nudge, not
    a gate.
    """
    warnings = []
    if not _WAVE_HEADER_RE.search(body or ""):
        warnings.append("anchor body header `**Welle N — …**` missing")
    for name, rx in _SHAPE_SECTIONS:
        if not rx.search(body or ""):
            warnings.append(f"anchor section `## {name}` missing")
    return warnings


# --- pure coherence ---------------------------------------------------------
def evaluate_graph(target, parent=None, siblings=None, *, mode="handoff",
                   intent="build", closed_lookup=None, truncated=False,
                   target_is_anchor=False) -> dict:
    """Evaluate the rooted local graph. Nodes are dicts {number, body, labels}.

    parent=None  → atomar leaf (graph = [target]).
    parent given → anchor + its children (siblings, incl. target if target is a child).
    """
    violations = []
    closed_lookup = closed_lookup or {}
    grandfathered = None   # set to the anchor # when a legacy-tagged anchor grandfathers its graph

    def check_rev_ok(node, kind_label, suppress_rev_status=False):
        rev, st = parse_plan_revision(node["body"])
        if st != "ok" and not is_legacy(node["body"]) and not suppress_rev_status:
            violations.append(f"#{node['number']}{kind_label}: plan_revision {st}")
        return rev, st

    if parent is None:
        # atomar leaf
        check_rev_ok(target, "")
        if parse_bucket(target["labels"], target["body"]) == "ambiguous" \
                and not is_legacy(target["body"]):
            violations.append(f"#{target['number']}: ambiguous bucket (ready-for-agent vs Vor Bau zu klären)")
        target_kind = "leaf"
    else:
        # Anchor tagged <!-- guard-legacy --> grandfathers the whole rooted graph
        # (#1069/Q4=A: tag once → free). Constrained: pre-convention classes
        # (plan_revision status, anchor-rev mismatch) are suppressed graph-wide;
        # ambiguous-bucket only for CLOSED children — an OPEN child's bucket and
        # the structural ready-on-anchor check stay live (new incoherence visible).
        anchor_legacy = is_legacy(parent["body"])
        if anchor_legacy:
            grandfathered = parent["number"]
        arev, ast = check_rev_ok(parent, " (anchor)")
        if READY_LABEL in (parent["labels"] or []):
            violations.append(f"#{parent['number']} (anchor): ready-for-agent on an anchor")
        for child in (siblings or []):
            crev, cst = check_rev_ok(child, "", suppress_rev_status=anchor_legacy)
            legacy = is_legacy(child["body"])
            child_closed = (child.get("state") or "").upper() == "CLOSED"
            suppress_bucket = legacy or (anchor_legacy and child_closed)
            if parse_bucket(child["labels"], child["body"]) == "ambiguous" and not suppress_bucket:
                violations.append(f"#{child['number']}: ambiguous bucket")
            if cst == "ok" and ast == "ok" and crev != arev and not legacy and not anchor_legacy:
                violations.append(f"#{child['number']}: plan_revision r{crev} != anchor r{arev}")
        target_kind = "anchor" if target_is_anchor else "leaf"

    # Fix B (b): final-cut dependency closed without resolution
    fc = parse_final_cut_depends(target["body"])
    if fc is not None and closed_lookup.get(fc) == "closed":
        violations.append(f"#{target['number']}: final-cut depends on #{fc} which is CLOSED")

    if truncated:
        violations.append("graph too large for guard (>100 children) — cannot prove completeness")

    if target_kind == "anchor":
        target_buildable = True
    else:
        target_buildable = parse_bucket(target["labels"], target["body"]) == "afk"

    graph_coherent = len(violations) == 0
    deny_recommended = (not graph_coherent) or (
        mode == "handoff" and intent == "build"
        and target_kind == "leaf" and not target_buildable
    )
    # Non-blocking, audit-only, anchor-only. Intentionally NOT part of
    # graph_coherent/deny_recommended (see evaluate_anchor_shape docstring).
    shape_warnings = (
        evaluate_anchor_shape(target["body"])
        if mode == "audit" and target_kind == "anchor"
        else []
    )
    return {
        "graph_coherent": graph_coherent,
        "target_buildable": target_buildable,
        "deny_recommended": deny_recommended,
        "violations": violations,
        "grandfathered": grandfathered,
        "shape_warnings": shape_warnings,
    }


# --- thin gh layer (mocked in tests via the functions above) ----------------
def _run(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip()
    except Exception:
        return -1, ""


def fetch_issue(number: int):
    """{number, body, labels:[str], state} via `gh issue view`, or None on failure."""
    rc, out = _run(["gh", "issue", "view", str(number), "--json",
                    "number,body,labels,state"])
    if rc != 0 or not out:
        return None
    try:
        d = json.loads(out)
    except json.JSONDecodeError:
        return None
    return {
        "number": d.get("number"),
        "body": d.get("body") or "",
        "labels": [lb.get("name", "") for lb in d.get("labels", [])],
        "state": d.get("state", ""),
    }


def fetch_parent(number: int):
    """Parent issue number, or None (FREI = atomar)."""
    rc, out = _run(["python3", "scripts/board-sync.py", "parent-of", str(number)])
    if rc != 0 or not out or out.strip() == "FREI":
        return None
    try:
        return int(out.strip())
    except ValueError:
        return None


def fetch_children(number: int):
    """(child_numbers, truncated). truncated=True if exactly 100 came back
    (board-sync subIssues(first:100) — can't prove completeness)."""
    rc, out = _run(["python3", "scripts/board-sync.py", "children-of", str(number)])
    if rc != 0 or not out:
        return [], False
    # one issue number per line — anchor per-line so a stray warning/word can't
    # contribute spurious digits.
    nums = [int(m.group(1)) for m in re.finditer(r"^\s*(\d+)\s*$", out, re.MULTILINE)]
    return nums, len(nums) >= 100


def build_and_evaluate(issue_number: int, mode: str, intent: str,
                       handoff_content: str = "") -> dict:
    """Fetch the rooted local graph via gh + evaluate. fail-closed: if a target
    is identified but gh cannot resolve it, recommend deny (the MUSS-property)."""
    target = fetch_issue(issue_number)
    if target is None:
        log(f"issue={issue_number} gh-fetch-failed → fail-closed deny")
        return {"graph_coherent": False, "target_buildable": False,
                "deny_recommended": True, "grandfathered": None, "shape_warnings": [],
                "violations": [f"#{issue_number}: could not verify via gh (network/auth) — fail-closed"]}

    parent_n = fetch_parent(issue_number)
    closed_lookup = {}
    fc = parse_final_cut_depends(target["body"])
    if fc is not None:
        st = fetch_issue(fc)
        closed_lookup[fc] = "closed" if (st and st.get("state", "").upper() == "CLOSED") else "open"

    if parent_n is None:
        children, truncated = fetch_children(issue_number)
        if children:
            siblings = [fetch_issue(c) for c in children]
            if any(s is None for s in siblings):
                return _fail_closed(issue_number, "child fetch failed")
            return evaluate_graph(target, parent=target, siblings=siblings, mode=mode,
                                  intent=intent, closed_lookup=closed_lookup,
                                  truncated=truncated, target_is_anchor=True)
        return evaluate_graph(target, mode=mode, intent=intent, closed_lookup=closed_lookup)

    parent = fetch_issue(parent_n)
    if parent is None:
        return _fail_closed(issue_number, "parent fetch failed")
    children, truncated = fetch_children(parent_n)
    siblings = [fetch_issue(c) for c in children] if children else [target]
    if any(s is None for s in siblings):
        return _fail_closed(issue_number, "sibling fetch failed")
    return evaluate_graph(target, parent=parent, siblings=siblings, mode=mode,
                          intent=intent, closed_lookup=closed_lookup, truncated=truncated)


def _fail_closed(number, why):
    log(f"issue={number} {why} → fail-closed deny")
    return {"graph_coherent": False, "target_buildable": False,
            "deny_recommended": True, "grandfathered": None, "shape_warnings": [],
            "violations": [f"#{number}: {why} — fail-closed (could not verify graph)"]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--issue", type=int, required=True)
    ap.add_argument("--mode", choices=["handoff", "audit"], default="audit")
    ap.add_argument("--intent", choices=["build", "grill"], default="build")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    result = build_and_evaluate(args.issue, args.mode, args.intent)
    log(f"issue={args.issue} mode={args.mode} intent={args.intent} "
        f"coherent={result['graph_coherent']} buildable={result['target_buildable']} "
        f"deny={result['deny_recommended']} violations={len(result['violations'])}")

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        flag = "DENY" if result["deny_recommended"] else "OK"
        print(f"[{flag}] #{args.issue} coherent={result['graph_coherent']} "
              f"buildable={result['target_buildable']}")
        if result.get("grandfathered"):
            print(f"  ℹ legacy graph grandfathered via #{result['grandfathered']}")
        for v in result["violations"]:
            print(f"  - {v}")
        for w in result.get("shape_warnings", []):
            print(f"  ~ shape (non-blocking): {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
