# Domain language

## Upstream route

The defined path by which a generic improvement discovered in a consumer
reaches the kit: the consumer raises it as a kit issue, the kit builds and
releases it, and the improvement returns to every consumer through a kit
update. Raising the issue is always a question put to the user, never an
automatic action.

## Consumer-owned path

An installed file a consumer has deliberately claimed as its own. The kit's
update process leaves it untouched in every direction: no overwrite, no
conflict report, no deletion prompt. Owning a path means forgoing all future
kit improvements to it.

## Clean shipped file

A kit-shipped file in a consumer that carries no project-specific content —
including no project issue references. Project-specific needs live in
consumer-owned paths or consumer-native files, never as edits to a clean
shipped file.

## Consumer-native behavior

A workflow capability that a consumer project established locally before the
kit offered an equivalent capability.

## Generalized kit behavior

A consumer-neutral form of a proven consumer-native behavior. It preserves the
outcome while leaving project-specific activation and policy choices with the
consumer.

## Behavioral parity

Evidence that a generalized kit behavior produces the same observable workflow
outcome as the consumer-native behavior it will replace. The consumer-native
behavior remains authoritative until parity is proven.

## Worktree lifecycle

The complete workflow for creating, identifying, enforcing, and cleaning up an
isolated worktree. Setup and enforcement are one capability even when different
agent hooks expose parts of it.

## Safety guardrail

An independently activatable rule that prevents or detects an unsafe agent or
repository action. Guardrails may share activation and reporting machinery,
but each retains its own applicability and failure policy.
