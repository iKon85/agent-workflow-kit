# Evidence: codex-exec.sh over-precise version pin masked a local defect

Captured 2026-07-28 during the grill-with-docs-codex session for the mechanism anchor.
Repo HEAD at capture: ca55b17fb6a19d12fb0595082cb894e9468fd5fc
Installed Codex: codex-cli 0.145.0

## Pre-fix state (working tree diff, this session)

```diff
diff --git a/scripts/codex-exec.sh b/scripts/codex-exec.sh
index e483c4e..94adea0 100755
--- a/scripts/codex-exec.sh
+++ b/scripts/codex-exec.sh
@@ -3,7 +3,7 @@ set -u
 
 SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
 PROC_HELPER="$SCRIPT_DIR/codex_proc.py"
-TESTED_VERSIONS=("0.137.0" "0.144.6")
+TESTED_VERSIONS=("0.137.0" "0.144.6" "0.145.0")
 SUPPORTED_EFFORTS=("low" "medium" "high" "xhigh" "max" "ultra")
 STATE_ROOT=${CODEX_EXEC_STATE_ROOT:-${TMPDIR:-/tmp}/codex-exec-state}
 
@@ -179,7 +179,7 @@ launch_round() {
   prepare_prompt "$state_dir" || return 1
   local command
   if [[ -z $thread_id ]]; then
-    command=("$CODEX_BIN" exec --json --sandbox "$SANDBOX")
+    command=("$CODEX_BIN" exec --sandbox "$SANDBOX")
   else
     command=("$CODEX_BIN" exec resume "$thread_id" -c "sandbox_mode=$SANDBOX")
   fi
```

## Observed failure, pre-fix

```
$ scripts/codex-exec.sh new --profile review --mode read-only --prompt "..."
{"error":"UNTESTED_VERSION","message":"Codex version is not in the exact tested allowlist","status":"EXEC_FAILED"}

# after adding 0.145.0 to the allowlist, the real cause surfaced:
{"originalExitStatus":2,"status":"EXEC_FAILED","verdict":null}

$ codex exec --json --sandbox read-only --json -   # the command the wrapper built
Usage: codex exec [OPTIONS] [PROMPT]
EXIT=2

$ codex exec --sandbox read-only --json -          # single --json
{"type":"turn.completed",...}   EXIT=0
```
