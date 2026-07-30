<!-- setup-workflow: state=filled -->
# Code-review project layer

## Standards sources in this repo

- `CLAUDE.md` and `AGENTS.md`
- `docs/conventions/`
- The originating issue or PRD for the Spec axis

The Standards axis applies the **excess criterion** to every mechanism the diff
keeps or adds. It is defined once in `docs/conventions/spec-completeness.md`
§Excess — read it there; do not restate it in a reviewer prompt.

## Adjacent review tooling

- `spec-self-critique` reviews plans before code exists; it does not replace diff review.
- Security audits and simplification passes remain narrower complementary checks.

