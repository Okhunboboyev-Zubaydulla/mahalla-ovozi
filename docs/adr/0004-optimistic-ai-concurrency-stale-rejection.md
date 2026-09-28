---
status: accepted
date: 2026-08-12
---

# Optimistic AI Concurrency and Stale Snapshot Rejection

When generating or refreshing a Topic summary, background workers snapshot the complete evidence set for that topic along with a deterministic fingerprint. If new Accepted Evidence arrives while the LLM is processing, the completed LLM result is rejected as stale, and processing is automatically re-enqueued with the new evidence snapshot.

## Considered Options

- **Pessimistic Ingestion Locking:** Rejected because locking the ingestion pipeline while waiting for multi-second LLM inference creates massive backlog and webhook timeouts.
- **Incremental LLM Diffing / Append-Merging:** Rejected because prompting LLMs with incremental patches produces contradictory summaries, lost context, and severe hallucinations compared to full verbatim context.

## Consequences

- Topic summaries are guaranteed to reflect 100% complete and consistent evidence snapshots, never partial or out-of-order data.
- Under high message bursts, multiple LLM completions may be discarded, consuming additional tokens. A 50-second debounce window and serialized topic queues are implemented to mitigate wasted inference.
