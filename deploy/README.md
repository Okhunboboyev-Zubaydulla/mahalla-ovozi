# Production Deployment & VPS Operations

This document describes the production deployment topology and operational commands for Mahalla Ovozi on the Airnet.uz VPS.

## Host Details

- **Host Alias:** `airnet-vps` (or `mahalla-vps`) defined in local `~/.ssh/config`
- **Provider & Location:** Airnet.uz (BKM data center, Tashkent, Uzbekistan)
- **Operating System:** Ubuntu 24.04 LTS
- **Network:** Direct TAS-IX / UZ-IX network peering
- **Remote Project Directory:** `/opt/mahalla-ovozi`

## Authentication & Access

Access is strictly passwordless via SSH key authentication configured in your local machine's `~/.ssh/config`:

```ssh-config
Host airnet-vps mahalla-vps
    HostName 95.182.118.3
    User ubuntu
    IdentityFile ~/.ssh/id_vps_deploy
    StrictHostKeyChecking accept-new
```

Zero passwords or private keys are stored in the repository.

## Operational Runbook

All commands can be executed directly from your local terminal or by an AI agent:

### 1. Check Container Status
```bash
ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose ps"
```
Or run via npm script:
```bash
pnpm vps:status
```

### 2. View Service Logs
```bash
# View recent logs across all services
ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose logs --tail=100"

# Follow backend logs live
ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose logs -f --tail=100 backend"
```
Or run via npm script:
```bash
pnpm vps:logs
```

### 3. Restart Services
```bash
ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose restart"
```

### 4. Deploy Updates
```bash
# Pull new images and restart containers with zero downtime
ssh airnet-vps "cd /opt/mahalla-ovozi && docker compose pull && docker compose up -d"
```

### 5. Check Host Resources & Disk
```bash
ssh airnet-vps "free -m && df -h"
```
