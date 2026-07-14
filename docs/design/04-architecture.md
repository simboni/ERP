# 04 — Platform & Architecture Recommendation

## 1. Build strategy: platform choice

Three strategies were weighed:

| Option | Verdict |
|---|---|
| **A. Customize an open-source ERP (ERPNext/Odoo) and resell** | Fastest to feature breadth, but we inherit their UX, their upgrade treadmill, a GPL/LGPL licensing posture, and community-maintained Kenya localization — the exact weaknesses we intend to compete on (01 §2). Rejected as the flagship strategy; **kept as a reference implementation** to study data models. |
| **B. Low-code platform (OutSystems/Retool-class)** | Prohibitive licensing at SaaS scale, vendor lock-in, weak offline/POS story. Rejected. |
| **C. Purpose-built multi-tenant SaaS on open foundations** ✅ | Full control of UX, compliance engine, offline behaviour and unit economics. Higher initial build cost — mitigated by the modular roadmap (06). **Chosen.** |

## 2. Recommended stack

Chosen for: one-language hiring in Nairobi (TypeScript), massive ecosystems, proven
patterns, and low managed-infrastructure cost.

| Layer | Choice | Rationale |
|---|---|---|
| Database | **PostgreSQL 16+ (managed)** | Verified RLS multi-tenancy (01 §1.5); JSONB for custom fields; battle-tested |
| Backend | **TypeScript / Node.js (NestJS)** | Modular monolith discipline (modules = ERP modules); DI, guards/interceptors for tenancy & audit; shared types with frontend |
| ORM/data | **Prisma or Drizzle** + raw SQL for ledger paths | Type-safe CRUD; hand-written SQL where correctness matters (postings) |
| Jobs/queue | **BullMQ on Redis** | eTIMS queue, reconciliation matching, report generation, webhooks |
| Web frontend | **React (Next.js) PWA** | One codebase for desktop + installable offline-capable mobile web |
| Mobile (POS/field) | **React Native (Expo)** for the POS & field app | Bluetooth receipt printing, barcode camera, robust offline store |
| Offline store/sync | **SQLite (client) + sync protocol** — evaluate PowerSync / ElectricSQL vs. custom op-log | See §6 — must be validated by field pilot, per refuted-claims caveat (01 §1.6) |
| Search | Postgres FTS first; OpenSearch when needed | Avoid premature infra |
| Files | S3-compatible object storage | Receipts, attachments, exports |
| Infra | **AWS af-south-1 (Cape Town)** primary; CloudFront edge in Nairobi | DPA-friendly posture (02 §3), lowest latency to KE of the major clouds |
| IaC/CI | Terraform + GitHub Actions; containers on ECS Fargate (K8s only when scale demands) | Small-team operability |
| Observability | OpenTelemetry → Grafana stack (or CloudWatch to start) | eTIMS/payment SLOs need first-class tracing |
| AI layer (P3+) | Anthropic Claude API via a gateway service | OCR-to-entry, NL reporting, forecasting orchestration |

**Architecture style: modular monolith → selective services.** One deployable with
strict module boundaries (sales, ledger, inventory, payroll…). The first candidates to
split out later: the **fiscalization (eTIMS) service** and the **payments gateway** —
both have external-SLA characteristics and country-plugin futures.

## 3. Multi-tenancy (verified pattern)

Pooled tenancy on PostgreSQL RLS, per the AWS-verified pattern (01 §1.5):

- Every tenant-owned table carries `tenant_id uuid not null`.
- `CREATE POLICY tenant_isolation ON <table> USING (tenant_id = current_setting('app.current_tenant')::uuid);`
- App connects as a **non-owner role without BYPASSRLS**; tables get
  `FORCE ROW LEVEL SECURITY`.
- Tenant context set per-request inside the transaction: `SET LOCAL app.current_tenant = $1`
  (safe under PgBouncer transaction pooling).
- All composite indexes lead with `tenant_id`.
- **Defence in depth:** application-layer tenancy guard as well; automated cross-tenant
  leak tests in CI (attempt access with wrong tenant context; must return zero rows).
- Escape hatch for scale/enterprise: the model permits promoting a large tenant to its
  own schema/database later (silo tier) without app rewrites if repositories only ever
  query through the tenancy context.

## 4. Ledger core (the part we never compromise)

- **Double-entry, append-only journal.** Postings are immutable; corrections are
  reversing entries. Period locks enforced in the DB.
- Financial amounts as `numeric` (never float); money type wrapper in code.
- Every subledger document (invoice, receipt, payslip, GRN) posts through a single
  posting service with idempotency keys — one code path to audit.
- Event outbox pattern: ledger events drive reports, webhooks, and read models without
  dual-write risk.

## 5. Compliance engines

### eTIMS fiscalization service
- Wraps VSCU/OSCU behind a domain interface `FiscalProvider` (country-pluggable for
  EAC expansion, 02 §5).
- **Durable signing queue:** invoice issued → queued → signed → QR/control-number
  attached; strict per-branch monotonic sequencing; retries with backoff;
  dead-letter + operator alerting. Offline windows honoured per KRA rules (02 §1.2).
- Contract tests against the KRA sandbox in CI; canary invoice on every deploy.

### Statutory rules store
- `statutory_rules(rule_key, jurisdiction, effective_from, effective_to, payload jsonb, source_url, verified_at)`
- Payroll/VAT engines evaluate rules **as of the payroll/tax period date** — enabling
  retroactive corrections and clean gazette updates as data migrations with tests.

### Payments gateway
- Daraja adapter (STK, C2B, B2C, B2B, status, reversal) with: idempotency keys on every
  outbound call, persisted state machine per payment (`initiated → pending → confirmed/failed/timeout-reconciling`),
  signed-callback verification, IP allowlisting, and scheduled Transaction Status sweeps
  for timeouts. Aggregator adapters (cards) behind the same interface.
- Reconciliation engine: deterministic matching (account ref, amount, MSISDN) →
  heuristic scoring → exception queue UX.

## 6. Offline-tolerant sync (design goal to validate)

The literature claim that store-and-forward offline POS "just works" was **refuted** in
verification (01 §1.6), so we treat offline as an engineering programme with a pilot
gate, not an assumption:

- **Scope offline narrowly where it pays:** POS sales, receipts, stock counts, price
  list & customer cache. (General ledger, payroll, settings remain online-only.)
- Client keeps an **append-only operation log** in SQLite; server assigns authoritative
  sequence; conflicts resolved by domain rules (e.g., stock can go negative-pending,
  prices always server-win, invoices get provisional numbers fiscalized on sync within
  KRA's offline allowance).
- Evaluate **PowerSync / ElectricSQL** before building custom sync; decision spike in
  Phase 1 with a two-week field pilot in a real shop (Nairobi + one low-connectivity
  county town) before GA.

## 7. Scalability path

1. **0–500 tenants:** single region, one Postgres (vertical), Fargate autoscaling,
   Redis, CDN. Everything above fits this.
2. **500–5,000:** read replicas for reporting read models; queue workers scaled out;
   OpenSearch if needed; rate-limited public API GA.
3. **5,000+ / EAC expansion:** partition largest tables by tenant; silo tier for big
   tenants; country plugins (fiscalization/payroll) as deployable services; multi-region
   active/passive DR.

Cost discipline: the pooled model + modular monolith keeps infra < 10% of revenue at
SME price points — this is what makes D6 (KES pricing) economically survivable.

## 8. Key risks & mitigations

| Risk | Mitigation |
|---|---|
| KRA sandbox/certification delays | Start integrator onboarding in Phase 0; eTIMS Lite/OSCU fallback path |
| Offline sync complexity balloons | Narrow scope (§6), buy-before-build evaluation, pilot gate |
| Statutory change velocity | Rules store + gazette-watch review cadence (02 §preamble) |
| Safaricom go-live friction | Aggregator fallback adapter; start Daraja production app early |
| Single-DB blast radius | PITR backups, tested restores, silo escape hatch (§3) |
