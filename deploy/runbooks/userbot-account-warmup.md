# Telegram Userbot Account Warm-Up Runbook

This runbook defines the mandatory account preparation and warm-up procedures for any Telegram user account intended for use with Mahalla Ovozi's `USERBOT` transport.

## Objective

Telegram's automated anti-spam and abuse detection systems aggressively flag and ban newly registered, incomplete, or rapidly joining accounts. To minimize the probability of permanent account bans, every District userbot account must complete this warm-up protocol before any Mahalla group is switched from `BOT_API` to `USERBOT`.

---

## 1. Prerequisites: Physical SIM Procurement & Aging

1. **Aged SIM Card Requirement:**
   - Procure a physical SIM card from a recognized cellular carrier in Uzbekistan (e.g., Ucell, Beeline, Mobiuz, UMS).
   - **Do NOT** use virtual, VoIP, burner, or temporary online SMS numbers. Telegram immediately flags virtual ranges.
   - The SIM card must be activated and aged for **at least 30 days** on a physical phone prior to registering or activating the Telegram account.

2. **Dedicated Device / Environment:**
   - Register the account using the official Telegram mobile app on a physical smartphone connected via local cellular data or residential Wi-Fi (Tashkent / local IP).
   - Do not register over data center proxies or VPNs.

---

## 2. Profile Setup & Humanization

The account must appear indistinguishable from an authentic resident:

1. **Identity & Name:**
   - Set a realistic first and last name in Uzbek (Latin or Cyrillic script), e.g., representing a community coordinator or neighborhood liaison.
   - Avoid automated-sounding names like `Mahalla Bot`, `Userbot`, `Intake Admin`, or `Monitor`.

2. **Avatar & Bio:**
   - Upload an authentic profile photo (e.g., clear neutral portrait).
   - Set a natural bio explaining presence (e.g., `Mahalla jamoat koordinatori`).
   - Configure a standard alphanumeric username (e.g., `@alisher_mahalla_uz`).

3. **Security Configuration (2FA):**
   - Enable Telegram **Two-Step Verification (2FA / Cloud Password)** in Settings > Privacy and Security.
   - Attach a monitored recovery email address.
   - Keep the password documented securely in the District password manager for interactive CLI login.

---

## 3. Warm-Up & Gradual Joining Protocol

Rushing into multiple groups triggers `PEER_FLOOD` or immediate account suspension. Follow this staged protocol:

### Phase A: Organic Activity (Days 1–3)
- Engage in a few ordinary 1-on-1 chats with known human contacts.
- Subscribe to 2–3 public broadcast news channels (e.g., official regional hokimiyat channels).
- Keep the account online periodically.

### Phase B: Gradual Group Joining (Day 4+)
- **One Group at a Time:** Join at most **one** target Mahalla Telegram group per 24–48 hours.
- **Human Admission Principle:**
  - Join via a legitimate public invite link, a member addition from a cooperative resident, or an addition by the group administrator.
  - **Never** use automated scrapers, scripts, or bulk invite tools.
- **Passive Settling Period:**
  - After being admitted to a group, allow the account to remain idle in the group for **at least 24 to 48 hours** before switching the group's transport in Mahalla Ovozi.
  - Do not post messages, mass-mention users, or interact abruptly.

---

## 4. Verification Checklist & Interactive Authentication

Before switching any group to `USERBOT` in the Mahalla Ovozi console or database:

- [ ] SIM card has been active for ≥ 30 days on a physical carrier.
- [ ] Profile photo, full name, username, and bio are completely configured.
- [ ] Two-step verification (2FA) cloud password is enabled.
- [ ] Account was admitted to the target group by a human (admin, resident, or invite link).
- [ ] Account has resided in the target group for ≥ 24 hours without restriction.
- [ ] Session has been authenticated and encrypted via the verified production VPS CLI command:
  ```bash
  ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose -f deploy/compose/docker-compose.prod.yml run --rm userbot pnpm --filter @mahalla-ovozi/backend cli:bootstrap-userbot --district-id <DISTRICT_ID>"
  ```
  > **Note on Execution Context:**
  > - **Explicit Compose File:** Must target `deploy/compose/docker-compose.prod.yml` explicitly because multiple compose files exist across development and production environments.
  > - **Service Container:** Must run inside the `userbot` service container (built from the `userbot-runner` Docker target) because MTProto client dependencies (`teleproto`) are intentionally stripped from `backend` and `worker` images for hexagonal isolation.
  > - **Verified Script:** Invokes the verified script `cli:bootstrap-userbot` (defined in `@mahalla-ovozi/backend` package.json) to handle interactive phone code and 2FA cloud password authentication.

- [ ] Stack health and District userbot session are verified:
  ```bash
  # Check overall VPS container status:
  pnpm vps:status
  ```
  > **Note on Status Checks:** `pnpm vps:status` (verified in repository root `package.json`) confirms that Docker containers (`mahalla-postgres`, `mahalla-backend`, `mahalla-worker`, `mahalla-userbot`, `mahalla-caddy`) are healthy and running. District userbot session state (`ACTIVE`) is verified via the HTTP API:
  > ```bash
  > GET /api/v1/districts/:districtId/userbot-session
  > ```
  > or through the Hokim / Product Owner management console.

---

## 5. Disable & Kill-Switch Semantics (Server-Side Revocation)

When an operator or Product Owner triggers the kill switch or disables a userbot session (`POST /api/v1/districts/:districtId/userbot-session/disable`):

1. **Server-Side Session Revocation:** The system executes `client.logOut()` via MTProto to terminate the authorization session directly on Telegram's servers. This ensures the auth key cannot be reused or hijacked.
2. **Secret Envelope Erasure:** All cipher material in PostgreSQL (`session_encrypted`, `api_hash_encrypted`, `session_iv`, `session_tag`) is permanently wiped (`NULL`). Key version is preserved for audit trail integrity.
3. **Status Transition to `DISABLED`:** The session row transitions to `DISABLED`, and ingestion immediately halts.
4. **Re-Enabling Requires Re-Authentication (`PENDING`):**
   - Re-enabling a previously disabled session (`POST /api/v1/districts/:districtId/userbot-session/enable`) transitions status to `PENDING`, **not** `ACTIVE`.
   - Because credentials and auth keys were completely destroyed during revocation, the session cannot silently resume. The operator must execute the interactive CLI bootstrap command again with phone code and 2FA password to generate a fresh session.

---

## 6. Abnormal Signal Response & Ban Recovery

If the userbot encounters abnormal MTProto signals during operation:

- **`FLOOD_WAIT_X`:**
  - The runtime honors Telegram's sleep duration and retries once automatically.
  - **Second Consecutive Wait Halt:** If a **second consecutive wait** is encountered on retry, automatic retries are immediately halted to prevent hammering Telegram's servers and escalating anti-spam scrutiny.
  - **Operational Issue Alert:** The system raises a District-scoped Operational Issue (`Warning` / `Degraded`) for operator investigation. Do not attempt manual actions or repeated CLI logins during this backoff window.

- **`PEER_FLOOD` or Account Restrictions:**
  - Telegram anti-spam flags excessive joining or interactions. Halt joining additional groups for at least 7 days.

- **`PHONE_NUMBER_BANNED`:**
  - **Platform Reality:** When Telegram bans an account, the platform rejects all subsequent authentication attempts. Technical recovery cannot re-authenticate or revive a banned phone number, and bootstrap attempts against `BANNED` sessions are refused by the system.
  - **Recovery Protocol:**
    1. Procure a brand new physical SIM card from a local carrier (aged ≥30 days per Section 1).
    2. Configure profile and 2FA cloud password on a physical mobile device (Section 2).
    3. Register a new District session row via the console or API.
    4. Complete interactive authentication with the new phone number using the CLI bootstrap command.

