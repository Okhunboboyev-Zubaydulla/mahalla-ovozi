---
status: accepted
date: 2026-08-12
---

# PostgreSQL and pg-boss Transactional Intake

PostgreSQL is our single system of record, and `pg-boss` handles all background asynchronous job queuing using the same database. This allows Telegram webhook ingestion to persist raw incoming messages and enqueue processing jobs inside a single ACID database transaction.

## Considered Options

- **Redis + BullMQ:** Rejected because dual-write architectures introduce race conditions and edge cases where a database write succeeds but queue dispatch fails (or vice-versa) during network blips.
- **RabbitMQ / Kafka:** Rejected due to substantial operational overhead, lack of transactional enrollment with PostgreSQL, and unjustified complexity for our message volumes.

## Consequences

- No external queue brokers (Redis, RabbitMQ) are required in production or local environments.
- High ingestion bursts write directly to PostgreSQL tables without dual-write inconsistencies.
- Database CPU and connection limits must be monitored during peak load, as jobs share the PostgreSQL connection pool.
