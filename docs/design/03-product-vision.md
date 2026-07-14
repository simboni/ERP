# 03 — Product Vision, Differentiators & Feature Catalogue

## 1. Positioning

**"Compliance-grade depth, POS-grade simplicity."**

Jenga ERP is the operating system for the Kenyan SME and mid-market firm: a cloud ERP
that a business owner can start using the same afternoon, that keeps them effortlessly
compliant with KRA, and that treats M-Pesa as a native part of the ledger — at a price
denominated in KES and calibrated to Kenyan SME economics.

**Primary segments (in order of attack):**
1. **Trading & retail SMEs** (5–50 staff): wholesalers, distributors, multi-branch retail.
2. **Service firms**: agencies, clinics, schools, professional services.
3. **Light manufacturing / agribusiness** (mid-market, 50–500 staff) — later phases.

**Who we are not for (initially):** parastatals, banks, and enterprises with deep
process-manufacturing needs — SAP/Dynamics keep that ground.

## 2. The six differentiators

Each maps to a verified weakness of incumbents (see `01-market-research.md` §2):

| # | Differentiator | Incumbent gap it exploits |
|---|---|---|
| D1 | **Compliance as the core product**: first-party eTIMS engine, always-current statutory payroll, auto-drafted returns with deadline countdowns | Compliance sold as partner add-ons; breakage risk on the customer |
| D2 | **Payments-native ledger**: direct Daraja integration; every M-Pesa transaction auto-reconciled to invoices/bills; B2C salary & supplier payouts from inside the ERP | CSV-import reconciliation pain |
| D3 | **Time-to-value in one day**: self-serve guided onboarding, Kenyan chart-of-accounts templates by industry, data import wizards, modular activation | Consultant-led months-long implementations (the documented failure mode) |
| D4 | **Offline-tolerant, mobile-first operations**: Android/PWA that keeps selling, receipting and invoicing through connectivity gaps and syncs safely | Cloud ERPs unusable offline; desktop ERPs don't sync |
| D5 | **Role-scoped simplicity**: the cashier sees a POS, the storekeeper sees stock, the accountant sees ledgers, the owner sees cash & compliance health — Swahili + English | Accountant-centric, English-only UX driving training failure |
| D6 | **KES SME pricing**: per-business (not per-user) tiers, M-Pesa-payable monthly, free tier for micro-businesses | USD per-user pricing that excludes the mass market |

**AI layer (cross-cutting, phase 3+):** receipt/expense OCR to eTIMS-coded entries,
cash-flow forecasting, anomaly detection (fraud/leakage flags), natural-language
reporting ("niambie mauzo ya wiki hii" — "tell me this week's sales"). AI augments the
six differentiators; it is not a substitute for them.

## 3. Feature catalogue by module

### M1 — Core platform (foundation)
- Multi-tenant workspaces; multi-branch/multi-warehouse; multi-currency (KES primary)
- Role-based access control with field-level permissions; maker-checker approvals
- Audit trail on every mutation; document numbering series; attachment store
- Notification fabric: in-app, SMS, WhatsApp Business API, email
- Statutory rules store (effective-dated rates/bands — see 02 §preamble)
- Public REST API + webhooks; import/export (CSV/XLSX); e-signature-ready PDF engine

### M2 — Sales, invoicing & eTIMS (the wedge)
- Quotes → orders → deliveries → **eTIMS-fiscalized invoices** (VSCU/OSCU) with QR codes
- Credit notes, recurring invoices, proforma; customer statements; aging
- POS mode: barcode/till workflow, offline queue, receipt printing (ESC/POS + Bluetooth)
- Payment links (STK Push), Dynamic QR at checkout

### M3 — Payments & bank/M-Pesa reconciliation
- Daraja: STK collections, C2B paybill/till webhooks, B2C payouts, B2B transfers
- Auto-reconciliation engine with exception queue; cash drawer management
- Bank feeds (CSV/API where available), multi-account cash position dashboard

### M4 — Accounting & financial management
- Double-entry GL with Kenyan CoA templates; journals; cost centres/projects/dimensions
- AR/AP; fixed assets with depreciation; budgeting; bank/M-Pesa/cash books
- VAT3 return preparation; WHT/WVAT tracking; financial statements (IFRS for SMEs)
- Period close with lock dates; consolidated multi-branch reporting

### M5 — Inventory & procurement
- Multi-warehouse stock, batches/serials/expiry, stock takes, transfers, reorder points
- Purchase requisitions → LPOs → GRNs → supplier bills → 3-way matching
- Landed costs; supplier scorecards; eTIMS purchase-invoice capture for deductibility

### M6 — Payroll & HR (Kenya statutory)
- PAYE/NSSF/SHIF/housing levy/NITA computed from the rules store; net-pay via B2C M-Pesa
  or bank files; payslips (PDF/WhatsApp); P9s, P10/unified return drafts, agency files
- Leave, attendance (geo-tagged mobile check-in), employee self-service, loans/advances
- Contract & casual-worker patterns (daily-rate gangs, milestone pay) common in Kenya

### M7 — Reporting & intelligence
- Owner dashboard: cash today, sales today, compliance health, deadline countdowns
- Report builder; scheduled email/WhatsApp reports; branch league tables
- (Phase 3+) AI: forecasting, anomalies, natural-language Q&A, OCR capture

### M8 — Industry packs (later)
- Distribution (van sales/route accounting), schools (fees), clinics (billing+NHIF/SHA
  claims), hospitality, agribusiness (produce intake), SACCOs — activated as templates
  on the same core.

## 4. Product principles

1. **The default path is the compliant path.** You cannot issue a non-compliant invoice
   or miss a statutory deadline silently.
2. **Every feature must be operable from a phone.** Desktop is the power view, not the
   prerequisite.
3. **Progressive disclosure.** A tenant starts with 3 menu items; depth appears as
   modules activate. Never show a shopkeeper a general ledger.
4. **No data hostage-taking.** Full export at any tier, always — trust is the currency
   of the accountant channel.
5. **Accountants are a channel, not just users.** Multi-client console for accounting
   firms who will recommend us to dozens of SMEs.

## 5. Success metrics

- Activation: first fiscalized invoice within **24h** of signup (target: 60% of signups)
- Time saved: reconciliation minutes/week (instrumented), returns filed on time %
- Retention: monthly logo churn < 2%; NPS ≥ 50; accountant-channel referrals/quarter
- Compliance reliability: eTIMS signing success ≥ 99.9%; zero missed-deadline incidents
  caused by us
