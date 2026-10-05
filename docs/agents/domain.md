# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root: the canonical domain model and ubiquitous language for Mahalla Ovozi (District, Mahalla, Hokim, Product Owner, Accepted Evidence, Topic, Lane, Signal, Audit Record), plus the technical invariants and constraints.
- **`docs/adr/`**: read the ADRs that touch the area you're about to work in before changing it.

This is a **single-context** repo: there is no `CONTEXT-MAP.md` and no per-context `CONTEXT.md` under `src/`. Do not look for context-scoped ADR directories.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CONTEXT.md                        ← the single domain context
├── docs/adr/                         ← in-force architectural decisions
│   ├── 0001-hexagonal-modular-monolith.md
│   ├── 0002-postgresql-pgboss-transactional-intake.md
│   ├── 0003-same-day-calendar-boundary.md
│   ├── 0004-optimistic-ai-concurrency-stale-rejection.md
│   ├── 0005-provider-neutral-ai-gateway-immutable-profiles.md
│   ├── 0006-explicit-tenant-scoping-over-rls.md
│   ├── 0007-stateful-sessions-over-jwt.md
│   ├── 0008-single-host-compose-caddy-edge.md
│   ├── 0009-userbot-transport-abstraction-and-accepted-risks.md
│   └── 0010-retry-lifecycle-and-pending-flag-ownership.md
└── apps/                             ← backend and frontend packages
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0006 (explicit tenant scoping over RLS), but worth reopening because…_
