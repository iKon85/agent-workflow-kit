#!/usr/bin/env python3
"""Stateless teardown classification.

Teardown authority comes from the repository's current state, read at the
moment of action, and from nothing else. Four rules decide it:

1. A tracked change (porcelain v2 records `1` and `2`) blocks.
2. An unmerged path (record `u`) is tracked work and blocks.
3. An untracked, non-ignored file (record `?`) blocks with a bounded report:
   the exact file count plus the top directories, never a path dump.
4. An ignored entry (record `!`) is Scratch and is deletable — with one
   carve-out, `.env*` by basename glob, which has two arms. A regular file the
   consumer's own seed profile declares is deletable **by that declaration**:
   the consumer said this file is what a fresh worktree carries, which is the
   same declaration-based authority `.gitignore` already carries ("the
   repository declared it not-work"). An **undeclared** `.env*` is deletable
   only when it is byte-identical to its counterpart at the same relative path
   in the main checkout, both opened no-follow — a hand-written secret has no
   floor beneath it, so it keeps the conservative comparison.

The declaration arrives as an argument (`declared_paths`), never by reading a
profile here: this module classifies, and resolving consumer configuration
stays the caller's business. A declaration names one exact path — it is not a
glob and never a prefix, because consent that widens itself is no longer the
consumer's declaration. It also waives nothing for anything but a regular
file: a directory or a symlink standing at a declared path is not the file the
declaration describes, so it keeps the comparison and its block.

An ignored symlink is deletable only when its target resolves inside the
assessed worktree; the link itself is unlinked and never followed. Absolute
targets, escaping targets, dangling targets, and a target that changed between
assessment and action are hard stops that name the link. The containment check
applies to the ignored entries git itself reports: git collapses an ignored
directory into a single record, and the contained recursive removal below
never follows a symlink, so a pnpm-style symlink farm inside such a directory
is removable with zero configuration.

One assessment object serves both surfaces: `assess()` returns it, a preview
renders it with `render_report()`, and the action consumes exactly that object
in `remove_scratch()`. There is no second formatter and no persisted evidence —
idempotency comes from re-running the assessment, not from a journal.

Deletion policy is configured by declaration only — the ignore mechanism plus
the seed declaration a consumer already writes to say what a worktree carries.
This module reads no consumer-profile pattern list.

## Residual risks — accepted deliberately

- Between assessment and deletion a file could in principle be replaced.
- A valuable file a consumer keeps gitignored outside `.env*` is deletable at
  teardown.
- A declared `.env*` file is deleted without any comparison against the main
  checkout. That is exactly the consent its declaration grants, so every such
  deletion is named in the report.
"""

from __future__ import annotations

import fnmatch
import io
import os
import stat
import subprocess
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

TOP_DIRECTORY_LIMIT = 5
EXAMPLE_LIMIT = 5
ENV_BASENAME_GLOB = ".env*"

RULE_TRACKED = "tracked-change"
RULE_UNMERGED = "unmerged-path"
RULE_UNTRACKED = "untracked-files"
RULE_ENV = "env-file"
RULE_SYMLINK = "ignored-symlink"

_READ_CHUNK = 128 * 1024
_ITEM_LIMIT = 200
_DIRECTORY_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
_FILE_FLAGS = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
# Path fields per porcelain v2 record type; the path is the field after them.
_LEADING_FIELDS = {"1": 8, "2": 9, "u": 10}


class ClassificationError(RuntimeError):
    """Teardown cannot be classified or acted on safely."""


@dataclass(frozen=True)
class Scratch:
    """One ignored entry cleared for deletion.

    `declared` records *why* it was cleared: this is a `.env*` file the
    consumer's seed profile names, so the comparison was waived by consent.
    """

    path: str
    kind: str  # "file" | "directory" | "symlink"
    link_target: str | None = None
    declared: bool = False


@dataclass(frozen=True)
class Block:
    """One fired rule: what it saw, capped examples, and the fix."""

    rule: str
    summary: str
    items: tuple[str, ...]
    item_count: int
    fix: str


@dataclass(frozen=True)
class Assessment:
    """The single report object shared by preview and action.

    `declared_deletions` names the `.env*` files the consumer's own declaration
    cleared without any main-checkout comparison, so consent stays visible
    exactly where it is used.
    """

    worktree: str
    main_checkout: str
    root_device: int
    root_inode: int
    scratch: tuple[Scratch, ...]
    blocks: tuple[Block, ...]
    declared_deletions: tuple[str, ...] = ()

    @property
    def removable(self) -> bool:
        return not self.blocks


def assess(worktree, main_checkout, declared_paths=()) -> Assessment:
    """Classify the worktree's current state into scratch plus blocking rules.

    `declared_paths` are the repository-relative paths the consumer's seed
    profile declares. They waive the `.env*` comparison for exactly those
    paths and nothing else; every other rule applies unchanged.
    """
    worktree = Path(worktree)
    main_checkout = Path(main_checkout)
    metadata = os.lstat(worktree)
    if not stat.S_ISDIR(metadata.st_mode):
        raise ClassificationError(f"worktree is not a directory: {worktree}")
    buckets: dict[str, list[str]] = {"1": [], "u": [], "?": [], "!": []}
    for kind, paths in _status_records(worktree):
        buckets["1" if kind == "2" else kind].extend(paths)
    scratch, env_offenders, link_offenders, nested_consented = _classify_ignored(
        worktree, main_checkout, buckets["!"], _declared_set(declared_paths)
    )
    consented = [entry.path for entry in scratch if entry.declared] + nested_consented
    blocks = [
        block
        for block in (
            _named_block(RULE_TRACKED, buckets["1"], "tracked change", "commit or stash"),
            _named_block(RULE_UNMERGED, buckets["u"], "unmerged path", "resolve and commit"),
            _untracked_block(buckets["?"]),
            _named_block(RULE_ENV, env_offenders, ".env* file", _ENV_FIX),
            _named_block(RULE_SYMLINK, link_offenders, "ignored symlink", _SYMLINK_FIX),
        )
        if block is not None
    ]
    return Assessment(
        str(worktree),
        str(main_checkout),
        metadata.st_dev,
        metadata.st_ino,
        tuple(sorted(scratch, key=lambda entry: entry.path)),
        tuple(blocks),
        tuple(sorted(consented)),
    )


def _declared_set(declared_paths) -> frozenset[str]:
    """Normalize the consumer's declared paths into exact repository-relative keys."""
    normalized = set()
    for declared in declared_paths or ():
        text = str(declared).strip()
        if text:
            normalized.add(str(PurePosixPath(text)))
    return frozenset(normalized)


_ENV_FIX = (
    "copy the named .env* file out or make it identical to the main checkout copy"
)
_SYMLINK_FIX = "remove the named symlink or point it inside the worktree"


def _status_records(worktree: Path):
    """Read `git status --porcelain=v2 -z` and split it back into records."""
    # `--ignored=matching` keeps an ignored directory one record instead of
    # thousands; `-z` is required because paths carry spaces, quotes and
    # newlines; `--untracked-files=all` makes the untracked count exact.
    command = ["git", "-C", str(worktree), "status", "--porcelain=v2", "-z"]
    command += ["--untracked-files=all", "--ignored=matching"]
    completed = subprocess.run(command, capture_output=True)
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()
        raise ClassificationError(f"git status failed in {worktree}: {detail}")
    return _parse_status(completed.stdout)


def _parse_status(payload: bytes):
    """Yield (record type, paths) — a rename carries two NUL-separated paths."""
    chunks = payload.split(b"\0")
    records = []
    index = 0
    while index < len(chunks):
        raw = chunks[index]
        index += 1
        if not raw:
            continue
        kind = chr(raw[0])
        if kind in ("?", "!"):
            records.append((kind, [os.fsdecode(raw[2:])]))
            continue
        if kind not in _LEADING_FIELDS:
            raise ClassificationError(f"unsupported git status record: {kind!r}")
        fields = raw.split(b" ", _LEADING_FIELDS[kind])
        if len(fields) != _LEADING_FIELDS[kind] + 1:
            raise ClassificationError(f"malformed git status record: {raw!r}")
        paths = [os.fsdecode(fields[-1])]
        if kind == "2":
            if index >= len(chunks):
                raise ClassificationError("truncated rename record: origin path missing")
            paths.append(os.fsdecode(chunks[index]))
            index += 1
        records.append((kind, paths))
    return records


def _classify_ignored(
    worktree: Path,
    main_checkout: Path,
    ignored: list[str],
    declared: frozenset[str] = frozenset(),
):
    """Split ignored entries into scratch, `.env*` offenders and link offenders.

    A waived `.env*` file skips the comparison and is classified as the ordinary
    ignored regular file it is; every other rule keeps applying unchanged.
    """
    scratch: list[Scratch] = []
    env_offenders: list[str] = []
    link_offenders: list[str] = []
    nested_consented: list[str] = []
    for entry in ignored:
        relative = entry[:-1] if entry.endswith("/") else entry
        metadata = _lstat(worktree, relative)
        waived = _is_waived(relative, metadata, declared)
        if _is_env(relative) and not waived:
            problem = _env_problem(worktree, main_checkout, relative, metadata)
            if problem is None:
                scratch.append(Scratch(relative, "file"))
            else:
                env_offenders.append(f"{relative} — {problem}")
        elif stat.S_ISLNK(metadata.st_mode):
            problem, target = _link_problem(worktree, relative)
            if problem is None:
                scratch.append(Scratch(relative, "symlink", target))
            else:
                link_offenders.append(f"{relative} — {problem}")
        elif stat.S_ISDIR(metadata.st_mode):
            nested, cleared = _nested_env_problems(
                worktree, main_checkout, relative, declared
            )
            env_offenders.extend(nested)
            if not nested:
                nested_consented.extend(cleared)
                scratch.append(Scratch(relative, "directory"))
        else:
            scratch.append(Scratch(relative, "file", None, waived))
    return scratch, env_offenders, link_offenders, nested_consented


def _is_waived(relative: str, metadata, declared: frozenset[str]) -> bool:
    """Does the consumer's own declaration clear this `.env*` file for deletion?

    Only an exact declared path, and only a regular file: a directory or a
    symlink standing at a declared path is not the file the declaration
    describes, so it keeps the conservative comparison and its block.
    """
    return (
        _is_env(relative)
        and relative in declared
        and stat.S_ISREG(metadata.st_mode)
    )


def _lstat(root: Path, relative: str):
    try:
        return os.lstat(root / relative)
    except OSError as error:
        raise ClassificationError(f"cannot read {relative}: {error}") from error


def _is_env(relative: str) -> bool:
    return fnmatch.fnmatchcase(PurePosixPath(relative).name, ENV_BASENAME_GLOB)


def _nested_env_problems(
    worktree: Path,
    main_checkout: Path,
    relative: str,
    declared: frozenset[str] = frozenset(),
):
    """Find `.env*` files inside an ignored directory git reported as one entry.

    Returns the blocking problems plus the declared paths whose comparison this
    consumer waived, so a consented nested deletion can be named in the report.
    """
    problems = []
    consented = []
    base = worktree / relative
    for directory, _subdirectories, names in os.walk(base, followlinks=False):
        for name in names:
            if not fnmatch.fnmatchcase(name, ENV_BASENAME_GLOB):
                continue
            nested = str(PurePosixPath(relative) / os.path.relpath(
                os.path.join(directory, name), base
            ))
            metadata = _lstat(worktree, nested)
            if _is_waived(nested, metadata, declared):
                consented.append(nested)
                continue
            problem = _env_problem(worktree, main_checkout, nested, metadata)
            if problem is not None:
                problems.append(f"{nested} — {problem}")
    return sorted(problems), sorted(consented)


def _env_problem(worktree: Path, main_checkout: Path, relative: str, metadata):
    """Compare one `.env*` file with its main-checkout counterpart, no-follow."""
    if not stat.S_ISREG(metadata.st_mode):
        return "not a regular file in the worktree"
    try:
        with _opened_regular(worktree, relative) as left:
            with _opened_regular(main_checkout, relative) as right:
                if left is None or right is None:
                    return "absent from the main checkout, or not a regular file there"
                return None if _same_bytes(left, right) else "differs from the main checkout copy"
    except OSError as error:
        raise ClassificationError(f"cannot compare {relative}: {error}") from error


@contextmanager
def _opened_regular(root: Path, relative: str):
    """Open a regular file below root, following nothing; yield None if it is
    missing, unreachable, or not a regular file — all three block a `.env*`."""
    stream = None
    try:
        try:
            with _opened_directory(root) as root_descriptor:
                with _contained_parent(root_descriptor, relative) as (parent, name):
                    descriptor = os.open(name, _FILE_FLAGS, dir_fd=parent)
                    if stat.S_ISREG(os.fstat(descriptor).st_mode):
                        stream = io.open(descriptor, "rb")
                    else:
                        os.close(descriptor)
        except OSError:
            stream = None
        yield stream
    finally:
        if stream is not None:
            stream.close()


def _same_bytes(left, right) -> bool:
    if os.fstat(left.fileno()).st_size != os.fstat(right.fileno()).st_size:
        return False
    while True:
        chunk = left.read(_READ_CHUNK)
        if chunk != right.read(_READ_CHUNK):
            return False
        if not chunk:
            return True


def _link_problem(worktree: Path, relative: str):
    """Decide whether an ignored symlink stays contained; never follow it."""
    link = worktree / relative
    target = os.readlink(link)
    if os.path.isabs(target):
        return "absolute target", target
    if not os.path.exists(link):
        return "dangling target", target
    inside = os.path.realpath(worktree)
    resolved = os.path.realpath(link)
    if resolved != inside and not resolved.startswith(inside + os.sep):
        return "target escapes the worktree", target
    return None, target


def _named_block(rule: str, items, noun: str, fix: str):
    if not items:
        return None
    unique = sorted(dict.fromkeys(items))
    one = len(unique) == 1
    return Block(
        rule,
        f"{len(unique)} {noun}{'' if one else 's'} {'blocks' if one else 'block'} teardown",
        tuple(_shorten(item) for item in unique[:EXAMPLE_LIMIT]),
        len(unique),
        f"{fix}, then run teardown again",
    )


def _untracked_block(paths):
    if not paths:
        return None
    counts = Counter(_parent(path) for path in paths)
    top = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))[:TOP_DIRECTORY_LIMIT]
    files = _count(len(paths), "untracked file")
    return Block(
        RULE_UNTRACKED,
        f"{files} in {_count(len(counts), 'directory', 'directories')} "
        f"{'is' if len(paths) == 1 else 'are'} not ignored",
        tuple(
            f"{_shorten(directory)} ({_count(count, 'file')})"
            for directory, count in top
        ),
        len(counts),
        "ignore or remove the untracked files, then run teardown again",
    )


def _count(total: int, noun: str, plural: str | None = None) -> str:
    return f"{total} {noun}" if total == 1 else f"{total} {plural or noun + 's'}"


def _parent(path: str) -> str:
    parent = str(PurePosixPath(path).parent)
    return "./" if parent == "." else f"{parent}/"


def _shorten(text: str) -> str:
    """Truncate one reported item and make it printable.

    Paths arrive decoded with surrogateescape, so a non-UTF-8 filename would
    otherwise raise while the refusal is being printed — a report that cannot
    be shown names nothing, which is the failure this module replaces.
    """
    printable = text.encode("utf-8", "replace").decode("utf-8")
    return printable if len(printable) <= _ITEM_LIMIT else f"{printable[:_ITEM_LIMIT]}…"


def _declared_lines(declared: tuple[str, ...]) -> list[str]:
    """Name the deletions the consumer's own declaration authorized.

    Consent is only consent while it is visible where it is used, so a `.env*`
    file deleted without any main-checkout comparison is named in the same
    bounded report that lists the ordinary scratch.
    """
    if not declared:
        return []
    shown = declared[:EXAMPLE_LIMIT]
    lines = [
        f"Deletable by your own seed declaration: {len(declared)} "
        "(no main-checkout comparison)."
    ]
    lines.extend(f"  - {_shorten(path)}" for path in shown)
    if len(declared) > len(shown):
        lines.append(f"  … {len(declared) - len(shown)} more (not listed)")
    return lines


def render_report(assessment: Assessment) -> str:
    """Render the one assessment object — always bounded, never a path dump."""
    if assessment.removable:
        preview = [entry.path for entry in assessment.scratch[:EXAMPLE_LIMIT]]
        lines = [f"Teardown is clear: {len(assessment.scratch)} scratch entries are deletable."]
        lines.extend(f"  - {_shorten(path)}" for path in preview)
        if len(assessment.scratch) > len(preview):
            lines.append(f"  … {len(assessment.scratch) - len(preview)} more (not listed)")
        lines.extend(_declared_lines(assessment.declared_deletions))
        return "\n".join(lines)
    lines = []
    for block in assessment.blocks:
        lines.append(f"[{block.rule}] {block.summary}:")
        lines.extend(f"  - {item}" for item in block.items)
        if block.item_count > len(block.items):
            lines.append(f"  … {block.item_count - len(block.items)} more (not listed)")
        lines.append(f"  fix: {block.fix}")
    return "\n".join(lines)


def remove_scratch(assessment: Assessment) -> tuple[str, ...]:
    """Delete every entry the given assessment cleared — the action's only input."""
    if not assessment.removable:
        raise ClassificationError(
            "teardown is blocked:\n" + render_report(assessment)
        )
    removed = []
    with _verified_root(assessment) as root_descriptor:
        for entry in assessment.scratch:
            _remove_entry(root_descriptor, entry)
            removed.append(entry.path)
    return tuple(removed)


@contextmanager
def _opened_directory(path: Path):
    descriptor = os.open(path, _DIRECTORY_FLAGS)
    try:
        yield descriptor
    finally:
        os.close(descriptor)


@contextmanager
def _verified_root(assessment: Assessment):
    """Re-open the assessed root no-follow and re-check its identity."""
    try:
        with _opened_directory(Path(assessment.worktree)) as descriptor:
            metadata = os.fstat(descriptor)
            if (metadata.st_dev, metadata.st_ino) != (
                assessment.root_device,
                assessment.root_inode,
            ):
                raise ClassificationError("worktree root changed before removal")
            yield descriptor
    except OSError as error:
        raise ClassificationError("worktree root changed before removal") from error


@contextmanager
def _contained_parent(root_descriptor: int, relative: str):
    """Walk to the entry's parent directory without following any symlink."""
    parts = PurePosixPath(relative).parts
    if PurePosixPath(relative).is_absolute() or not parts or any(
        part in {"", ".", ".."} for part in parts
    ):
        raise ClassificationError(f"unsafe scratch path: {relative}")
    opened = []
    current = root_descriptor
    try:
        for component in parts[:-1]:
            current = os.open(component, _DIRECTORY_FLAGS, dir_fd=current)
            opened.append(current)
        yield current, parts[-1]
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)


def _remove_entry(root_descriptor: int, entry: Scratch) -> None:
    """Delete one assessed entry, re-checking its kind immediately before."""
    try:
        with _contained_parent(root_descriptor, entry.path) as (parent, name):
            metadata = os.lstat(name, dir_fd=parent)
            if entry.kind == "symlink":
                if not stat.S_ISLNK(metadata.st_mode):
                    raise ClassificationError(f"scratch entry changed: {entry.path}")
                if os.readlink(name, dir_fd=parent) != entry.link_target:
                    raise ClassificationError(f"symlink target changed: {entry.path}")
                os.unlink(name, dir_fd=parent)
            elif entry.kind == "directory":
                if not stat.S_ISDIR(metadata.st_mode):
                    raise ClassificationError(f"scratch entry changed: {entry.path}")
                _remove_tree(parent, name)
            else:
                if stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                    raise ClassificationError(f"scratch entry changed: {entry.path}")
                os.unlink(name, dir_fd=parent)
    except OSError as error:
        raise ClassificationError(f"scratch entry changed: {entry.path}") from error


def _remove_tree(parent_descriptor: int, name: str) -> None:
    """Remove a directory tree contained by dir_fd walking, following nothing."""
    descriptor = os.open(name, _DIRECTORY_FLAGS, dir_fd=parent_descriptor)
    try:
        for entry in os.scandir(descriptor):
            if entry.is_dir(follow_symlinks=False):
                _remove_tree(descriptor, entry.name)
            else:
                os.unlink(entry.name, dir_fd=descriptor)
    finally:
        os.close(descriptor)
    os.rmdir(name, dir_fd=parent_descriptor)
