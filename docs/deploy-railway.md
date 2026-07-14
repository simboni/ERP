# Deploying on Railway (railway.com)

The alternative host to Render. Same single-origin architecture: ONE
container serves the API and the web app, and the container **provisions
its own database on boot** (roles + all migrations, idempotent) — there is
nothing to run manually and no pre-deploy hook to configure. Total cost:
Hobby plan ($5/month, includes usage) — the trial credit is enough to
evaluate.

## Steps (once, ~5 minutes)

1. Go to https://railway.com → **Login with GitHub**.
2. **New Project → Deploy from GitHub repo** → choose `simboni/ERP`.
   - If asked, grant Railway access to the repository.
3. Click the created service → **Settings → Source** → set **Branch** to
   `claude/kenya-erp-research-design-97wuc7`. (Build config is picked up
   automatically from `railway.json` in the repo.)
4. Add the database: right-click the project canvas (or **+ Create**) →
   **Database → Add PostgreSQL**.
5. Back on the ERP service → **Variables** → **New Variable**, add these
   five (Raw Editor lets you paste them all at once):

   ```
   ADMIN_DB_URL=${{Postgres.DATABASE_URL}}
   JWT_SECRET=<paste 64 random characters>
   DATA_ENCRYPTION_KEY=<paste 64 different random characters>
   FISCAL_WORKER_ENABLED=true
   NOTIFY_WORKER_ENABLED=true
   ```

   For the two secrets, any long random strings work — e.g. run
   `openssl rand -hex 32` twice, or use a password generator (60+ chars).
   `${{Postgres.DATABASE_URL}}` must be typed exactly like that — it is a
   Railway reference to the database you just created.
6. **Settings → Networking → Generate Domain** → when asked for the port,
   enter **3000**.
7. Click **Deploy** (or it deploys on its own after the variable changes).
   First build takes ~5 minutes.

Open the generated `https://<something>.up.railway.app` URL — that single
URL is the whole platform. `.../health` should show
`{"status":"ok","db":"ok"}`. Create your account on the login page.

## Why this needs no migration step

The container's boot script (`apps/api/docker-entrypoint.sh`) sees
`ADMIN_DB_URL`, creates the two least-privilege runtime roles (passwords
derived from `JWT_SECRET`), runs every migration, then starts the API.
Re-deploys re-run it; it is idempotent and never blocks startup — if the
database is unreachable the app still boots and `/health` reports
`db: error` so the problem is visible instead of a dead deploy.

## Updates

Push to the branch (or ask Claude to) → Railway auto-deploys. Nothing else
to do.

## Notes

- Providers stay in **sandbox mode** (safe fake eTIMS/M-Pesa) until real
  KRA/Safaricom credentials are set via env vars — see `.env.example`.
- Same rule as everywhere: never set `APP_DB_URL` to the owner user; the
  RLS tenant wall depends on the runtime role owning nothing.
