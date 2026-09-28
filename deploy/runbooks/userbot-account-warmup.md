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

## 4. Verification Checklist Before Switching Transport

Before switching any group to `USERBOT` in the Mahalla Ovozi console or database:

- [ ] SIM card has been active for ≥ 30 days on a physical carrier.
- [ ] Profile photo, full name, username, and bio are completely configured.
- [ ] Two-step verification (2FA) cloud password is enabled.
- [ ] Account was admitted to the target group by a human (admin, resident, or invite link).
- [ ] Account has resided in the target group for ≥ 24 hours without restriction.
- [ ] Session has been authenticated and encrypted via the VPS CLI:
  ```bash
  ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose run --rm backend pnpm userbot:login --district-id <DISTRICT_ID>"
  ```
- [ ] District userbot session is verified in `ACTIVE` status:
  ```bash
  # Verify status in database or console
  pnpm vps:status
  ```

---

## 5. Abnormal Signal Response

If the account encounters any abnormal signal:
- `FLOOD_WAIT_X`: System honors sleep duration and retries once. Do not attempt manual actions or repeated CLI logins during this window.
- `PEER_FLOOD` or account restrictions: Halt joining additional groups for 7 days.
- `PHONE_NUMBER_BANNED`: Follow the disaster recovery runbook to procure a replacement SIM and re-authenticate via CLI.
