#!/usr/bin/env python3
"""Run one Codex round in an owned process group and classify its result."""

from __future__ import annotations

import argparse
import json
import os
import re
import selectors
import signal
import shutil
import subprocess
import sys
import time
from pathlib import Path


REDACTIONS = (
    (re.compile(r"(?i)(token|api[_-]?key|password)=\S+"), r"\1=[REDACTED]"),
    (re.compile(r"(?i)bearer\s+\S+"), "Bearer [REDACTED]"),
)
CANCEL_REQUESTED = False


def request_cancel(_signum: int, _frame: object) -> None:
    global CANCEL_REQUESTED
    CANCEL_REQUESTED = True


def atomic_write(path: Path, text: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def redact(data: bytes) -> bytes:
    text = data.decode("utf-8", errors="replace")
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    return text.encode()


def terminate_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 0.3
    while time.monotonic() < deadline:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.02)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def parse_events(stdout: bytes) -> tuple[bool, str | None, str | None]:
    malformed = False
    thread_id = None
    verdict = None
    for raw_line in stdout.decode("utf-8", errors="replace").splitlines():
        if not raw_line.strip():
            continue
        try:
            event = json.loads(raw_line)
        except json.JSONDecodeError:
            malformed = True
            continue
        if event.get("type") == "thread.started":
            thread_id = event.get("thread_id")
        item = event.get("item", {})
        if event.get("type") == "item.completed" and item.get("type") == "agent_message":
            verdict = item.get("text") or None
    return malformed, thread_id, verdict


def classification(reason: str | None, returncode: int, stdout: bytes) -> dict:
    malformed, thread_id, verdict = parse_events(stdout)
    signal_name = signal.Signals(-returncode).name if returncode < 0 else None
    if reason == "cancelled":
        status = "CANCELLED"
    elif reason == "hung":
        status = "HUNG"
    elif reason == "timeout":
        status = "TIMEOUT"
    elif returncode < 0:
        status = "SIGNALLED"
    elif returncode != 0:
        status = "EXEC_FAILED"
    elif malformed:
        status = "MALFORMED-JSON"
    elif not thread_id:
        status = "NO-THREAD"
    elif not verdict:
        status = "NO-VERDICT"
    else:
        status = "OK"
    return {
        "status": status,
        "threadId": thread_id,
        "verdict": verdict,
        "originalExitStatus": returncode if returncode >= 0 else None,
        "signal": signal_name,
    }


def drain_process(args: argparse.Namespace, process: subprocess.Popen[bytes]) -> tuple[bytes, int, str | None]:
    selector = selectors.DefaultSelector()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    stdout_path = Path(args.state_dir) / f"round-{args.round}.stdout.jsonl"
    stderr_path = Path(args.state_dir) / f"round-{args.round}.stderr.log"
    started_at = time.monotonic()
    saw_activity = False
    saw_thread = False
    reason = None
    with stdout_path.open("xb") as stdout_file, stderr_path.open("xb") as stderr_file:
        for stream, name in ((process.stdout, "stdout"), (process.stderr, "stderr")):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            cancel_requested = (Path(args.state_dir) / "cancel.request").exists()
            elapsed = time.monotonic() - started_at
            if cancel_requested or CANCEL_REQUESTED:
                reason = "cancelled"
            elif elapsed >= args.timeout:
                reason = "timeout"
            elif not saw_activity and not saw_thread and elapsed >= args.probe_timeout:
                reason = "hung"
            if reason:
                terminate_group(process)
            for key, _ in selector.select(timeout=0.03):
                try:
                    chunk = os.read(key.fileobj.fileno(), 65_536)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                saw_activity = True
                buffers[key.data].extend(chunk)
                if key.data == "stdout":
                    stdout_file.write(chunk)
                    if b'"type":"thread.started"' in buffers["stdout"].replace(b" ", b""):
                        saw_thread = True
            if process.poll() is not None and not selector.get_map():
                break
        stderr_file.write(redact(bytes(buffers["stderr"])))
        return bytes(buffers["stdout"]), process.wait(), reason


def run_round(args: argparse.Namespace) -> int:
    state_dir = Path(args.state_dir)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise SystemExit("process command is required")
    prompt_path = state_dir / f"round-{args.round}.prompt.txt"
    if prompt_path.exists():
        raise SystemExit(f"round {args.round} already exists")
    prompt_path.write_bytes(Path(args.prompt_file).read_bytes())
    signal.signal(signal.SIGINT, request_cancel)
    signal.signal(signal.SIGTERM, request_cancel)
    with prompt_path.open("rb") as prompt:
        process = subprocess.Popen(
            command,
            stdin=prompt,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        atomic_write(state_dir / "runtime.json", json.dumps({"pid": process.pid, "pgid": process.pid}))
        try:
            stdout, returncode, reason = drain_process(args, process)
            if (state_dir / "cancel.request").exists():
                reason = "cancelled"
        finally:
            (state_dir / "runtime.json").unlink(missing_ok=True)
    result = classification(reason, returncode, stdout)
    result.update({
        "runId": (state_dir / "run-id").read_text().strip(),
        "stateDir": str(state_dir),
        "round": args.round,
        "profile": args.profile,
        "sandbox": args.sandbox,
    })
    result_path = state_dir / f"round-{args.round}.result.json"
    result_path.write_text(json.dumps(result, sort_keys=True) + "\n", encoding="utf-8")
    atomic_write(state_dir / "latest", result_path.name + "\n")
    print(json.dumps(result, sort_keys=True), flush=True)
    return 0 if result["status"] == "OK" else 1


def cancel(args: argparse.Namespace) -> int:
    state_dir = Path(args.state_dir)
    (state_dir / "cancel.request").touch(mode=0o600, exist_ok=True)
    runtime = state_dir / "runtime.json"
    if runtime.exists():
        try:
            pgid = json.loads(runtime.read_text())["pgid"]
            os.killpg(pgid, signal.SIGTERM)
        except (FileNotFoundError, ProcessLookupError, KeyError, json.JSONDecodeError):
            pass
    deadline = time.monotonic() + 3
    while runtime.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    return 0 if not runtime.exists() else 1


def cleanup(args: argparse.Namespace) -> int:
    root = Path(args.state_root)
    now = time.time()
    removed = 0
    candidates = sorted(root.glob("codex-exec.*"), key=lambda path: path.stat().st_mtime)
    for state_dir in candidates:
        if removed >= args.max_delete:
            break
        run_id = state_dir.name.removeprefix("codex-exec.")
        identity = state_dir / "run-id"
        protected = (state_dir / "runtime.json").exists() or (state_dir / "debug-retain").exists()
        try:
            valid = identity.read_text().strip() == run_id
        except (FileNotFoundError, OSError):
            valid = False
        if valid and not protected and now - state_dir.stat().st_mtime >= args.stale_seconds:
            shutil.rmtree(state_dir)
            removed += 1
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="action", required=True)
    run = commands.add_parser("run")
    run.add_argument("--state-dir", required=True)
    run.add_argument("--round", required=True, type=int)
    run.add_argument("--profile", required=True)
    run.add_argument("--sandbox", required=True)
    run.add_argument("--timeout", required=True, type=float)
    run.add_argument("--probe-timeout", required=True, type=float)
    run.add_argument("--prompt-file", required=True)
    run.add_argument("command", nargs=argparse.REMAINDER)
    stop = commands.add_parser("cancel")
    stop.add_argument("--state-dir", required=True)
    stale = commands.add_parser("cleanup")
    stale.add_argument("--state-root", required=True)
    stale.add_argument("--stale-seconds", required=True, type=float)
    stale.add_argument("--max-delete", required=True, type=int)
    return root


if __name__ == "__main__":
    parsed = parser().parse_args()
    actions = {"run": run_round, "cancel": cancel, "cleanup": cleanup}
    sys.exit(actions[parsed.action](parsed))
