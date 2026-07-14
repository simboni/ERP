# Deploying Jenga ERP

## Local / staging: Docker Compose

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose up --build
# web: http://localhost:3001   api: http://localhost:3000/health
```

The stack: Postgres 16 (bootstrap SQL creates the three roles on first boot)
→ one-shot `migrate` job (applies `db/migrations/*.sql`, then exits) → `api`
(fiscal worker enabled) → `web`. Compose passwords are dev-only defaults.

## Production (AWS af-south-1, per 04-architecture.md)

| Concern | Setup |
|---|---|
| Images | Build `apps/api/Dockerfile` and `apps/web/Dockerfile` in CI, push to ECR, deploy on ECS Fargate |
| Database | RDS/Aurora PostgreSQL 16. Run `db/bootstrap.sql` once as master user with strong passwords, then the migrate job (same image, `node db-dist/migrate.js`) as a pre-deploy ECS task |
| Secrets | `APP_DB_URL`, `WORKER_DB_URL`, `ADMIN_DB_URL` (migrate task only), `JWT_SECRET` from AWS Secrets Manager — never in task definitions |
| Env | `NODE_ENV=production` (enforces JWT_SECRET length), `WEB_ORIGINS=https://app.<domain>`, `FISCAL_WORKER_ENABLED=true` on exactly one service (split the worker into its own service when scaling) |
| Edge | CloudFront in front of web + api, WAF enabled; Daraja callback path allowlisted to Safaricom IPs |
| Backups | RDS PITR + daily snapshots, cross-region copy; quarterly restore drill (05-security.md §2) |

## Invariants that survive every deploy

1. The API connects as `jenga_app` (NOBYPASSRLS, owns nothing); only the
   migration task uses `jenga_migrator`. Never point `APP_DB_URL` at an
   owner/superuser role — RLS is the tenant wall.
2. Migrations run BEFORE new app code serves traffic (compose encodes this
   with `service_completed_successfully`; replicate with a pre-deploy task).
3. `JWT_SECRET` rotation invalidates sessions — rotate deliberately.
4. New statutory figures ship as migrations to `statutory_rules` with
   `source_url` + `verified_at` (02-kenya-compliance.md §6 checklist first).
