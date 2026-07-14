# Jenga ERP — A State-of-the-Art ERP for Kenya

> *Jenga* (Swahili: "to build") — working codename; final brand TBD.

Jenga ERP is a Kenya-first, mobile-first, offline-tolerant, multi-tenant SaaS ERP for
Kenyan SMEs and mid-market firms. It is designed around the three things global ERPs
consistently get wrong in this market: **compliance is bolted on, connectivity is assumed,
and pricing/implementation is calibrated for Western enterprises.**

## Repository layout

| Path | Contents |
|---|---|
| `docs/research/01-market-research.md` | Verified research: existing ERP weaknesses & failure modes in Kenya |
| `docs/research/02-kenya-compliance.md` | Kenya regulatory requirements: KRA eTIMS, payroll statutory rules, DPA 2019, M-Pesa |
| `docs/design/03-product-vision.md` | Product vision, differentiators, and full feature catalogue |
| `docs/design/04-architecture.md` | Recommended platform, tech stack, and system architecture |
| `docs/design/05-security.md` | Security architecture and secure development lifecycle |
| `docs/roadmap/06-roadmap.md` | Phased, step-by-step delivery roadmap (MVP → scale) |

## The one-paragraph thesis

Kenyan businesses run on M-Pesa, answer to KRA's eTIMS in real time, operate through
connectivity that comes and goes, and cannot afford six-month SAP implementations or
per-user dollar pricing. Peer-reviewed research on Kenyan ERP projects shows they fail
for organisational reasons — poor training, weak change management, cost overruns —
more than technical ones. Jenga ERP therefore competes on **time-to-value (days, not
months), compliance-as-a-feature (eTIMS and statutory payroll built into the core),
payments-native design (M-Pesa as a first-class ledger citizen), and an offline-tolerant
mobile experience** — packaged at KES-denominated SME pricing with in-product guided
onboarding replacing consultant-led implementation.

## Status

**Foundation Piece 1 shipped:** monorepo + PostgreSQL RLS tenancy core + auth/RBAC +
append-only audit trail, with a CI-enforced cross-tenant leak test gate.
See `docs/roadmap/06-roadmap.md` for the full build plan.

## Development

Prerequisites: Node 22+, pnpm 10+, PostgreSQL 16+.

```bash
# 1. One-time: create roles + databases (as a Postgres superuser)
sudo -u postgres psql -v ON_ERROR_STOP=1 -f db/bootstrap.sql

# 2. Install and migrate
pnpm install
pnpm db:migrate        # jenga_dev
pnpm db:migrate:test   # jenga_test (used by the test suites)

# 3. Run the API (http://localhost:3000)
pnpm --filter @jenga/api dev

# 4. Tests — includes the RLS cross-tenant leak gate
pnpm build && pnpm test
```

### Code layout

| Path | Contents |
|---|---|
| `db/` | bootstrap roles, SQL migrations (RLS policies live here), migration runner |
| `apps/api` | NestJS API: auth, tenancy runtime (`DbService.withTenant`), RBAC guards, audit |
| `packages/shared` | Types shared with future web/POS clients (roles, token claims) |

### Security invariants (enforced by tests, never regress)

1. The runtime DB role has `NOBYPASSRLS` and owns no tables; every tenant table has
   `FORCE ROW LEVEL SECURITY`.
2. Tenant context is set only via transaction-local `set_config(..., true)` inside
   `DbService.withTenant()` — no other write path to `app.current_tenant`.
3. No tenant context ⇒ every policy denies (fail closed).
4. `audit_log` is append-only: no UPDATE/DELETE grants, plus a blocking trigger.
5. Tenant provisioning goes only through `create_tenant_with_owner()`
   (SECURITY DEFINER); the app role cannot INSERT into `tenants`.
