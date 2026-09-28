---
status: accepted
date: 2026-08-12
---

# Stateful Database Sessions over Stateless JWT

User authentication for both the Product Owner Console and District Hokim dashboards uses database-backed stateful session tokens stored in secure, `httpOnly`, `SameSite=Lax` cookies.

## Considered Options

- **Stateless JSON Web Tokens (JWT):** Rejected because JWTs cannot be revoked instantly without implementing a token blacklist (which turns JWT back into a stateful system). If a District subscription lapses or is suspended, Hokim access must terminate immediately.
- **Third-Party Auth Providers (Clerk/Auth0/Supabase Auth):** Rejected due to external network dependency, recurring per-seat costs, vendor lock-in, and local data sovereignty requirements in Uzbekistan.

## Consequences

- Session creation, validation, and destruction are managed by our internal `auth` module and persisted in PostgreSQL.
- Changing a District lifecycle state to `Suspended` or `Cancelled` immediately purges or invalidates active sessions in the database, locking out unauthorized access with zero delay.
- Requires an indexed database read on authenticated requests, easily absorbed by PostgreSQL connection pooling.
