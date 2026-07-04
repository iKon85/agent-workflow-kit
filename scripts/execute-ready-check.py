#!/usr/bin/env python3
"""
execute-ready-check.py — single source of truth for "execute-ready" graph
coherence (Welle 26 / Slice 1g).

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
  - shape_warnings  : provenance-NEUTRAL anchor form check (template
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
  <!-- prd: program -->                                  Programm-PRD marker (node_kind.py) — this
                                                         target roots at itself, never lifts

Audit log: .claude/logs/execute-ready-check.log
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from board_config import ConfigError, load_board_config  # noqa: E402
from node_kind import ANCHOR, LEAF, PROGRAM, ROOT_KINDS, WAVE_STUB, classify_node  # noqa: E402,F401

# Project-specific label + heading come from the board profile (no inline
# constants → published kit stays project-neutral).
try:
    _CFG = load_board_config()
except ConfigError as exc:
    print(f"[FAIL] execute-ready-check: Board-Profil nicht verfügbar — {exc}", file=sys.stderr)
    sys.exit(1)

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
# Read defensively: `labels.programType` (a filterable Programm-PRD label) is
# added by a LATER slice — this checker must keep working before that
# key exists, so `program` classification is 100% marker-driven (node_kind.py).
CLUSTER_TYPE_LABEL = _CFG["labels"].get("clusterType")
WAVE_STUB_LABEL = _CFG["labels"].get("waveStub")


def classify(node: dict) -> str:
    """Node kind (program|anchor|wave_stub|leaf) bound to this repo's board
    profile — see node_kind.py for the precedence rules."""
    return classify_node(node, cluster_type_label=CLUSTER_TYPE_LABEL,
                         wave_stub_label=WAVE_STUB_LABEL)


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
    # marker is the single grandfather path (alt-anchors like get tagged once).
    return bool(GUARD_LEGACY_RE.search(body or ""))


# --- anchor shape audit (non-blocking) -------------------------------
# Provenance-NEUTRAL form check: does a promoted anchor carry the uniform
# wave-anchor-template shape? Emitted ONLY as shape_warnings in --mode audit;
# NEVER fed into violations / graph_coherent / deny_recommended. A missing
# section is a loud nudge, never a handoff block — folding it into deny would
# recreate exactly the provenance-harness rejected. The hard block stays
# bucket + coherence only.
_WAVE_HEADER_RE = re.compile(r"\*\*\s*Welle\s+\d+\s*[—–-]", re.IGNORECASE)
# `## Herkunft` (new) or the legacy `## Cluster-Herkunft` both satisfy the check.
_SHAPE_SECTIONS = (
    ("Herkunft", re.compile(r"^#{1,6}\s*(?:Cluster-)?Herkunft\b", re.MULTILINE)),
    ("Entscheidungen", re.compile(r"^#{1,6}\s*Entscheidungen\b", re.MULTILINE)),
    ("Slices", re.compile(r"^#{1,6}\s*Slices\b", re.MULTILINE)),
)


def evaluate_anchor_shape(body: str) -> list[str]:
    """Non-blocking form check for a promoted anchor body.

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
                   root_kind=None) -> dict:
    """Evaluate the rooted local graph. Nodes are dicts {number, body, labels}.

    parent=None        → atomar leaf (graph = [target]).
    parent given        → target's local root + its children (siblings, incl.
                          target if target is a child of that root).
    root_kind=None       → target was LIFTED to `parent` (a real, different
                          parent) or is the atomar leaf above — target_kind
                          resolves to "leaf".
    root_kind=ANCHOR/PROGRAM → target IS its own root (`parent` == `target`,
                          `siblings` == target's own children) — an anchor or
                          Programm-PRD never lifts to a native parent it might
                          also have.

    Each CHILD in `siblings` is classified independently (`classify_node`):
    only LEAF children go through the bucket + plan_revision-match checks —
    an anchor/wave_stub/program child carries neither a bucket nor a shared
    plan_revision domain with its parent, and is audited on its own terms
    when IT is the checker's target (rooted at itself via ROOT_KINDS).
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
        target_kind = LEAF
    else:
        # Anchor tagged <!-- guard-legacy --> grandfathers the whole rooted graph
        # (Q4=A: tag once → free). Constrained: pre-convention classes
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
            if classify(child) != LEAF:
                # anchor/wave_stub/program sibling — no bucket, no shared
                # plan_revision domain with `parent`.
                continue
            crev, cst = check_rev_ok(child, "", suppress_rev_status=anchor_legacy)
            legacy = is_legacy(child["body"])
            child_closed = (child.get("state") or "").upper() == "CLOSED"
            suppress_bucket = legacy or (anchor_legacy and child_closed)
            if parse_bucket(child["labels"], child["body"]) == "ambiguous" and not suppress_bucket:
                violations.append(f"#{child['number']}: ambiguous bucket")
            if cst == "ok" and ast == "ok" and crev != arev and not legacy and not anchor_legacy:
                violations.append(f"#{child['number']}: plan_revision r{crev} != anchor r{arev}")
        target_kind = root_kind if root_kind in ROOT_KINDS else LEAF

    # Fix B (b): final-cut dependency closed without resolution
    fc = parse_final_cut_depends(target["body"])
    if fc is not None:
        fc_state = closed_lookup.get(fc)
        if fc_state == "closed":
            violations.append(f"#{target['number']}: final-cut depends on #{fc} which is CLOSED")
        elif fc_state == "unresolved":
            # gh could not resolve the dependency (network/auth) — a silent
            # "open" default here would let a stale/unverifiable final-cut
            # dependency slip an unbuilt handoff through.
            violations.append(
                f"#{target['number']}: final-cut dependency #{fc} could not be "
                f"verified via gh (network/auth) — fail-closed")

    if truncated:
        violations.append("graph too large for guard (>100 children) — cannot prove completeness")

    if target_kind in ROOT_KINDS:
        target_buildable = True
    else:
        target_buildable = parse_bucket(target["labels"], target["body"]) == "afk"

    graph_coherent = len(violations) == 0
    deny_recommended = (not graph_coherent) or (
        mode == "handoff" and intent == "build"
        and target_kind == LEAF and not target_buildable
    )
    # Non-blocking, audit-only, anchor-only (a Programm-PRD's body follows
    # PROGRAM-PRD-FORMAT, not wave-anchor-template — the shape check would
    # only produce spurious nudges there). Intentionally NOT part of
    # graph_coherent/deny_recommended (see evaluate_anchor_shape docstring).
    shape_warnings = (
        evaluate_anchor_shape(target["body"])
        if mode == "audit" and target_kind == ANCHOR
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

    closed_lookup = {}
    fc = parse_final_cut_depends(target["body"])
    if fc is not None:
        st = fetch_issue(fc)
        if st is None:
            # gh could not resolve the dependency at all → "unresolved", NOT a
            # silent "open" default (that would hide an unverifiable final-cut
            # dependency instead of denying it).
            closed_lookup[fc] = "unresolved"
        else:
            closed_lookup[fc] = "closed" if st.get("state", "").upper() == "CLOSED" else "open"

    node_kind = classify(target)
    if node_kind in ROOT_KINDS:
        # An anchor or a Programm-PRD is its OWN root — it never lifts to a
        # native parent it might also have (a Welle-Anker under a PRD, or the
        # PRD itself).. `fetch_parent` is intentionally never called here.
        children, truncated = fetch_children(issue_number)
        siblings = [fetch_issue(c) for c in children] if children else []
        if any(s is None for s in siblings):
            return _fail_closed(issue_number, "child fetch failed")
        return evaluate_graph(target, parent=target, siblings=siblings, mode=mode,
                              intent=intent, closed_lookup=closed_lookup,
                              truncated=truncated, root_kind=node_kind)

    # leaf / wave_stub — lift to the native parent if one exists (2-level
    # rooted-local model), else atomar leaf.
    parent_n = fetch_parent(issue_number)
    if parent_n is None:
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
