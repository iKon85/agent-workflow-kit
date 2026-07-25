# Contribution return routing

Contribution return is an optional repository capability. It controls which
routes agents may *offer* for an explicit Contribution Bridge; it never grants
permission to mutate a remote.

The consumer-owned section in `docs/agents/workflow-capabilities.json` is:

```json contribution-routing-capability
{
  "contributionRouting": {
    "schemaVersion": 1,
    "enabled": true,
    "upstream": {
      "repository": "<owner>/<repository>",
      "remote": "<local-git-remote>"
    },
    "workflows": {
      "prepareLocal": true,
      "upstreamPullRequest": {
        "enabled": true,
        "requiresExplicitApproval": true
      }
    }
  }
}
```

The resolver accepts the maintainer-capable route only when the configured Git
remote exists and its GitHub owner/repository matches `upstream.repository`.
It does not inspect usernames, home paths, machine names, the consumer
repository name, credentials, or GitHub account identity.

- Missing configuration is a generic Consumer: offer preserve or Explicit fork.
- `enabled: false` is an explicit opt-out with the same generic routes.
- Invalid, contradictory, or unverifiable configuration fails closed to those
  generic routes and reports one bounded diagnostic.
- Valid configuration additionally offers local artifact preparation. It may
  describe an upstream pull-request route only with
  `requiresExplicitApproval: true`; this flag documents the gate and does not
  satisfy it.

Use the same read-only resolver on every surface:

```sh
agent-workflow-kit contribute status <path> --surface=retro
agent-workflow-kit contribute status <path> --surface=pre-update
agent-workflow-kit contribute status <path> --surface=guard
```

Only `contribute prepare` writes a local bounded artifact. No contribution
command opens an issue or pull request, pushes, publishes, or merges.
