# Deployment checklist

## Option A — VPS + Docker + HTTPS (recommended for BureauMovies storage)

You picked this. It keeps SQLite `data/` + `public/assets/movies/` on persistent Docker volumes so uploads survive restarts — Render free/ephemeral disks would wipe them.

Files added for you:
- `Dockerfile` (Node 22, `npm ci --omit=dev`, exposes 3000)
- `docker-compose.yml` (volumes `bureau-data` + `bureau-movies`, healthcheck on `/health`)
- `.env.production.example` (copy to `.env.production` on the VPS, never commit it)
- `Caddyfile.example` (HTTPS reverse proxy, 2GB upload body)
- `.dockerignore`

### VPS steps (Ubuntu 22.04/24.04, 2GB RAM+, enough disk for movies)

1. Point DNS `A your-domain.example -> VPS-IP`.
2. Install Docker + Caddy:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo apt install -y caddy
   ```
3. Copy project to VPS (without `.env`, `data/`, `node_modules/`, videos):
   ```bash
   rsync -av --exclude node_modules --exclude data --exclude .env --exclude 'public/assets/movies/*' ./ user@VPS:/opt/bureau-portal/
   ```
4. On VPS create production env:
   ```bash
   cd /opt/bureau-portal
   cp .env.production.example .env.production
   nano .env.production
   # set ADMIN_EMAIL, 12+ char ADMIN_PASSWORD, CORS_ORIGIN=https://your-domain.example,
   # MOMO_CALLBACK_URL=https://your-domain.example/api/payment/callback, MOMO_CALLBACK_SECRET, MoMo keys
   ```
5. Launch:
   ```bash
   docker compose up -d --build
   docker compose ps
   curl -f http://127.0.0.1:3000/health
   ```
6. HTTPS with Caddy:
   ```bash
   sudo cp Caddyfile.example /etc/caddy/Caddyfile
   sudo nano /etc/caddy/Caddyfile  # replace your-domain.example
   sudo systemctl reload caddy
   curl -f https://your-domain.example/health
   ```
7. Verify: `npm test` locally before deploy, then check `/health`, `/movies`, `/premium`, upload a small test video in `/movies-admin.html`.

### Why not deploy from OneDrive folder directly
Your project lives in `OneDrive/Bureau Portal` — Docker builds + SQLite WAL + large video sync fight OneDrive locking/quota. Deploy from a normal folder copy (`C:\deploy\bureau-portal` or the VPS copy), keep OneDrive as backup only.

## Required environment

Set production values in the deployment secret manager, not in source control:

- `NODE_ENV=production`
- `ADMIN_EMAIL` and a 12+ character `ADMIN_PASSWORD`
- `MOMO_PRIMARY_KEY`, `MOMO_API_USER`, `MOMO_API_KEY`
- `MOMO_CALLBACK_SECRET`
- `MOMO_CALLBACK_URL=https://your-domain.example/api/payment/callback`
- `CORS_ORIGIN=https://your-domain.example`
- `WIFI_PROVISIONING_MODE=mock` until a hotspot provider is ready

For MikroTik later, use `WIFI_PROVISIONING_MODE=mikrotik-rest` and configure the HTTPS RouterOS URL and restricted API credentials.

## Private Google Drive documents

Create a Google service account and share one dedicated Google Drive folder or Shared Drive with its email as a content manager. Configure `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` through the deployment secret manager. The portal uses the restricted `drive.file` scope, stores only Drive metadata locally, never creates public permissions, and exposes document routes only to administrators.

Do not put the service-account JSON file in the repository. Rotate the service-account key if it is exposed and review Drive audit logs regularly.

## HTTPS and network

Place the Node process behind an HTTPS reverse proxy such as Nginx, Caddy, or a managed platform. Expose only the proxy publicly. Keep the SQLite `data/` directory private and never expose the RouterOS management endpoint to the public internet.

## Database backups

Run `npm run backup` on a schedule and copy the generated file to separate protected storage. Back up the SQLite database and verify restore procedures before launch.

## Operations

- Run `npm test` after every deployment.
- Run `npm run audit` regularly.
- Capture the server's JSON logs in the hosting platform's log service.
- Monitor `/health` and MoMo callback failures.
- Configure process restart and graceful shutdown at the hosting layer.
- Rotate MoMo, admin, and hotspot credentials if they are exposed.
