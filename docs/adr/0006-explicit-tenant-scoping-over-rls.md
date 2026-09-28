---
status: accepted
date: 2026-08-12
---

# Explicit Tenant Scoping over Row-Level Security

Multi-tenancy isolation between Districts is enforced explicitly at the application and repository layer: every District-scoped query, mutation, and background job must receive and validate an explicit `district_id` parameter. Missing scope is treated as a fatal error, never "all districts".

## Considered Options

- **PostgreSQL Row-Level Security (RLS):** Rejected for the MVP because RLS adds implicit session-variable dependencies (`SET LOCAL app.current_district`) that can leak across pooled database connections, complicates direct integration testing in Vitest, and obscures query execution paths.
- **Separate Database per District:** Rejected due to operational complexity of managing schema migrations, connections, and infrastructure across dozens of small municipal databases.

## Consequences

- All domain repository methods require an explicit `district_id: string` argument; omitting it produces a compile-time or runtime error.
- Multi-tenancy isolation tests can run deterministically against a shared PostgreSQL database (`mahalla_ovozi_test`) without mock connection switches.
- RLS can still be introduced later as a redundant defense-in-depth layer if required, without altering application logic.
