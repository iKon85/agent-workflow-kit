# Safety Guardrails setup contract

Safety Guardrails is a counted, opt-in capability group backed by the
consumer-owned `docs/agents/workflow-capabilities.json` profile. Its four
rows are selected independently: one protects agent tool calls and three
bootstrap repository security. No repository name, package manager, hook
surface, threshold, path, or outage policy is inferred from the kit.

## Choice matrix

| State | Setup action |
|---|---|
| `missing` | Ask `yes / later / no`; do not infer or write before the answer. |
| `yes` | Ask which rows to enable, stage profile plus selected wiring, validate, then activate. |
| `later` | Record the retryable deferral; do not activate any wiring. |
| `no` | Record the opt-out; do not activate any wiring. |
| `existing` | Adopt the consumer profile and existing wiring byte-safely. |
| `disable` | Remove exact kit-owned Agent and Git wiring first, then set `enabled: false`. |

```json safety-guardrails-setup-effects
[
  {"state":"missing","choice":null,"operations":[]},
  {"state":"yes","choice":"yes","operations":["record-choice","stage-enabled-profile","stage-agent-hook-wiring","stage-git-hook-wiring","activate-staged-profile"]},
  {"state":"later","choice":"later","operations":["record-choice"]},
  {"state":"no","choice":"no","operations":["record-choice"]},
  {"state":"existing","choice":"yes","operations":["adopt-existing"]},
  {"state":"disable","choice":"yes","operations":["remove-agent-hook-wiring","remove-git-hook-wiring","update-profile-disabled"]}
]
```

## Counted capability map

Every current Safety row maps to one profile decision and one shipped
artifact. Setup reports the result as `N of 4 enabled`, never as one
all-or-nothing switch. The `secrets`, `packageManager`, and `doubleBackground`
agent adapters were retired by the 2026-07 hook review (no named incident);
their profile keys in an existing consumer profile are inert consumer data,
kept verbatim and never rewired.

```json safety-guardrails-capabilities
[
  {"id":"searchShim","profilePath":"safetyGuardrails.searchShim.enabled","artifact":".claude/hooks/grep-shim-guard.py"},
  {"id":"gitHooks","profilePath":"safetyGuardrails.repositorySecurity.gitHooks.enabled","artifact":"scripts/security/install-git-hooks.mjs"},
  {"id":"gitleaks","profilePath":"safetyGuardrails.repositorySecurity.gitleaks.enabled","artifact":"scripts/security/ensure-gitleaks.mjs"},
  {"id":"dependencyAudit","profilePath":"safetyGuardrails.repositorySecurity.dependencyAudit.enabled","artifact":"scripts/security/audit-gate.mjs"}
]
```

## Profile shape

Reconcile only `safetyGuardrails`; preserve every sibling section, unknown key,
and consumer-owned value. The following is the reference consumer's parity-on
example, not a universal default. Other consumers choose each `enabled` value
and fill only facts proven in their repository.

```json
{
  "safetyGuardrails": {
    "choice": "yes",
    "enabled": true,
    "secrets": {
      "enabled": true,
      "sensitiveNames": [".env", ".npmrc", "credentials.json"],
      "sensitivePathFragments": ["secrets/", ".ssh/"],
      "safeTemplateSuffixes": [".example", ".sample", ".template", ".dist"]
    },
    "packageManager": {
      "enabled": true,
      "lockfiles": {
        "pnpm-lock.yaml": "pnpm",
        "package-lock.json": "npm",
        "yarn.lock": "yarn",
        "bun.lockb": "bun"
      }
    },
    "doubleBackground": {"enabled": true, "surfaces": ["claude"]},
    "searchShim": {
      "enabled": true,
      "detected": true,
      "commandNames": ["grep", "rg"]
    },
    "repositorySecurity": {
      "gitHooks": {"enabled": true, "hooksPath": ".githooks"},
      "gitleaks": {"enabled": true, "required": false},
      "dependencyAudit": {
        "enabled": true,
        "packageManager": "pnpm",
        "outagePolicy": "warn",
        "blockSeverities": ["high", "critical"]
      }
    }
  }
}
```

An empty or disabled row is an honest no-op. `searchShim.detected` is a
consumer fact, not an installation request. `gitleaks.required: false` keeps
the verified optional provisioner non-blocking when the platform or network is
unsupported. Dependency-audit outage policy must be explicit.

## Agent-hook ownership

Wire only the enabled row, using the exact kit-owned command:

- `searchShim` —
  `python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/grep-shim-guard.py"`

It is a PreToolUse adapter. Preserve unrelated matchers and commands in
`.claude/settings.json` — including wiring for retired adapters, which is
consumer data. Disable removes only this exact command.

## Repository wiring

When `gitHooks.enabled` is true, run:

```bash
node scripts/security/install-git-hooks.mjs <hooksPath>
```

only after confirming the configured directory exists and contains the
consumer's intended hooks. Never create or replace consumer hook bodies.

When `gitleaks.enabled` is true, the pinned profile may be provisioned through
`scripts/security/ensure-gitleaks.mjs`; checksum mismatch, unsupported platform,
offline state, and unwritable destination remain distinct visible outcomes.
Never read a secret file to test the provisioner.

When `dependencyAudit.enabled` is true, use
`scripts/security/audit-gate.mjs` with the configured package manager and
outage policy. High/Critical findings block; Low/Moderate findings pass.

## Transaction and failure contract

Prepare the next profile and `.claude/settings.json` in same-directory staging
files. Validate JSON, all selected artifact paths, the four-row count, the
configured Git-hook directory, and package-manager facts before mutation.
Then:

1. reconcile selected Agent commands in the staged settings;
2. remember the prior `core.hooksPath` and apply the selected Git wiring;
3. atomically rename staged settings and profile into place;
4. on any failure, restore the prior Git config and leave active files
   byte-for-byte unchanged.

Disable reverses the safety order: remove exact Agent commands and restore or
unset only the kit-owned Git wiring before committing `enabled: false`.
Repeated activation with the same choices is byte-idempotent.

Setup and verification may inspect paths, profile metadata, command exit
status, advisory counts, and hashes. They must never read secret contents or
print environment/config values.
