# Render Deploy Checklist — Bureau Portal

## 1. Fix locally first
Double-click `fix-and-run.bat` (uses npm.cmd directly, bypasses PowerShell block).
Wait for `Bureau portal is running on port 3000`, then open:
- http://localhost:3000/health -> `{"status":"UP"}`
- http://localhost:3000/
- http://localhost:3000/movies

If `Cannot find module` -> install did not finish, rerun bat.

## 2. Push to GitHub
1. Install Git: https://git-scm.com/download/win, restart VS Code/cmd
2. Create empty repo on github.com (DO NOT tick Add README, .gitignore, license)
3. Double-click `push-to-github.bat`, paste repo URL when asked
4. On github.com verify these are PRESENT:
   server.js, package.json, render.yaml, .env.example, public/
   And these are ABSENT: `.env`, `data/`, `*.sqlite`, `node_modules/`
5. If `.env` ever got pushed: rotate MOMO keys on momodeveloper.mtn.com + change ADMIN_PASSWORD immediately.

## 3. Deploy on Render
1. dashboard.render.com > New > Blueprint > select `bureau-portal` repo (uses `render.yaml`)
   OR New > Web Service with:
   - Build Command: `npm ci --omit=dev`
   - Start Command: `node server.js`
   - Health Check Path: `/health`
2. Set Environment Variables (Dashboard > Service > Environment, copy VALUES from local `.env`, never upload file):
```
NODE_ENV=production
NODE_VERSION=22.17.0
ADMIN_EMAIL=<your admin email>
ADMIN_PASSWORD=<12+ chars, new strong password>
CORS_ORIGIN=https://YOUR-SERVICE.onrender.com
MOMO_BASE_URL=https://sandbox.momodeveloper.mtn.com
MOMO_ENVIRONMENT=sandbox
MOMO_CURRENCY=EUR
MOMO_PRIMARY_KEY=<from .env>
MOMO_API_USER=<from .env>
MOMO_API_KEY=<from .env>
MOMO_CALLBACK_URL=https://YOUR-SERVICE.onrender.com/api/payment/callback
MOMO_CALLBACK_SECRET=<real secret, server.js throws in production if placeholder>
WIFI_PROVISIONING_MODE=mock
NOTIFICATION_CHANNEL=log
```
3. Deploy, watch Logs for `Bureau portal is running on port 3000`
4. Test: `https://YOUR-SERVICE.onrender.com/health`, `/`, `/movies`, `/premium`

## 4. Persistence warning
Render free filesystem is ephemeral - `data/*.sqlite` + `public/assets/movies/` reset on redeploy.
- Quick fix: Service > Disks > Add 1GB disk mounted at `/opt/render/project/src/data`
- Real fix for movies: VPS + Docker + Caddy, see `DEPLOYMENT.md` Option A.
- Do NOT deploy directly from `OneDrive/Bureau Portal` - copy to `C:\deploy\bureau-portal` to avoid OneDrive locking.
