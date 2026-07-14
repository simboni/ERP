# 06 — Delivery Roadmap: Step-by-Step to a State-of-the-Art System

Principle (from the research): **big-bang ERP projects die in Kenya** (01 §1.1–1.2).
We ship a wedge that earns revenue early, then expand module-by-module on one platform.
Each phase has an explicit **gate** — we do not proceed on hope.

---

## Phase 0 — Foundations & proof (Weeks 1–6)

**Goal: kill the riskiest assumptions before writing product code.**

- Customer discovery: 25+ structured interviews (traders, service firms, accountants in
  Nairobi + 2 county towns). Validate the assessed weaknesses table (01 §2) and pricing
  bands; recruit 5 design partners.
- **KRA integrator track (long pole — start day 1):** eTIMS sandbox access, VSCU/OSCU
  documentation, begin certification process. Re-verify all ⚠️ items in 02.
- **Safaricom track:** Daraja developer account, sandbox, begin production-app process.
- ODPC registration prep; company/legal scaffolding; trademark the product name.
- Engineering scaffolding: monorepo, CI/CD, IaC baseline (04), auth + tenancy core with
  RLS and the cross-tenant leak test suite (05 §2), design system + Swahili/English i18n
  foundation.
- Technical spikes: eTIMS sandbox invoice signed end-to-end; STK Push + C2B callback
  end-to-end; offline sync buy-vs-build evaluation (04 §6).

**Gate G0:** eTIMS sandbox invoice signed; STK payment reconciled automatically in a
demo; 5 design partners committed; pricing hypothesis validated.

## Phase 1 — The wedge: Invoice + eTIMS + M-Pesa (Weeks 7–18)

**Goal: a Kenyan SME can sign up, onboard itself, and issue fiscalized invoices that
reconcile M-Pesa payments automatically — same day.**

- M1 core platform (tenants, RBAC, audit, notifications, rules store)
- M2 sales/invoicing with the eTIMS engine (durable signing queue, 04 §5)
- M3 payments: STK collections, C2B webhooks, auto-reconciliation + exception queue
- Guided onboarding: industry CoA template, customer/product import, first-invoice
  walkthrough; owner dashboard v1 (cash, sales, compliance health)
- PWA mobile experience; PDF/WhatsApp invoice delivery
- Security baseline from 05 in force (2FA, maker-checker on payouts deferred until B2C)

**Gate G1 (private beta):** design partners issue real fiscalized invoices; ≥80%
of their M-Pesa receipts auto-match; activation < 1 day observed, not claimed.

## Phase 2 — Money-in/money-out + books (Weeks 19–32)

**Goal: replace the bookkeeper's spreadsheet and the accountant's month-end pain.**

- M4 accounting: GL, AR/AP, VAT3 prep, financial statements, period close
- M3+: B2C payouts (maker-checker), supplier B2B payments, bank feeds
- M5 inventory & procurement (multi-warehouse, GRN/3-way match, eTIMS purchase capture)
- POS mode with the **offline pilot** (04 §6): two-site field trial gate
- Accountant multi-client console (channel play, 03 §4.5)
- **Commercial launch:** KES tiered pricing, M-Pesa-billed subscriptions, status page,
  security page

**Gate G2 (GA):** 50 paying tenants; churn < 3%/mo over 2 months; eTIMS signing
success ≥ 99.9%; offline pilot passes (zero lost sales, zero duplicate fiscalizations).

## Phase 3 — Payroll, scale & intelligence (Weeks 33–52)

**Goal: become the system of record for people and taxes, not just sales.**

- M6 payroll: full statutory engine off the rules store (02 §2), DPIA + pen test
  **before payroll GA** (05), P10/unified return drafts, B2C net-pay runs
- M7 intelligence: report builder, scheduled reports; AI v1 — receipt OCR to coded
  entries, NL query over own data, cash-flow forecast
- SOC 2 Type II program start; annual pen test cadence
- Scale work per 04 §7 (read replicas, API GA, rate limits)
- Accountant certification program + partner directory (adoption flywheel vs. the
  training failure mode, 01 §1.3)

**Gate G3:** 250+ tenants; payroll runs error-free for 3 consecutive months across
pilot cohort; support load < 0.5 tickets/tenant/month.

## Phase 4 — Depth & EAC expansion (Year 2)

- M8 industry packs (distribution/van sales first — biggest underserved segment)
- Fiscalization country plugins: Tanzania VFD, Uganda EFRIS, Rwanda EBM (02 §5)
- Marketplace/API ecosystem; silo tier for large tenants; DR multi-region
- AI v2: anomaly/fraud detection, autonomous reconciliation suggestions

---

## Team plan (lean, senior-heavy start)

| Phase | Team |
|---|---|
| 0–1 | 1 tech lead (full-stack), 2 senior full-stack, 1 product designer (contract), founder as PM/domain |
| 2 | +1 mobile/offline engineer, +1 backend (payments/fiscal), +customer success (accountant background) |
| 3 | +payroll domain engineer, +QA/SDET, +2 support/success, security contractor for pen test |

## Operating cadence

- Weekly release train behind feature flags; monthly gazette/statutory review (02 §6);
  quarterly restore drill + access review (05); post-mortems public to the team.
- North-star metric: **weekly active compliant businesses** (issued ≥1 fiscalized
  invoice or filed-ready return this week).

## Immediate next actions (this week)

1. ~~Re-verify the flagged items in 02~~ **Done (July 2026)** — compliance baseline is
   verified and frozen; next review at the Finance Act 2027 cycle or on gazette alerts.
2. Apply for KRA eTIMS sandbox/integrator onboarding (note: certification requires
   **≥3 qualified technical staff** — factor into hiring) and Safaricom Daraja accounts
   (now self-service go-live).
3. Draft the discovery interview script from 01 §2's hypothesis table.
4. Scaffold the monorepo (NestJS + Next.js + Terraform skeleton) with the RLS tenancy
   core and CI gates — the first engineering PR of the flagship.
