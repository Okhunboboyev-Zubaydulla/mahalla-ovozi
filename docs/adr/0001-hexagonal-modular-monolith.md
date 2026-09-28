---
status: accepted
date: 2026-08-12
---

# Hexagonal Modular Monolith

To support multi-district Telegram ingestion, AI analysis, and executive dashboard reporting without high operational overhead, the backend is organized as a single modular monolith where domain modules depend strictly on ports, with external infrastructure isolated in adapters.

## Considered Options

- **Microservices:** Rejected due to excessive deployment, networking, and distributed-tracing overhead for a solo founder and MVP phase.
- **Traditional Layered (MVC):** Rejected because controllers, services, and models frequently bleed database and third-party SDK dependencies into core business logic.

## Consequences

- The backend entrypoints (`http.ts` and `worker.ts`) run from the same codebase image while operating independent processes.
- Domain modules in `apps/backend/src/modules/` own their business logic and interact with external systems (database, queues, AI, Telegram) via interfaces defined in `adapters/`.
- Cross-module boundaries require clear domain service calls rather than arbitrary database joins.
