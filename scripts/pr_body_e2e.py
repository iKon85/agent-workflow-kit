#!/usr/bin/env python3
"""Couple a valid E2E-NA trailer to active PR-body evidence."""
from __future__ import annotations

import json
import re
import subprocess


E2E_NA_LINE_RE = re.compile(
    r"^E2E:\s*n/a\s*—\s*\S", re.IGNORECASE | re.MULTILINE
)


def _run(cmd: list[str], timeout=15):
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return result.returncode, result.stdout.strip()
    except Exception:
        return -1, ""


def check_e2e_na_line(body: str, has_e2e_na_trailer: bool) -> list[str]:
    """Require non-empty body evidence only when a valid trailer exists."""
    if not has_e2e_na_trailer or E2E_NA_LINE_RE.search(body or ""):
        return []
    return [
        "E2E-NA trailer found in the pull-request range, but required "
        "`E2E: n/a — <reason>` evidence is missing from the PR body."
    ]


def _git(args: list[str], cwd=None) -> str:
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=15
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())
    return result.stdout


def _collect_e2e_na_trailers(base_sha: str, head_sha: str, cwd=None) -> list[str]:
    raw = _git(
        [
            "log",
            f"{base_sha}..{head_sha}",
            "--format=%x00%(trailers:key=E2E-NA,unfold)",
        ],
        cwd=cwd,
    )
    values = []
    for chunk in raw.split("\x00"):
        for line in chunk.splitlines():
            if line.startswith("E2E-NA:"):
                values.append(line.removeprefix("E2E-NA:").strip())
    return values


def fetch_has_e2e_na_trailer(base_sha, head_sha, cwd=None) -> bool:
    """Return true for exactly one non-empty trailer; unreadable ranges are false."""
    if not base_sha or not head_sha:
        return False
    try:
        values = _collect_e2e_na_trailers(base_sha, head_sha, cwd=cwd)
    except Exception:
        return False
    return len(values) == 1 and bool(values[0].strip())


def fetch_pr_range(branch: str):
    """Return GitHub's immutable PR base/head SHAs, or an unreadable range."""
    rc, out = _run(
        ["gh", "pr", "view", branch, "--json", "baseRefOid,headRefOid"]
    )
    if rc != 0 or not out:
        return None, None
    try:
        data = json.loads(out)
    except (json.JSONDecodeError, TypeError):
        return None, None
    if not isinstance(data, dict):
        return None, None
    return data.get("baseRefOid"), data.get("headRefOid")
