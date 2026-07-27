#!/usr/bin/env python3
"""Shared exact-value HTML marker lookup for issue identity."""

from __future__ import annotations

import json
import re
from collections.abc import Callable


MARKER_KINDS = frozenset({
    # The census refresh tracker: one open issue per repository, so a second
    # session updates the issue the first one opened.
    "census-refresh-source",
    "prd-source-id",
    "program-leaf-source",
    "program-stub-source",
    "wave-stub-source",
})


class UnknownMarkerKind(ValueError):
    """Raised when a caller requests a marker outside the public grammar."""


def marker_value(body: str, kind: str) -> str | None:
    """Return one allowlisted marker value from a body, trimmed exactly once."""
    if kind not in MARKER_KINDS:
        raise UnknownMarkerKind(f"unknown marker kind: {kind}")
    match = re.search(rf"<!--\s*{re.escape(kind)}:\s*([^>]+?)\s*-->", body)
    return match.group(1).strip() if match else None


def first_marker(body: str, kinds: tuple[str, ...]) -> tuple[str, str] | None:
    """Return the first body-ordered marker among validated allowlisted kinds."""
    unknown = next((kind for kind in kinds if kind not in MARKER_KINDS), None)
    if unknown:
        raise UnknownMarkerKind(f"unknown marker kind: {unknown}")
    alternatives = "|".join(re.escape(kind) for kind in kinds)
    match = re.search(rf"<!--\s*({alternatives}):\s*([^>]+?)\s*-->", body)
    return (match.group(1), match.group(2).strip()) if match else None


def _issues_from_pages(raw: str) -> list[dict]:
    pages = json.loads(raw)
    if not pages:
        return []
    if isinstance(pages[0], dict):
        return pages
    return [issue for page in pages for issue in page]


def marker_verdict(issues: list[dict]) -> str:
    """Map exact identity matches onto the four-way consumer decision."""
    if not issues:
        return "create"
    if len(issues) > 1:
        return "STOP"
    return "update" if issues[0]["state"] == "open" else "user-decision"


def find_by_marker(repo: str, kind: str, slug: str,
                   gh: Callable[[list[str]], str]) -> dict:
    """Scan every issue state and return exact marker matches plus a verdict."""
    marker_value("", kind)  # validate before making a network call
    raw = gh([
        "api", "--paginate", "--slurp", "--method", "GET",
        f"repos/{repo}/issues", "-f", "state=all", "-f", "per_page=100",
    ])
    matches = [
        {"number": issue["number"], "state": issue["state"]}
        for issue in _issues_from_pages(raw)
        if "pull_request" not in issue
        and marker_value(issue.get("body") or "", kind) == slug
    ]
    return {
        "count": len(matches),
        "issues": matches,
        "verdict": marker_verdict(matches),
    }


def reconcile_after_create(repo: str, kind: str, slug: str,
                           created_number: int,
                           gh: Callable[[list[str]], str]) -> dict:
    """Re-scan after create and fail closed unless that open issue is unique."""
    result = find_by_marker(repo, kind, slug, gh)
    expected = [{"number": created_number, "state": "open"}]
    if result["issues"] != expected:
        result["verdict"] = "STOP"
    return result
