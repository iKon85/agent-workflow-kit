#!/usr/bin/env python3
"""Find GitHub issues by one allowlisted, exact-value identity marker."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from board_config import ConfigError, load_board_config  # noqa: E402
from marker_lib import (  # noqa: E402
    UnknownMarkerKind, find_by_marker, reconcile_after_create,
)

GH_TIMEOUT_SECONDS = 30


def _gh(args: list[str]) -> str:
    try:
        result = subprocess.run(
            ["gh", *args], capture_output=True, text=True,
            timeout=GH_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"gh api timed out after {GH_TIMEOUT_SECONDS}s") from exc
    except OSError as exc:
        raise RuntimeError(f"gh CLI unavailable: {exc.strerror or exc}") from exc
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "gh api failed")
    return result.stdout


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Find issues carrying an exact allowlisted identity marker")
    parser.add_argument("--kind", required=True, help="marker kind")
    parser.add_argument("--slug", required=True, help="exact marker value")
    parser.add_argument("--created", type=int,
                        help="post-create reconciliation for this issue number")
    return parser


def main(argv: list[str] | None = None, *, repo: str | None = None,
         gh: Callable[[list[str]], str] = _gh) -> int:
    args = build_parser().parse_args(argv)
    try:
        target_repo = repo or load_board_config()["repo"]
        if args.created is None:
            result = find_by_marker(target_repo, args.kind, args.slug, gh)
        else:
            result = reconcile_after_create(
                target_repo, args.kind, args.slug, args.created, gh)
    except UnknownMarkerKind as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except (ConfigError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
