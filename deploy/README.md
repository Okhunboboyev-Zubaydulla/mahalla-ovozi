# Production Deployment & VPS Operations

This document is the operational reference for the production deployment topology and the day-to-day operational commands for **Mahalla Ovozi** running on the Airnet.uz VPS. It covers host access, the deploy pipeline, manual database migrations, rollback, and database backups.

---

## Host Details

- **Host alias:** `airnet-vps` (also reachable as `mahalla-vps`)
- **Provider & Location:** Airnet.uz — BKM data center, Tashkent, Uzbekistan
- **OS:** Ubuntu 24.04 LTS
- **Network:** direct TAS-IX / UZ-IX peering
- **Remote project directory:** `/opt/mahalla-ovozi`

---

## Authentication & Access

Access is passwordless over SSH using a deploy key configured in the local `~/.ssh/config`. The relevant block is:

```ssh-config
Host airnet-vps mahalla-vps
    HostName 95.182.118.3
    User ubuntu
    IdentityFile ~/.ssh/id_vps_deploy
    StrictHostKeyChecking accept-new
```

No passwords and no private keys are stored in the repository. The deploy key lives only on the operator's workstation.

---

## Critical: always pass the compose file

The production stack is defined in `deploy/compose/docker-compose.prod.yml`. However, the **repository root also contains a `docker-compose.yml`** describing the *local development* environment (Postgres only). Docker Compose resolves a compose file by walking up from the current working directory, so a bare `docker compose` command run inside `/opt/mahalla-ovozi` resolves that local-dev file — the **wrong project**. The command can exit successfully and report healthy containers while doing nothing at all to production.

Therefore **every** production compose command must carry `-f deploy/compose/docker-compose.prod.yml`.

```bash
ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose -f deploy/compose/docker-compose.prod.yml <subcommand>"
```

The deployed compose project name is `compose` (read from the `com.docker.compose.project` container label), which is why built images are named `compose-backend`, `compose-worker`, `compose-userbot`, and `compose-caddy`.

---

## Operational Runbook

### 1. Check Container Status

```bash
ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose -f deploy/compose/docker-compose.prod.yml ps"
```

Or via the npm script `pnpm vps:status`.

Expected services and their container names:

| Service | Container |
| --- | --- |
| postgres | `mahalla-postgres` |
| backend | `mahalla-backend` |
| worker | `mahalla-worker` |
| userbot | `mahalla-userbot` |
| caddy | `mahalla-caddy` |

Volumes: `postgres_data` (postgres), `caddy_data` and `caddy_config` (caddy). Network: `mahalla-net`.

### 2. View Service Logs

Tail all services, last 100 lines each, following:

```bash
ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose -f deploy/compose/docker-compose.prod.yml logs -f --tail=100"
```

Follow one named service (example: backend):

```bash
ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose -f deploy/compose/docker-compose.prod.yml logs -f --tail=100 backend"
```

Or via the npm script `pnpm vps:logs`.

### 3. Restart Services

```bash
ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose -f deploy/compose/docker-compose.prod.yml restart"
```

A restart does **not** apply migrations and does **not** rebuild images.

### 4. Deploy Updates

This is a **build-based** deploy, not a pull-based one. Images are built **on the VPS** from the source checked out in `/opt/mahalla-ovozi`; there is no registry pull step. The web SPA is compiled in the Dockerfile `builder` stage and copied into the caddy image (`COPY --from=builder /app/apps/web/dist /srv/web`). Consequently, **a frontend change only ships when the caddy image is rebuilt.**

1. Confirm the VPS checkout is at the intended commit:

   ```bash
   ssh airnet-vps "cd /opt/mahalla-ovozi && git rev-parse HEAD"
   ```

2. Pull / check out the intended commit on the VPS.
3. Build **all** services, **including caddy**:

   ```bash
   ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose -f deploy/compose/docker-compose.prod.yml build"
   ```

4. Apply migrations **manually** (see section 5). They do **not** run automatically.
5. Bring the stack up:

   ```bash
   ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose -f deploy/compose/docker-compose.prod.yml up -d"
   ```

6. Verify with `ps` and `logs` (sections 1 and 2).

> **Warning:** a bare `docker compose build` without `-f deploy/compose/docker-compose.prod.yml` builds the wrong thing — the local-dev definition at the repo root. It can appear to succeed while production images are left untouched.

### 5. Database Migrations (MANUAL)

Migrations are **never** applied automatically. Nothing in `apps/backend/src/entrypoints` calls the migration runner, so neither a deploy nor a container restart applies them. Run them explicitly:

```bash
ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose -f deploy/compose/docker-compose.prod.yml run --rm --no-deps backend pnpm --filter @mahalla-ovozi/backend db:migrate"
```

The current known applied migration count is **35**. Verify it with:

```bash
docker exec mahalla-postgres psql -U mahalla_user -d mahalla_ovozi -tAc 'select count(*) from drizzle.__drizzle_migrations;'
```

The migration runner takes an advisory lock, so a concurrent runner is safe — a second invocation waits rather than double-applying.

### 6. Rollback

Rollback means re-tagging the previous known-good images and bringing the stack up on them.

The **schema is deliberately left in place.** The recent pause-feature migrations were additive (`ADD COLUMN ... DEFAULT`), and the older code simply ignores the new columns. Rolling back the code therefore needs no schema reversal and loses no data.

Known rollback tags on the host:

- `compose-backend:pre-pause`
- `compose-worker:pre-pause`
- `compose-userbot:pre-pause`
- `compose-caddy:pre-pause`
- `compose-caddy:pre-ui-rebuild`

Re-tag recipe (repeat per service being rolled back — backend, worker, userbot, caddy):

```bash
# backend
ssh airnet-vps "docker tag compose-backend:pre-pause compose-backend:latest"
# worker
ssh airnet-vps "docker tag compose-worker:pre-pause compose-worker:latest"
# userbot
ssh airnet-vps "docker tag compose-userbot:pre-pause compose-userbot:latest"
# caddy (use :pre-ui-rebuild to undo only the last frontend rebuild)
ssh airnet-vps "docker tag compose-caddy:pre-pause compose-caddy:latest"
```

Then bring the stack up so the re-tagged images are used:

```bash
ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose -f deploy/compose/docker-compose.prod.yml up -d"
```

**Universal fallback:** if no suitable tag exists, check out the previous commit on the VPS, rebuild all services (section 4), and bring the stack up with the `-f` form above.

### 7. Database Backups

The backup mechanism is installed and proven on the host:

- **Script:** `/opt/mahalla-backup/backup-db.sh` (owner `ubuntu:ubuntu`, mode `750`)
- **Behaviour:** runs `pg_dump` inside the `mahalla-postgres` container, gzips the output, writes a timestamped file into `/opt/mahalla-backup/dumps/`, appends a line to `/opt/mahalla-backup/backup.log`, and prunes dumps older than 14 days.
- **Cron entry:** `15 3 * * * /bin/bash /opt/mahalla-backup/backup-db.sh`
- A produced dump has been **verified restorable** into a scratch database.

Run a backup by hand:

```bash
ssh airnet-vps "/bin/bash /opt/mahalla-backup/backup-db.sh"
```

List existing dumps:

```bash
ssh airnet-vps "ls -lh /opt/mahalla-backup/dumps/"
```

> **Known limitation:** dumps live on the **same host** as the database. This protects against operator mistakes, bad migrations and application bugs — it does **not** protect against losing the VPS. There is no offsite copy and no point-in-time recovery (`archive_mode` is off). Offsite backup remains an **outstanding gap**.

Safe restore rehearsal — creates a throwaway database and drops it afterwards:

```bash
# 1. drop any leftover scratch database, then create a fresh one (safe to re-run)
ssh airnet-vps "docker exec mahalla-postgres psql -U mahalla_user -d postgres -c 'drop database if exists restore_rehearsal;'"
ssh airnet-vps "docker exec mahalla-postgres psql -U mahalla_user -d postgres -c 'create database restore_rehearsal;'"

# 2. restore the newest dump into it
ssh airnet-vps "gunzip -c \$(ls -t /opt/mahalla-backup/dumps/*.sql.gz | head -1) | docker exec -i mahalla-postgres psql -U mahalla_user -d restore_rehearsal"

# 3. sanity-check, then drop the scratch database
ssh airnet-vps "docker exec mahalla-postgres psql -U mahalla_user -d postgres -c 'drop database restore_rehearsal;'"
```

> **DANGER:** never restore over the live `mahalla_ovozi` database. Always restore into a throwaway database first.

### 8. Check Host Resources & Disk

```bash
ssh airnet-vps "free -m && df -h"
```

Docker storage usage:

```bash
ssh airnet-vps "docker system df"
```

The Docker build cache can be reclaimed with `docker builder prune`; it currently holds roughly **23 GB** reclaimable.

> **Warning:** `docker builder prune` **deletes the entire Docker build cache**, so the next build-based deploy will be **substantially slower** — every layer must be rebuilt from scratch. Only run it when disk space is genuinely needed.

---

## Troubleshooting

- **Confirm you are on the right compose project:** every production command must include `-f deploy/compose/docker-compose.prod.yml`. Without it you are likely addressing the local-dev project.
- **Symptom of the wrong project:** the command exits 0, containers look healthy, but nothing in production changes.
- **Check the deployed commit:** `ssh airnet-vps "cd /opt/mahalla-ovozi && git rev-parse HEAD"`.
- **Tail a service's logs:** `ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose -f deploy/compose/docker-compose.prod.yml logs -f --tail=100 backend"`.
- **A frontend change did not appear:** the caddy image was not rebuilt — the SPA is baked in at build time (section 4).
