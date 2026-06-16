#!/bin/bash

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command')

# Push is narrowed: only a push to main/master OR a force-push is blocked — a
# normal feature-branch push is allowed (the git-level .githooks/pre-push hook is
# the main-push backstop). All other destructive ops stay blocked outright.
DANGEROUS_PATTERNS=(
  "git push.*[ :](main|master)([[:space:]]|$)"
  "git push.*(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$))"
  "git reset --hard"
  "git clean -fd"
  "git clean -f"
  "git branch -D"
  "git checkout \."
  "git restore \."
  "reset --hard"
)

for pattern in "${DANGEROUS_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED: '$COMMAND' matches dangerous pattern '$pattern'. The user has prevented you from doing this." >&2
    exit 2
  fi
done

exit 0
