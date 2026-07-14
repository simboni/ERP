# Deploying on a VPS (the no-magic path)

Any fresh Ubuntu/Debian server — DigitalOcean, Hetzner, Contabo, Linode
(~$5/month) — becomes the whole platform with one command. No blueprints,
no platform env plumbing: exactly the Docker stack verified in this repo.

## One command

SSH into the server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/simboni/ERP/claude/kenya-erp-research-design-97wuc7/deploy/vps.sh | bash
```

It installs Docker if needed, clones this branch, generates secrets once
(`.env`, kept on updates), builds, and starts Postgres + migrations + the
single app container. The platform is then at `http://<server-ip>:3000`.

## With your own domain + HTTPS

Point an A record (e.g. `erp.yourdomain.co.ke`) at the server IP, then:

```bash
DOMAIN=erp.yourdomain.co.ke bash deploy/vps.sh
```

Caddy fronts the app with automatic Let's Encrypt certificates —
`https://erp.yourdomain.co.ke` is the platform.

## Operate

```bash
docker compose logs -f app     # live logs
bash deploy/vps.sh             # update to latest code (rebuild + restart)
docker compose exec postgres pg_dump -U postgres jenga_dev > backup.sql
```

Health: `/health` → `{"status":"ok","db":"ok"}`. Dev-default DB passwords
in compose are fine on a single-tenant VPS where Postgres is not exposed
(no published port); harden per docs/deploy.md before multi-customer production.
