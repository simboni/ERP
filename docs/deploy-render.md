# Deploying the Pilot on Render

Render hosts the API + web as Docker services and provides the managed
PostgreSQL. Total time: ~20 minutes. Cost: two Starter services + Basic
Postgres (or the free DB tier for a short demo).

## Zero-touch deploy

1. Log in to render.com → **New → Blueprint** → pick `simboni/ERP` and this
   branch → **Apply**. (Already created it? Just press **Manual sync** to
   pick up the latest commit.)
2. That's it. The API's pre-deploy step (`db-dist/bootstrap-and-migrate.js`)
   creates the two runtime DB roles with auto-generated passwords, then runs
   every migration; connection URLs, CORS origin and the web app's API URL
   are all derived automatically from the blueprint's service links.
3. Verify: `https://jenga-api-XXXX.onrender.com/health` → `{"status":"ok"}`,
   then open the jenga-web URL, sign up, and issue your first sandbox
   invoice.

Deploy order note: the web service may build before the API's hostname
exists on the very first apply — if the web app can't reach the API, just
Manual Deploy jenga-web once; it rebuilds with the API host injected.

Manual fallback: if a managed Postgres denies CREATEROLE (Render's does
not), run `db/bootstrap-managed.sql` per its header comment and set
`APP_DB_URL`/`WORKER_DB_URL` explicitly — explicit URLs always win over
the derived ones.

## Notes

- **Providers stay in sandbox** (`FISCAL_PROVIDER`/`PAYMENT_PROVIDER`
  unset = sandbox) until KRA/Safaricom credentials exist — flip them via
  env vars when they do (see `.env.example`).
- M-Pesa webhooks: point Daraja's confirmation URL at
  `https://jenga-api-XXXX.onrender.com/webhooks/mpesa/c2b/confirmation`
  when you register the real shortcode.
- The free Postgres tier expires after 30 days — fine for a demo, use
  Basic for the pilot. Production remains AWS af-south-1 per
  `docs/deploy.md`.
- Never point `APP_DB_URL` at the owner user: the RLS tenant wall depends
  on the runtime role owning nothing (04-architecture.md §3).
