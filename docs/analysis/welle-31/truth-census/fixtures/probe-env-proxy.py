#!/usr/bin/env python3
"""Reproduction probe R1 — `.env*` teardown proxy (Truth / wrong axis).

Builds a throwaway git main checkout plus one linked worktree under a temp
root (fixture only — never the repository under review), then asks the shipped
classifier `scripts/worktree-lifecycle/classify.py` to assess the worktree.

Three arms:
  identical  — the worktree's `.env` is byte-identical to the main checkout's
  per-port   — the worktree's `.env` differs in one line (`PORT=`), which is
               what a correct per-worktree setup produces, and which the
               consumer's seed profile does not declare
  declared   — the same per-worktree `.env`, declared in the consumer's own seed
               profile: the declaration is the consent, so teardown clears it

`identical` and `per-port` are the pinned v1 reproduction of R1 and still report
it in `reproduced` — an undeclared divergent `.env*` blocks by design (#430).
`declared` is the v2 acceptance arm: `v2` is the whole ADR-0009 §4 expectation,
and it is also this probe's exit code, so "green" is mechanical.

Prints one JSON object. Deterministic; no network.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[5]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


classify = load(
    "w31_classify", REPO / "scripts/worktree-lifecycle/classify.py"
)


def git(*args, cwd):
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    )


def build(root: Path, worktree_env: str) -> tuple[Path, Path]:
    main = root / "main"
    main.mkdir(parents=True)
    git("init", "-q", "-b", "main", cwd=main)
    git("config", "user.email", "fixture@example.invalid", cwd=main)
    git("config", "user.name", "fixture", cwd=main)
    (main / ".gitignore").write_text(".env*\n.worktrees/\n", encoding="utf-8")
    (main / "app.txt").write_text("app\n", encoding="utf-8")
    git("add", ".", cwd=main)
    git("commit", "-qm", "base", cwd=main)
    (main / ".env").write_text("PORT=3000\nTOKEN=shared\n", encoding="utf-8")
    worktree = main / ".worktrees" / "slice"
    git("worktree", "add", "-q", "-b", "feat/1-slice", str(worktree), cwd=main)
    (worktree / ".env").write_text(worktree_env, encoding="utf-8")
    return main, worktree


def arm(root: Path, name: str, worktree_env: str, declared=()) -> dict:
    main, worktree = build(root / name, worktree_env)
    assessment = classify.assess(worktree, main, declared)
    blocks = [
        {"rule": block.rule, "items": list(block.items)} for block in assessment.blocks
    ]
    env_blocks = [b for b in blocks if b["rule"] == classify.RULE_ENV]
    return {
        "arm": name,
        "worktreeEnv": worktree_env,
        "declared": list(declared),
        "blocked": bool(env_blocks),
        "blocks": blocks,
        "scratchCount": len(assessment.scratch),
        "declaredDeletions": list(assessment.declared_deletions),
    }


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="w31-r1-") as tmp:
        root = Path(tmp)
        result = {
            "probe": "R1-env-proxy",
            "target": "scripts/worktree-lifecycle/classify.py::_env_problem",
            "arms": [
                arm(root, "identical", "PORT=3000\nTOKEN=shared\n"),
                arm(root, "per-port", "PORT=3101\nTOKEN=shared\n"),
                arm(root, "declared", "PORT=3101\nTOKEN=shared\n", declared=(".env",)),
            ],
        }
    identical, per_port, declared = result["arms"]
    result["reproduced"] = (not identical["blocked"]) and per_port["blocked"]
    result["v2"] = (
        result["reproduced"]
        and not declared["blocked"]
        and declared["declaredDeletions"] == [".env"]
    )
    print(json.dumps(result, sort_keys=True))
    return 0 if result["v2"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
