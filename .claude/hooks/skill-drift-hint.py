#!/usr/bin/env python3
"""
SessionStart soft-hint: flag project skills whose declared source files moved in git
since the skill's own last commit — a cue to re-check the SKILL.md against reality.

Mechanism: each drift-prone skill declares its code/doc anchors in a co-located
`SOURCES.txt` (one repo-relative path per line; `#` comments and blank lines ignored).
For each such skill the hook compares `git log -1 --format=%ct` on the SKILL.md vs.
each source file; a source committed *after* the skill → the skill may be stale.

Committing (touching) the SKILL.md resets the signal — that is how you "quittieren".
Non-blocking: emits SessionStart additionalContext, silent on every failure.

Carrier is SOURCES.txt (not SKILL.md frontmatter) on purpose: the skill loader's
tolerance for extra frontmatter keys is unverified, and a sibling file can never
break skill loading.

Audit log: .claude/logs/skill-drift-hint.log
"""
import json
import sys
from pathlib import Path

from _hook_utils import (
    hook_event_output,
    load_workflow_advisories_core,
    log,
    repo_root,
)

HOOK_NAME = "skill-drift-hint"
SKILLS_REL = ".claude/skills"


def collect_stale(root: str) -> list[tuple[str, list[str]]]:
    """For each skill with a SOURCES.txt, list sources newer (in git) than its SKILL.md."""
    core = load_workflow_advisories_core()
    return core.collect_skill_stale(Path(root), SKILLS_REL)


def build_context(root: str) -> str | None:
    stale = collect_stale(root)
    if not stale:
        return None
    lines: list[str] = []
    for skill_name, sources in stale:
        lines.append(f"⚠ `{skill_name}` — source(s) moved since the skill's last touch:")
        for src in sources:
            lines.append(f"    - {src}")
    block = "\n".join(lines)
    return (
        "## Skill freshness (SessionStart hook)\n\n"
        "```\n"
        f"{block}\n"
        "```\n\n"
        "Heads-up (non-blocking): re-check the named SKILL.md against its source — "
        "paths/symbols/line numbers may have moved. If the doc still holds, commit the skill "
        "along with your change (a touch acknowledges the signal). "
        "Source: .claude/hooks/skill-drift-hint.py + a per-skill SOURCES.txt."
    )


def main() -> int:
    try:
        json.load(sys.stdin)
    except Exception:
        pass

    root = repo_root() or "."
    try:
        context = build_context(root)
    except Exception as e:
        log(HOOK_NAME, f"build_context failed: {e}")
        return 0

    if context is None:
        return 0

    payload = hook_event_output("SessionStart", context)
    print(json.dumps(payload))
    log(HOOK_NAME, f"emitted: {context.count(chr(0x26A0))} skill(s) flagged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
