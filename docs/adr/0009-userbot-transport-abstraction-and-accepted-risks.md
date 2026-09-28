---
status: accepted
date: 2026-09-18
---

# Userbot Transport Abstraction and Accepted Risks

Mahalla Ovozi introduces an explicit per-Mahalla group transport abstraction supporting two transports: the default official Telegram Bot API (`BOT_API`) and an opt-in MTProto user account transport (`USERBOT`). Both transports converge into a single, unified transactional intake pipeline and deduplication mechanism.

In multiple Mahallas, local Telegram group administrators refuse to add official Telegram bots, or group members self-censor when an automated bot account is visibly present in the group. Consequently, Hokims experience critical situational awareness blind spots for those neighborhoods. To eliminate these blind spots without sacrificing architectural integrity or operational safety, the platform ingests civic signals from such groups via client-procured Telegram user accounts admitted as ordinary persons.

## Considered Options

- **Official Bot API Exclusively:** Rejected because refusing groups leaves blind spots that undermine Hokim situational awareness during municipal infrastructure crises.
- **Multi-District Shared Userbot Account:** Rejected because a Telegram ban on a shared account would simultaneously blind multiple Districts, violating the explicit District isolation principles established in ADR-0006.
- **Bespoke Ingestion Pipeline for Userbot:** Rejected because duplicating qualification, debouncing, deduplication, and topic clustering would introduce massive maintenance burden and synchronization defects, violating ADR-0001 and ADR-0002.

## Consequences

- **Unified Ingestion Core:** Both transports converge into the single transactional intake core (`withTransactionalIntake`) and write to `telegram_intake_records` with the immutable deduplication key `(district_id, telegram_chat_id, telegram_message_id)`. Downstream pg-boss queue dispatch and topic clustering pipelines remain completely transport-blind.
- **Hexagonal Isolation:** MTProto dependencies (GramJS) are strictly isolated inside the userbot adapter behind `UserbotClientPort`, conforming to ADR-0001. The port enforces a passive-only invariant (no write methods: no send, invite, react, or join).
- **Service Isolation:** The userbot runtime executes as a dedicated Docker Compose service (`userbot`), isolating MTProto socket lifecycles and memory from the Fastify HTTP API and worker runtimes.
- **Shared `api_id` Blast Radius Tradeoff:** While each District operates its own userbot account and phone number, if the client reuses a single Telegram application (`api_id` / `api_hash`) across multiple Districts, an application-level suspension or discontinuation by Telegram affects all Districts sharing that `api_id`. Full isolation requires distinct `api_id` credentials per District.
- **Accepted Product-Level Risk — Telegram ToS §1.5 (AI-Use Prohibition):** Telegram's Terms of Service §1.5 restricts utilizing Telegram data for AI training or automated AI-driven analysis without explicit agreement. This constraint applies to both `BOT_API` and `USERBOT` transports. The client explicitly accepts this product-level risk in writing.
- **Accepted Product-Level Risk — Telegram ToS §1.4 (Read-Status and Ghost Mode):** Operating an MTProto userbot without sending read acknowledgements ("ghost mode") creates tension with Telegram's client expectations and anti-abuse heuristics. The client explicitly accepts this product-level risk in writing.
- **Accepted Risk & Containment — Telegram Account Ban:**
  - *Risk:* Automating user accounts violates Telegram ToS and carries guaranteed ban probability over time. Written risk acceptance by the client is a governance requirement, not a technical mitigation.
  - *Containment:* Automated ban detection transitions session status to `BANNED`, immediately halts reconnection attempts, and raises a District-scoped Operational Issue alert without service disruption. Abnormal signals (`FLOOD_WAIT`, `PEER_FLOOD`, restrictions) raise warning alerts prior to banning.
  - *Recovery:* Technical code changes cannot recover a banned account. Recovery requires the client to procure a new physical SIM card, followed by interactive re-authentication via the VPS CLI.
  - *Kill Switch:* Product Owners can immediately set the session status to `DISABLED` via the console to halt MTProto consumption instantly.
- **Accepted Risk & Legal Exposure — Citizen Consent:** Ingesting community group discussions via a personal user account creates consent and legal exposure. The client accepts this in writing. Privacy safeguards and deletion reconciliation follow AD-11 (Disaster Recovery & Deletion Reconciliation).
