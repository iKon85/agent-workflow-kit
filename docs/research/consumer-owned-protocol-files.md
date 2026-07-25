# Consumer-owned protocol files: evolution without overwrite or starvation

Verified on 2026-07-22 against `agent-workflow-kit` 0.33.0 in the issue #197
worktree. This note researches how an updater should handle a locally adapted
file that is also part of an evolving upstream protocol. It is decision input,
not a product change.

## Finding

A protocol-critical file must not be both an immutable consumer-owned fork and
the upstream kit's active protocol authority under the same path. Those two
contracts are incompatible: permanent consumer ownership prevents protocol
evolution, while ordinary upstream ownership cannot preserve local policy.

The durable model is to split the mixed file into:

1. an upstream-owned, immutable **protocol core** that ships and evolves with
   the kit; and
2. a consumer-owned, structured **extension overlay** containing only local
   declarations and policy.

The staged update candidate composes core plus overlay and validates the whole
result before activation. A one-time migration extracts existing local
extensions from the mixed file. Ambiguity blocks that migration rather than
overwriting either side. A consumer that needs to change executable protocol
behavior has made a real code fork and needs a separate artifact/version line,
not `origin: consumer` on the upstream path.

## Current local contract and failure mode

The accepted divergence policy defines a consumer-owned path as a deliberate
fork that receives no overwrite, conflict report, deletion prompt, or future
kit improvement ([ADR 0001](../adr/0001-consumer-divergence-policy.md)). The
reconciler implements that literally: as soon as an installed entry has
`origin: 'consumer'`, it carries the old manifest record forward and skips all
upstream comparison
([`updateReconcile.mjs`](../../src/lib/updateReconcile.mjs)). This is coherent
for an independent local file, but it is update starvation for a protocol
authority.

Issue #196 exposed the concrete mixed-file shape. The readiness harness and
skills depend on `.claude/skills/skill-manifest.json`, but a real consumer owns
and extends that same registry. The published 0.32.0 artifact was internally
coherent; the consumer combined 15 local skill records and local notes with an
older upstream registry, while the newer kit added five skills, 23 readiness
capabilities, and 15 readiness declarations. Skipping the owned registry thus
allowed a new executable harness to run against an old protocol declaration.

The candidate transaction already has the right enforcement location: it
checks candidate hashes and destination races before activation and rolls back
all touched paths on failure
([`updateCandidate.mjs`](../../src/lib/updateCandidate.mjs)). What is missing is
a compositional protocol model and validator; copying more of the consumer or
adding more path exclusions does not solve that ownership contradiction.

## Comparable primary-source patterns

| System | Primary-source behavior | Lesson for the kit |
|---|---|---|
| Git three-way file merge | `git merge-file` combines the changes from a recorded common base to the upstream side with the local side; overlapping edits become explicit conflicts and a clean merge has a distinct successful exit status. [Git documentation](https://git-scm.com/docs/git-merge-file) | The stored installed hash/base makes a one-time three-way migration possible. A merge is evidence to inspect, not permission to silently overwrite. Text merge is unsuitable as the permanent extension mechanism because protocol identity and invariants are semantic, not line based. |
| GitHub forks | Syncing a fork explicitly fetches/merges upstream. Conflicts require a pull request or manual resolution; forcing sync overwrites the destination. [GitHub documentation](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork) | A true code fork has its own history and must deliberately integrate upstream. It cannot also promise automatic compatibility under the original identity. |
| Kubernetes Server-Side Apply | Kubernetes tracks ownership per structured field. An attempted value change to another manager's field conflicts; force is an explicit ownership transfer. A manager can also relinquish a field or share ownership by agreeing on the same value. [Kubernetes documentation](https://kubernetes.io/docs/reference/using-api/server-side-apply/) | Ownership below the file level works for schema-defined data. Core fields and consumer extension fields can have separate managers, with collisions rejected and transfers explicit. This model should not be imitated for arbitrary source-code lines. |
| Debian configuration files | Debian requires local configuration changes to survive upgrades. It distinguishes package conffiles from files generated and maintained by idempotent scripts, forbids mangling user configuration without asking, and warns that mixing the two handling styles causes repeated upgrade prompts. [Debian Policy](https://www.debian.org/doc/debian-policy/ch-files.html#behavior) `dpkg` separately exposes explicit keep-old/install-new/default choices for changed conffiles. [dpkg manual](https://manpages.debian.org/bookworm/dpkg/dpkg.1.en.html) | Choose one ownership model per artifact. Do not make one file simultaneously an upstream payload and a consumer-generated extension. Migrations must be idempotent, previewed, and preserve the old value on failure. |
| Terraform provider state | Terraform stores a resource schema version, asks the provider to upgrade older state before planning, rejects unsupported prior versions, and retains prior state when an upgrader reports errors. Each upgrader must produce a complete current-version state. [Terraform Plugin Framework](https://developer.hashicorp.com/terraform/plugin/framework/resources/state-upgrade) | Give the overlay an explicit schema version and deterministic upgraders. Validate the fully upgraded/composed state, not only the changed records. Unsupported or ambiguous inputs block activation without destroying the prior state. |
| Kubernetes API versioning | Kubernetes can serve old and new API versions concurrently, converts between representations, migrates stored objects separately, and removes an old version only after clients and stored objects have migrated. [Kubernetes CRD versioning](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definition-versioning/) | Compatibility needs an announced window: introduce/read both, migrate, count adoption, stop serving old, then remove conversion. A deprecation warning alone is not migration evidence. |
| Homebrew taps | An extracted or alternative formula lives in a separate Git repository/tap; its owner is responsible for maintenance, deprecations, and security updates. Naming or qualification avoids collision with the core formula. [Homebrew tap documentation](https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap) | A real executable fork needs a distinct artifact namespace and maintenance owner. It should not silently shadow the kit's protocol core at the same path. |

## Data/config extension versus code fork

These cases need different contracts.

### Structured consumer extension

Use an overlay when the consumer is adding data the upstream runtime already
knows how to interpret: local skill registrations, local capability evidence,
board values, activation decisions, or project policy. The upstream owns the
schema and executable semantics; the consumer owns values in a declared
extension namespace.

The overlay should have:

- its own consumer-native path and `schemaVersion`;
- stable record identities and an explicit allowed extension namespace;
- no ability to redefine reserved upstream/core records;
- deterministic, idempotent schema upgraders;
- a compatibility declaration tying overlay schema versions to supported
  protocol-core versions; and
- a composed-state validator that checks references, uniqueness, required
  declarations, and executable/declaration parity.

This is the applicable model for the mixed skill/readiness manifest. The
consumer's local skills are data extensions; the kit's shipped skill registry,
readiness schema, and harness contract are protocol core.

### Executable code fork

Use a true fork when the consumer changes parsing, evaluation, migration, or
other executable protocol behavior. The fork must then have a distinct package
or path identity, its own version and release channel, an explicit upstream
remote/base, and a deliberate sync/rebase/merge process. Compatibility with the
upstream package is no longer automatic.

Marking such code `consumer`-owned under the upstream path hides that reality:
it keeps the name but abandons the update channel. The Homebrew and GitHub
models make the trade-off honest: local history is preserved, upstream sync is
possible, conflicts are explicit, and maintenance responsibility moves to the
fork owner.

## Recommended candidate and ownership contract

### 1. Define protocol groups, not only independent files

The package manifest should declare every protocol-critical group and its
members, for example:

```text
readiness protocol
  core registry:       kit-owned
  runtime harness:     kit-owned
  skill preflights:    kit-owned
  consumer overlay:    consumer-owned structured data
  validator/migrators: kit-owned
```

The candidate is valid only if every group is coherent as a whole. A
consumer-owned member can therefore no longer make validation disappear.

### 2. Keep upstream protocol core unownable under its canonical identity

`own` should refuse a protocol-core path and point to the supported overlay or
fork route. Existing owned core paths are legacy states to migrate, not states
to perpetuate. This narrows ADR 0001 rather than weakening it: ordinary
consumer-owned files remain immutable and skipped; protocol core is no longer
an eligible ownership unit.

### 3. Compose and validate before activation

For every update, materialize the complete intended kit end state, load and
upgrade the consumer overlay, compose both, and run protocol-specific
invariants. Activation remains all-or-nothing. A bad overlay blocks the
protocol group with a targeted diagnostic; it never causes the updater to
overwrite local data or to activate a mixed-version group.

Collision rules should be structural:

- a consumer may add records only in its declared namespace;
- a consumer record that collides with a core identity is rejected unless the
  schema explicitly defines a non-overriding augmentation;
- consumer values cannot replace core executable references or protocol
  versions;
- dangling references and unsupported overlay versions block activation; and
- ownership transfer is an explicit user decision, never a `--yes` default.

### 4. Migrate the legacy mixed file once

For the existing combined registry, the staged candidate should retain three
inputs: the last installed upstream base, the live consumer file, and the new
upstream core. Migration should semantically classify records rather than
blindly line-merge JSON:

1. identify records unchanged from the recorded upstream base;
2. extract clearly consumer-only records and allowed local policy into the new
   overlay;
3. install the complete new upstream core;
4. compose and validate the result; and
5. preview the extraction, backups, ownership changes, and any ambiguous rows.

If provenance is ambiguous—for example, a consumer modified an upstream record
instead of adding a namespaced one—the update stops at a user gate. The user
chooses to port the change upstream, express it through a supported overlay
field, or create a real fork. A raw three-way merge may help produce the review
diff, but it must not decide semantic ownership.

### 5. Version, negotiate, deprecate, then remove

The protocol core and overlay schema need independent explicit versions and a
supported compatibility matrix. Rollout follows the Kubernetes/Terraform
pattern:

1. ship readers and validators for both the legacy combined representation and
   the new split representation;
2. ship the idempotent migration and preview it in the candidate;
3. activate core plus overlay only after full validation;
4. report a fresh adoption count (`X of Y` consumers or known legacy states),
   not an assumed completion;
5. stop creating legacy state and make old-state diagnostics actionable; then
6. remove the legacy reader only after all supported prior states have a
   migration path and known consumers have migrated.

Without remote telemetry, the evidence is local manifest/schema state plus
consumer update/CI results. The kit should therefore use a release-bounded
support window and a deterministic audit command, not claim global adoption.

## Proposed rollout for issues #196/#197

1. **Inventory and classify.** Derive all protocol-critical groups from shipped
   executable references and manifests. Count every member and mark it core,
   overlay, generated evidence, or independent file.
2. **Add validation before enforcement.** Build the kit-only candidate and
   protocol-group validator. Initially report legacy mixed ownership and prove
   that a #196-style harness/registry mismatch is rejected.
3. **Introduce the split readiness registry.** Ship an upstream-owned core
   registry plus a consumer-owned extension overlay. The runtime reads the
   composed view; new consumers start split.
4. **Adopt existing consumers transactionally.** Extract Testreporter's 15
   consumer-only skill records and local policy into the overlay, install the
   current core, validate all core and local records, and change ownership only
   as part of the verified candidate activation. Preserve a backup/recovery
   receipt.
5. **Guard the seam.** Reject future `own` operations on protocol-core paths;
   point users to the overlay for data extensions or to a separately named
   package/path for executable forks.
6. **Sunset the combined format.** Keep the legacy reader for a declared
   compatibility window, count locally known adoptions, then remove it in a
   release that explicitly declares the minimum supported overlay/core schema.

## Rejected rollout shapes

- **Silently overwrite the owned file:** destroys legitimate local behavior
  and violates the existing consumer contract.
- **Keep skipping it forever:** preserves bytes but starves the protocol and
  recreates #196 on every coupled evolution.
- **Automatically disown it:** turns an ownership decision into an implicit
  destructive migration.
- **Blind three-way merge on every update:** reduces conflicts but leaves a
  mixed authority and cannot validate semantic record identity.
- **Field ownership for arbitrary code:** line/AST ownership is not a stable
  extension API; local executable changes need an explicit fork.
- **Fork the whole protocol for local records:** imposes permanent merge and
  security-update work where a narrow data overlay is sufficient.

## Decision implication

The current definition “owning a path means forgoing all future kit
improvements to it” remains valid for genuine independent forks. It should no
longer be offered for canonical protocol-core paths. For those paths, the
supported local customization mechanism is a versioned consumer overlay; the
honest alternative is a separately identified and maintained code fork.
