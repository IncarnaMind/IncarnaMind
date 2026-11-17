# Domain Docs

This repo has one context. Its domain docs are:

- **[`CONTEXT.md`](../../CONTEXT.md)** at the repo root: the glossary.
- **[`docs/adr/`](../adr/)**: the decisions. Read the ADRs that touch the area you're about to work in.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a proposal, a hypothesis, a test name), use the term as `CONTEXT.md` defines it, never a synonym it lists to avoid. If the concept you need isn't in the glossary, either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an ADR, say so explicitly rather than silently overriding it:

> _Contradicts ADR-0007 (answers via a tool-calling loop), but worth reopening because…_
