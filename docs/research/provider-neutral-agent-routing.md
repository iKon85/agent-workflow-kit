# Provider-neutral agent routing for shared work items

**Researched:** 2026-07-22  
**Question:** How should shared agent-workflow issues express model-routing intent across Claude Code and OpenAI Codex without embedding short-lived provider model names?

## Recommendation

Persist **task intent, not a model selection**, in shared issues. Use two small,
provider-neutral fields:

```yaml
routing-intent: judgment | development | mechanical
reasoning-intent: deep | balanced | light
```

The exact vocabulary is a Kit domain decision; the important constraint is that
the values describe the work and desired trade-off, not Anthropic or OpenAI
products. A surface-local resolver maps those values at dispatch time:

```text
shared issue intent
        |
        +-- Claude resolver -> current Claude alias/model + session effort
        |
        `-- Codex resolver  -> current Codex model + model_reasoning_effort
```

The default resolution must be `inherit` when no local policy exists or when a
configured target cannot be proven usable. The orchestrator should report the
effective resolution at session start, but it should not write that volatile
result back into the issue.

This separates three ownership layers:

1. **Kit-owned schema and validation:** allowed intent values, inheritance,
   diagnostics, and dispatch contract.
2. **User/organization-owned surface policy:** how intent maps to models and
   effort for that account, budget, provider, and current catalog.
3. **Project-owned constraints, only when genuinely shared:** for example, a
   prohibition on a model or a minimum capability required by every
   collaborator. A project should not carry one maintainer's preferred model
   mapping.

## Verified platform facts

### Claude Code

Claude Code has Managed, User, Project, and Local scopes. For ordinary scalar
settings, precedence is Managed, command-line, Local, Project, then User. A
committed `.claude/settings.json` therefore affects all collaborators and
overrides their user settings, while `.claude/settings.local.json` is personal
and repository-specific ([Claude Code settings: scopes and precedence](https://code.claude.com/docs/en/settings#configuration-scopes)).

Claude accepts provider aliases as well as full model IDs. Aliases such as
`fable` and `sonnet` resolve to current models, while `default` returns to the
runtime default for the account or organization. Aliases reduce version churn,
but remain Claude-specific and do not encode a cross-provider task class
([Claude Code model aliases](https://code.claude.com/docs/en/model-config#model-aliases)).

The main-session model can be changed for a session with `/model` or at launch
with `--model`; `ANTHROPIC_MODEL` and the persistent `model` setting are also
supported. Organization restrictions and managed settings can replace or
reject a requested selection, so a repository cannot assume that a named model
is usable for every collaborator ([Claude Code model selection](https://code.claude.com/docs/en/model-config#setting-your-model),
[Claude Code model restrictions](https://code.claude.com/docs/en/model-config#restrict-model-selection)).

Claude subagent definitions support an alias, a full ID, or `inherit`; omission
means `inherit`. Resolution currently considers
`CLAUDE_CODE_SUBAGENT_MODEL`, a per-invocation value, subagent frontmatter, and
finally the main conversation model. Excluded selections fall back to the
inherited model. Extended-thinking configuration is inherited from the main
conversation and has no per-subagent setting
([Claude Code subagent model resolution](https://code.claude.com/docs/en/sub-agents#choose-a-model)).

Claude effort levels are model-dependent. Unsupported levels are reduced to a
supported level, organization policy can cap them, and some effort choices are
session-only. Skill and subagent frontmatter can override the inherited session
effort, subject to higher-precedence environment and organization constraints.
Therefore a provider-neutral reasoning intent can be resolved on Claude, but a
shared issue must not claim that one literal effort value has identical
enforcement everywhere
([Claude Code effort levels](https://code.claude.com/docs/en/model-config#adjust-effort-level),
[Claude Code subagent effort](https://code.claude.com/docs/en/sub-agents#supported-frontmatter-fields)).

Anthropic exposes `GET /v1/models`, whose result describes models available to
that API credential ([Anthropic Models API](https://platform.claude.com/docs/en/api/models/list)).
That is not a universal Claude Code discovery contract: Claude Code may run
through a Claude subscription, Bedrock, Vertex, Foundry, or a gateway. Gateway
discovery is optional, limited to compatible `/v1/models` gateways, cached,
and falls back to built-in entries if discovery fails
([Claude Code gateway model discovery](https://code.claude.com/docs/en/llm-gateway#model-selection)).

### OpenAI Codex

Codex reads personal defaults from `~/.codex/config.toml` and project overrides
from trusted `.codex/config.toml` files. Its documented precedence is CLI,
project config, selected user profile, user config, system config, then built-in
defaults. Consequently, a committed project routing table can override a
collaborator's personal defaults; untrusted projects skip project-local layers
entirely ([Codex configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic#configuration-precedence)).

Codex exposes `model` and `model_reasoning_effort` as separate configuration
values ([Codex common configuration options](https://learn.chatgpt.com/docs/config-file/config-basic#common-configuration-options)).
For custom subagents, a custom-agent file may override both. Otherwise each is
resolved independently from an explicit spawn value, the `[agents]` default,
and the parent session. Omitting a setting inherits it; changing the model
without an explicit effort uses the selected model's default effort
([Codex custom-agent resolution](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)).

Official Codex guidance explicitly allows leaving both values unpinned so the
runtime can balance capability, speed, and price. It also documents that
available reasoning levels depend on the selected model
([Codex choosing models and reasoning](https://learn.chatgpt.com/docs/agent-configuration/subagents#choosing-models-and-reasoning)).

OpenAI exposes `GET /v1/models` for models available to an API key
([OpenAI Models API](https://platform.openai.com/docs/api-reference/models/list)).
The Codex documentation does not provide a stable, public model-discovery API
for the effective catalog of every Codex/ChatGPT account and local client.
An API-key catalog therefore cannot safely populate routing for users whose
Codex authentication, plan, organization policy, or client surface differs.

## Options compared

| Option | Survives catalog changes | Works across Claude and Codex | Multi-user behavior | Offline/update behavior | Verdict |
|---|---:|---:|---|---|---|
| Concrete model names in issues | No. Every rename, replacement, or access change makes existing issues stale. | No. Names and effort controls are provider-specific. | Assumes every collaborator has the same entitlement and budget. | Old issues remain wrong until rewritten. | Reject. Suitable only for an explicit reproducibility pin in a provider-specific experiment. |
| Stable task intent resolved by user/org surface policy | Yes. Existing issues survive mapping changes. | Yes. Each surface resolves independently or inherits. | Preserves personal and organization choices. | Cached/local policy continues to work; unknown targets can inherit and warn. | **Adopt.** |
| Project-local concrete routing table | Partly. One table can be updated, but every checkout still receives volatile provider data. | Only by maintaining multiple provider sections. | Project config outranks user config on both surfaces, so the maintainer's preferences can override collaborators. | Fresh clones can start stale; offline discovery cannot repair it. | Reject as the default. Permit only explicit team policy/constraints. |

## Setup and update implications

### `setup-workflow`

`setup-workflow` should install or reconcile only the Kit-owned intent schema,
templates, validation, and a documented inheritance fallback. It may **offer**
to create a user-local routing policy for the detected surface, but only with
explicit consent and never as a committed project default.

Setup must not attempt to infer a complete routing table from `/v1/models`:

- API discovery requires credentials and network access.
- API availability is not equivalent to Claude Code or Codex subscription
  availability across all supported providers and account types.
- A discovered model ID says nothing about the user's desired cost/capability
  trade-off.

An interactive setup may validate explicitly selected targets using the active
surface and show a preview. Failure or absence of discovery should leave the
policy at `inherit`, not install guessed names.

### `kit-update`

`kit-update` should update the Kit-owned schema, resolver implementation, and
provider adapter capabilities transactionally. It must preserve user-owned
mappings and project-owned constraints. If the schema changes, migration must
be semantic (for example, rename an intent key), previewed, and reversible;
ordinary updates must not rewrite historical issues or replace personal model
choices.

At dispatch, the resolver should:

1. read the issue's stable intent;
2. apply organization/user policy and explicit session overrides according to
   the active surface;
3. resolve or inherit without network-dependent mutation;
4. reject a malformed intent, but fall back to `inherit` with a visible warning
   when a volatile target is unavailable;
5. record the effective model and effort in run evidence, not in the durable
   issue contract.

This lets a later Kit release improve mappings for users who accept Kit
defaults while allowing a maintainer's user-local policy to evolve independently.

## Implication for #213

#213 should not hardcode `sol`, `terra`, `luna`, Claude aliases, or full model
IDs into the issue template or validator. It should instead establish the
provider-neutral intent schema and make `to-issues` emit that schema. The
execute-ready check should reject concrete provider model recommendations in
shared handoffs, while orchestration resolves the intent on the active surface.

The existing free-text `Recommended model: <Model [Effort]>` field conflates a
durable work classification with a volatile local decision. Replace it with
machine-readable intent and render the effective local recommendation only
when a session is actually dispatched.

## Open risks and decisions

1. **Vocabulary quality:** `judgment/development/mechanical` and
   `deep/balanced/light` need task-based definitions and contract tests so they
   do not become disguised provider tiers.
2. **Enforcement asymmetry:** Both surfaces can override model and effort for
   subagents, but their precedence, supported values, organization controls,
   and fallback behavior differ. The Kit must promise intent resolution, not
   identical low-level enforcement.
3. **Unavailable targets:** silent substitution hides policy drift. Inheritance
   should be visible in run evidence, and strict team policies may choose to
   fail instead.
4. **Organization policy:** managed restrictions outrank personal/project
   wishes. The resolver must treat the surface's effective selection as
   authoritative.
5. **Reproducibility exception:** a benchmark or regression reproduction may
   legitimately pin a provider/model snapshot. That is a distinct,
   provider-specific execution constraint, not the normal issue-routing field.
6. **No universal discovery source:** model catalogs are useful validation
   inputs where available, but cannot be the SSOT for setup or updates across
   all supported account types and providers.
