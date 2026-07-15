# Domain language

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
