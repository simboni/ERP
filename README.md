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

**Wedge backend complete (Pieces 1-4, 57 tests):**

1. **Tenancy & security core** — PostgreSQL RLS multi-tenancy (fail-closed policies,
   NOBYPASSRLS runtime role), Argon2id auth, two-stage tenant tokens, RBAC,
   hash-chained append-only audit log, CI cross-tenant leak gate.
2. **Compliance engines** — effective-dated statutory rules store seeded with
   verified July 2026 figures; statutory payroll calculator (integer-cents math);
   durable eTIMS signing queue (two-phase, per-branch sequencing, backoff,
   dead-letter) behind a country-pluggable FiscalProvider with a confined worker role.
3. **Ledger & invoicing** — append-only double-entry journal with DB-enforced
   balance (deferred constraint trigger), Kenyan SME chart of accounts, atomic
   invoice issue: totals + numbering + AR/Sales/VAT posting + eTIMS enqueue in
   one transaction.
4. **M-Pesa payments** — STK push + C2B webhook handling (exactly-once inbox),
   auto-reconciliation to open invoices with DR M-Pesa / CR AR posting and
   exception queue for manual matching.

The full loop is verified live: signup → onboard → issue invoice → eTIMS signed
(control number + QR) → M-Pesa paybill webhook → invoice paid → trial balance
nets to zero → every step in the audit trail.

5. **Web app v0** — login/signup, workspace picker, owner dashboard (cash,
   receivables, VAT owed KRA), invoice creation UI — browser-verified.
6. **Payroll module** — employees + statutory payroll runs computed from the
   rules store as-of the period (NSSF year boundaries handled automatically),
   maker-checker commit posting balanced wages/statutory/net entries.
7. **Deployment packaging** — production Dockerfiles (non-root, pruned,
   compiled migration runner), docker-compose stack, `docs/deploy.md`.

Next: invoice PDF/WhatsApp delivery, refresh-token rotation, POS/offline spike,
Daraja/OSCU production adapters. See `docs/roadmap/06-roadmap.md`.

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
