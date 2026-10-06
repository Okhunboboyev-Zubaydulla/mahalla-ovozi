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

---

## Amendment — 2026-10-05 (Userbot Transport Repair)

During the October 2026 operational hardening and transport repair milestones, several runtime mechanisms and operational truths were updated to reflect production realities:

### 1. Library Successor: Migration from GramJS to `teleproto`
On 2025-02-12, the original `telegram` (GramJS) library was archived and its entire version line deprecated by its maintainers. The platform has migrated to `teleproto`, an actively maintained, drop-in compatible successor supporting modern MTProto schema layers, active security patches, and Node.js 24 compatibility.

### 2. Strengthened Hexagonal Isolation
Hexagonal isolation of MTProto dependencies has been significantly strengthened across architectural boundaries:
- **Port Invariant:** MTProto operations remain strictly encapsulated behind `UserbotClientPort`, with dynamic module loading consolidated into the lazy loader `loadTelegramLibrary()`.
- **Image Segregation:** `teleproto` has been stripped completely from the production HTTP API (`runner` target) and background worker images. Only the dedicated `userbot-runner` container image retains `teleproto` dependencies. The main API and worker processes never load or link MTProto binaries into memory.

### 3. Server-Side Revocation & Kill Switch Semantics
The kill switch (`POST /api/v1/districts/:districtId/userbot-session/disable`) has been upgraded from a passive local disconnect to active server-side revocation:
- Setting status to `DISABLED` performs server-side revocation through an injected session revoker (`resolvedRevoker`, defaulting to `defaultTelegramSessionRevoker`). The default implementation loads the MTProto library, constructs a client from the stored session string and calls `client.logOut()`, invalidating the session authorization key directly on Telegram's infrastructure. A client exposing no `logOut` method, an unloadable MTProto library, or an already-revoked session degrades to a local-only disable rather than failing the transition.
- The stored session ciphertext blobs (`session_encrypted`, `session_iv`, `session_tag`) are permanently wiped from the database. The API credential envelope (`api_hash_encrypted`, `api_hash_iv`, `api_hash_tag`) is deliberately preserved so the District can be re-authenticated without re-procuring the Telegram application credentials.
- Re-enabling a previously disabled session transitions status to `PENDING` (not `ACTIVE`) because revocation permanently destroyed authorization keys; resuming transport requires fresh interactive authentication via the VPS CLI.

### 4. Banned Account Recovery Reality
Technical code changes or retry loops cannot re-authenticate or restore a `BANNED` Telegram account; Telegram's servers permanently reject authentication requests for banned phone numbers. Bootstrap attempts against `BANNED` sessions are actively rejected by the API. Operational recovery strictly requires:
1. Procuring a brand new physical SIM card (aged ≥ 30 days).
2. Provisioning a new session record in the platform.
3. Authenticating the new phone number via the interactive CLI bootstrap script.

### 5. Resolution Status of Reference `AD-11`
The reference in the initial decision record to `AD-11 (Disaster Recovery & Deletion Reconciliation)` is **unresolved and pending future formalization**; no standalone architectural decision record numbered `AD-11` exists in the repository. Instead, privacy safeguards and district lifecycle teardown are operatively governed by PostgreSQL foreign-key cascade deletion (`district_telegram_userbot_sessions.district_id` referencing `districts.id ON DELETE CASCADE`), which immediately purges userbot sessions and cryptographic material upon district deletion.

### 6. Preservation of Accepted Product Risks
All original accepted product-level risks remain in full effect and unmodified:
- **Telegram ToS §1.5 (AI-Use Prohibition):** Accepted in writing by client.
- **Telegram ToS §1.4 (Read-Status and Ghost Mode):** Accepted in writing by client.
- **Telegram Account Ban Probability:** Acknowledged as inevitable over time; mitigated by containment and operational alarming rather than technical prevention.
- **Citizen Consent Exposure:** Ingestion of community conversations accepted in writing by client.

