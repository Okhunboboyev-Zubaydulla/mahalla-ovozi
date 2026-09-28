---
status: accepted
date: 2026-08-12
---

# Single-Host Docker Compose Deployment with Caddy Edge

Production is deployed on a single dedicated Linux host using Docker Compose, hosted on a domestic VPS provider (Airnet.uz on Ubuntu 24.04 LTS at the BKM datacenter in Tashkent). Caddy 2.x serves as the public edge server handling automatic HTTPS, static SPA hosting, and API/webhook reverse proxying. Disaster recovery is **intended** to be managed via pgBackRest continuous WAL archiving to an offsite S3-compatible store. **As of 2026-09-24 that mechanism is not configured anywhere in this repository** — see the amendment at the end of this document.

## Considered Options

- **Kubernetes / Nomad Orchestration:** Rejected due to extreme infrastructure overhead, operational burden, and maintenance cost for a single-operator startup.
- **Foreign Serverless / Managed Cloud PaaS (Vercel/Fly.io/AWS ECS/Hetzner):** Rejected due to high egress costs, foreign currency dependencies, and strict local compliance/sovereignty requirements that mandate municipal resident data remain within Uzbekistan's national network perimeter (TAS-IX/UZ-IX).

## Consequences

- The entire stack (Caddy, Fastify API, worker runtime, PostgreSQL) is defined in a transparent `docker-compose.yml` and runs directly on the Ubuntu 24.04 Airnet.uz VPS with low domestic latency.
- Internal service ports (PostgreSQL, worker) remain private and unexposed to the public internet.
- Single-host downtime during host upgrades or hardware maintenance is an accepted MVP trade-off. The intended mitigation — scheduled pgBackRest restore drills at RPO ≤ 1h / RTO ≤ 8h — is **not yet in place**; see the amendment below.

---

## Amendment — 2026-09-24 (`L6-P01-01`)

The paragraph above describes an intended arrangement, not a built one. When the L6 review
assessed this ADR on 2026-09-24 it found **no part of the DR mechanism implemented in the
repository**:

- `deploy/compose/docker-compose.prod.yml` declares no `pgbackrest` service, and the
  `postgres` service sets no `command:` override carrying `wal_level`, `archive_mode` or
  `archive_command`.
- No offsite S3-compatible repository is configured.
- `deploy/backup/runbook.md` was rewritten in the same change to stop instructing operators
  to run the missing service.

This conflicts with the sovereignty constraint recorded under *Considered Options*: an
offsite S3-compatible store must itself sit inside the TAS-IX / UZ-IX perimeter.

**Status:** the architectural choice (single-host Compose, Caddy edge) stands and is
unchanged. Only the DR claim was false. Provisioning a backup transport is an **open
decision**, tracked as item 1 in `deploy/backup/runbook.md` §5 and as Phase 16/17 of
`docs/architecture-review/fix-ledger.md`. Do not read this ADR as evidence that backups
exist.
