# 02 — Kenya Compliance Requirements for the ERP

**Status:** **VERIFIED July 2026.** Initially drafted from a January-2026 knowledge
baseline, then every flagged figure was verified/corrected via targeted research against
official sources (KRA, NSSF, NITA, ODPC, Kenya Law, Ministry of Labour) and top-tier
advisories (PwC, KPMG, EY, Bowmans, CDH, RSM, Vialto). Access note: several official
sites block automated reads, so some verifications rest on search-indexed official-page
content corroborated by convergent advisories — re-confirm exact statutory wording when
implementing. Statutory figures change with Finance Acts and gazette notices, so this
document must be re-reviewed **every July (Finance Act cycle) and on every gazette
alert**.

**Architectural rule this document imposes:** all rates, bands, thresholds and levies
below live in a **versioned, effective-dated `statutory_rules` configuration store** —
never hard-coded — so a gazette change is a data update, not a code release.

---

## 1. KRA eTIMS (electronic Tax Invoice Management System)

*Verified July 2026 against KRA public notices/guides, Kenya Law gazette texts, and
big-4/law-firm advisories (PwC, KPMG, EY, Bowmans, CDH, RSM).*

### 1.1 Who must comply — VERIFIED
- Finance Act 2023 (TPA **s.23A**, effective 1 Sep 2023): **all persons carrying on
  business** — including non-VAT-registered — must generate and transmit invoices via
  eTIMS. [official: KRA notices 2071/2077]
- From **1 Jan 2024**, expenses **not supported by an eTIMS invoice are non-deductible**
  for income tax (carve-outs: emoluments, imports, interest, investment allowances,
  airline ticketing, final-WHT payments — Finance Act 2025 added final-WHT to this list).
- **Small-supplier (< KES 5M turnover) relief — CONTESTED, treat as hollow:** enacted
  27 Dec 2024 (Tax Laws/Procedures Amendment Acts 2024) together with **s.23A(3A)
  buyer-initiated (reverse) invoicing**; KRA published **BII Guidelines on 25 Mar 2025**
  (buyer generates the invoice via eCitizen; seller accepts/rejects within **30 days**).
  KRA has pushed to scrap the exemption since Apr 2025 and 2026 advisories state all
  businesses must onboard (micro-traders via eTIMS Lite Web/USSD *222#). **Design
  assumption: every supplier needs an eTIMS invoice path** — own device, eTIMS Lite, or
  BII. [official: kenyalaw.org Act 21/2024, KRA BII page; advisory: Bowmans, KPMG, Fonoa]
- **Return validation engine — CONFIRMED LIVE:** per KRA public notice 2323, effective
  **1 Jan 2026** income-tax returns (from 2025 year of income) are **validated on iTax
  submission against eTIMS invoice data, WHT data, and customs records**; expenses must
  be backed by e-invoices carrying the **buyer's PIN**. Non-compliant books now produce
  rejected returns — this is the strongest commercial tailwind for compliance-native ERP.
  [official: KRA notice 2323; advisory: EY, BDO, KPMG]

### 1.2 Integration options (what our ERP must implement) — VERIFIED
KRA's system-to-system routes for a "Trader Invoicing System" (TIS):

| Route | What it is | Our use |
|---|---|---|
| **OSCU** (Online Sales Control Unit) | Always-online, real-time invoice-signing API | Primary for cloud tenants |
| **VSCU** (Virtual Sales Control Unit) | High-volume/bulk invoicing; **offline-capable** with later transmission | Primary for POS/offline mode (pairs with 04 §6) |
| **eTIMS Lite / web & USSD (*222#)** | KRA's free tools for micro-taxpayers | Not our route; sets the UX bar and serves BII counterparties |
| **Third-party integrator certification** | Sandbox testing → vetting → interim approval → production listing | Required for us as a vendor |

**Certification process (VERIFIED):** (1) sign up on the eTIMS portal selecting
OSCU/VSCU; (2) develop and test against the **KRA sandbox** per the API specs;
(3) apply with the **eTIMS Bio Data Form**, business registration docs, proof of
**≥3 qualified technical staff**, notarized solvency declaration, and
technology-architecture documentation; (4) vetting + demo of test cases; (5) interim
approval certificate → production credentials and listing. **No official SLA** —
practitioner reports suggest weeks to ~3 months; start in Phase 0 (roadmap) and staff
accordingly (the 3-technical-staff requirement is a hiring-plan constraint).
[official: KRA system-to-system page, OSCU/VSCU sign-up guide, Bio Data form]

Technical notes:
- API surface: device/branch initialization, item registration with classification
  codes, customer PIN capture, invoice + credit-note flows, stock movement reporting.
- Required invoice fields (ETI Regulations 2024): seller PIN, control-unit invoice
  number + SCU identifier, date-time, item code/description/quantity/unit price, gross,
  tax rate and amount, unique system identifier, **QR code**; **buyer PIN** optional in
  law but mandatory in practice for the buyer's deductibility/input-VAT claim.
- **Offline rules (VERIFIED, one nuance):** queued invoices must transmit once
  connectivity resumes — the operational window is **24 hours** (receipts unsubmitted
  beyond 24h are flagged; the 24h figure is from technical guidance, not the
  Regulations' text). Separately, on **system failure/downtime** the taxpayer must
  **notify the Commissioner in writing within 24 hours** and capture alternative-means
  sales into eTIMS on restoration — our fiscal service should automate both the
  detection and the notification workflow. [official: LN 64/2024; advisory: RSM, EY, EDICOM]

### 1.3 Penalties — VERIFIED (changed twice; current regime below)
- History: TPA s.86 penalty of **2× the tax due** (Finance Act 2023); Finance Act 2025
  raised it to the **higher of 2× tax due or KES 2M** (from 1 Jul 2025).
- **Current (Finance Act 2026, effective 1 Jul 2026):** s.86 replaced — failure to use
  electronic tax systems now draws **5% of the tax due, minimum KES 100,000 (company) /
  KES 10,000 (individual)**, imposable only after written notice and consideration of
  the taxpayer's reasons (e.g., system issues beyond their control — a procedural
  safeguard that our downtime-notification automation directly supports).
  [advisory: PwC FA2026 alert, CDH, Lexology]
- The sharper commercial sanction is unchanged: **non-eTIMS expenses are non-deductible
  and now fail return validation (§1.1)** — for the ERP this makes eTIMS availability a
  P0 reliability concern; an outage stops the customer's sales legally, not just
  operationally.

### 1.4 Product consequences
1. eTIMS engine is **core, first-party, SLA-backed** — never an add-on (see 01 §2).
2. Queue-and-forward invoice signing with strict monotonic sequencing to survive
   connectivity gaps within KRA's offline allowances.
3. Full audit trail of every fiscalized document; immutable once signed.
4. Sandbox-first CI: every release runs an eTIMS contract-test suite against the KRA
   sandbox before deploy.

---

## 2. Statutory payroll (verified July 2026)

*All items below verified July 2026 against official (KRA, NSSF, NITA, Ministry of
Labour) and advisory (KPMG, EY, Grant Thornton, Vialto, CDH, RSM) sources. The payroll
engine reads every figure from the versioned rules store with effective dates.*

### 2.1 PAYE (income tax on employment) — VERIFIED
Monthly bands (in force since 1 Jul 2023; **unchanged by Finance Acts 2025 and 2026** —
Finance Bill 2026 proposals to restructure bands were rejected by Parliament):

| Monthly taxable income (KES) | Rate |
|---|---|
| Up to 24,000 | 10% |
| 24,001 – 32,333 | 25% |
| 32,334 – 500,000 | 30% |
| 500,001 – 800,000 | 32.5% |
| Above 800,000 | 35% |

- **Personal relief:** KES 2,400/month. **Insurance relief:** 15% of premiums, capped
  KES 5,000/month (SHIF no longer earns insurance relief — it is an income deduction).
- **Tax Laws (Amendment) Act 2024 (effective 27 Dec 2024) — VERIFIED:** SHIF, Affordable
  Housing Levy, and post-retirement medical fund contributions (capped KES 15,000/month)
  are **deductible from taxable income**; the 15% affordable-housing relief was repealed;
  deductible pension/provident limit rose KES 20,000 → **30,000/month**; mortgage
  interest cap rose to 30,000/month. [official: KRA public notice 2157; advisory: KPMG
  TLAA 2024 analysis, Cliffe Dekker Hofmeyr]
- **Finance Act 2025 (effective 1 Jul 2025) — engine requirements:** employers **must
  automatically apply all eligible reliefs, exemptions and deductions** in PAYE
  computation (this is now a legal duty our engine satisfies by design); tax-free per
  diem raised to **KES 10,000/day**; gratuity exempted — **Finance Act 2026 (assented
  23 Jun 2026)** tightened the gratuity exemption to require ≥3 years' continuous
  service. [advisory: Vialto, payroll.org, ENSafrica, EY]

### 2.2 NSSF (NSSF Act 2013 tiered phase-in) — VERIFIED
- Rates: **6% employee + 6% employer** of pensionable earnings.
- Year 3 (from Feb 2025): LEL 8,000 / UEL 72,000 (max employee 4,320/month).
- **Year 4 (from 1 Feb 2026) — CONFIRMED: LEL 9,000 / UEL 108,000** → Tier I max
  KES 540 each side; Tier II on earnings 9,001–108,000; **max deduction KES 6,480
  employee + 6,480 employer (12,960 combined)**. [official: nssf.or.ke;
  advisory: CM Advocates, PaySpace]
- Tier II may be contracted out to a registered private scheme with RBA approval — the
  payroll module must support contracted-out Tier II.

### 2.3 SHIF (Social Health Insurance Fund — replaced NHIF, 1 Oct 2024) — VERIFIED
- **2.75% of gross salary**, minimum **KES 300/month, no upper cap**; employer deducts
  and remits to SHA by the **9th of the following month** (SHI General Regulations 2024).
- **Litigation watch item:** in June 2025 the High Court opined the 2.75% gross-income
  deduction is unlawful but issued **no orders** (issues pending at the Court of Appeal,
  Civil Appeal E565/2024); the Ministry of Health confirmed deductions **remain in
  force**. The rules store means any court-ordered change is a data update. [advisory:
  ALN, Vialto, Citizen Digital, Standard]

### 2.4 Affordable Housing Levy — VERIFIED
- **1.5% employee + 1.5% employer** on monthly gross salary (Affordable Housing Act
  2024); remit **within 9 working days after month end**; late penalty **3% of the
  unpaid amount per month**. Employee share deductible for PAYE from Dec 2024 (§2.1).
  [advisory: EY, KPMG, Grant Thornton]

### 2.5 NITA industrial training levy — VERIFIED
- **KES 50/employee/month** (KES 600/year), employer-borne, **declared via the KRA
  unified payroll return** (with PAYE on iTax). Payment may be consolidated **annually**
  (KES 600/employee by the 9th of the month after the employer's accounting year-end) —
  support both monthly and annual remittance. Late penalty 5%. [official: nita.go.ke;
  advisory: RSM, PwC]

### 2.6 Filing mechanics the payroll module must automate — VERIFIED
- **PAYE + housing levy + NITA:** monthly iTax unified payroll return; file and pay by
  the **9th of the following month**.
- **NSSF:** by the 9th; late-payment penalty **5% per month or part month**.
- **SHIF:** by the 9th; late penalty **2% of the unpaid amount per period**; employer
  offences up to KES 2M fine and/or 3 years' imprisonment.
- **PAYE penalties (clarified):** late **filing** 25% of tax due (min KES 10,000); late
  **payment** separately 5% of tax due + 1% interest/month.
- Outputs: P9 annual tax card, payslips with all statutory lines, bank/M-Pesa net-pay
  files, CSV/API-ready returns per agency — with deadline countdowns and auto-drafted
  returns as a headline feature.

### 2.7 Minimum wage — VERIFIED
- Regulation of Wages (Amendment) Order 2024: ~6% rise effective 1 Nov 2024 [official:
  labour.go.ke]. **Legal Notice No. 109 of 2026 (effective 1 May 2026): +12% general /
  +15% agricultural minimum wages.** Sector/city rate tables to be loaded into the rules
  store from the Legal Notice text; the HR module should warn when a contracted wage
  falls below the applicable order.

---

## 3. Data Protection Act 2019 (DPA) & ODPC obligations

*Verified July 2026 against ODPC regulations/guidance and legal advisories.*

- **Registration (VERIFIED):** Data controllers/processors must register with the ODPC
  (Registration Regulations 2021, LN 265/2021) unless exempt — exemption requires **both**
  annual turnover below KES 5M **and** fewer than 10 employees, and is **void for listed
  sectors** regardless of size (financial services, telecoms, health, education,
  hospitality, transport, betting, property, direct marketing…). Processing tenant
  payroll/financial data puts us firmly in scope — **we must register**. Certificate
  valid **24 months**, renewable. Current fees: micro/small KES 4,000 (renewal 2,000);
  medium (51–99 staff, KES 5–50M) 16,000/9,000; large (>99 staff, >KES 50M)
  40,000/25,000 — one fee covers both controller and processor roles.
  [official: odpc.go.ke LN 265/2021 + ODPC Guidance Note on Registration;
  advisory: dlapiperdataprotection.com (KE), koassociates.co.ke]
- **Roles:** We are a **data processor** for tenant employee/customer data and a
  **controller** for our own account data — contracts (DPAs with tenants) must reflect both.
- **Cross-border transfers (VERIFIED):** ss.48–49 permit transfers with appropriate
  safeguards/adequacy/necessity (sensitive data additionally needs data-subject consent +
  confirmed safeguards). There is **no general data-localization mandate** for ordinary
  business data; s.50 + General Regulations 2021 restrict only **"strategic interests of
  the state"** processing (civil registration, elections, national ID, revenue
  administration, etc.) to Kenyan data centres (or at least one serving copy in-country).
  Hosting in **AWS af-south-1 (Cape Town)** with SCC-style contractual safeguards,
  encryption, and a documented transfer basis is lawful and remains the recommended
  posture. **Watch items:** ODPC **draft Guidance Note on Cross-Border Data Transfers
  (13 Apr 2026, consultation closed 15 May 2026, still draft)** — formalizes the four
  transfer bases and flags "high-risk" transfers as potentially needing ODPC approval.
  [official: ODPC General Regulations 2021 + draft 2026 Guidance Note; advisory: cms.law]
- **Data subject rights:** access, rectification, erasure, objection, portability —
  tenant-facing DSR tooling required.
- **Breach notification (VERIFIED):** controller → ODPC **within 72 hours** of becoming
  aware (where real risk of harm); **processor → controller within 48 hours** (relevant
  to us as processor!); data subjects notified in writing within a reasonably practical
  period. [official: DPA s.43; advisory: cms.law]
- **Penalties (VERIFIED):** administrative fines up to **KES 5,000,000 or 1% of annual
  turnover, whichever is LOWER** (DPA s.63); separate criminal offences up to KES 3M
  and/or 10 years. **Watch item:** the **Data Protection (Amendment) Bill 2025** (before
  Parliament as of mid-2026) proposes flipping this to whichever is **HIGHER**, an
  appeals tribunal, and expanded sensitive-data categories — track to enactment.
  [advisory: wamaeallen.com, manwaadvocates.com]
- **DPIA (VERIFIED):** required for high-risk processing (s.31); General Regulations
  require the DPIA report to be submitted to the Data Commissioner **at least 60 days
  before processing begins**. Payroll in a multi-tenant ERP is the standard advisory
  example of high-risk processing — **schedule the DPIA ≥60 days before payroll GA**
  (roadmap Phase 3 dependency). [official: General Regulations 2021]

**Product consequences:** tenant data isolation (RLS + tested cross-tenant controls),
encryption at rest and in transit, granular consent/purpose records, DSR endpoints,
audit logs, breach-response runbook, ODPC registration before first paying tenant.

---

## 4. M-Pesa / mobile money integration (Safaricom Daraja)

*Verified July 2026 (official portal corroborated via convergent secondary sources —
developer.safaricom.co.ke blocks automated reads; re-confirm in the portal at build time).*

- **Core APIs (VERIFIED catalogue):** M-Pesa Express (STK Push) + **Express Query**;
  **C2B** (Register URL with validation/confirmation callbacks) for paybill/till
  collections; **B2C** payouts (salaries, refunds, disbursements); **B2B**
  (BusinessPayBill/BusinessBuyGoods) and **B2B Express Checkout** (USSD push so another
  business pays till-to-paybill); **Transaction Status**, **Account Balance**,
  **Reversal**; **Dynamic QR**; **Tax Remittance** (to KRA); **M-Pesa Ratiba** (standing
  orders/recurring — useful for our own subscription billing); plus **Bill Manager** and
  **B2C Account Top-Up**. [official: developer.safaricom.co.ke/apis]
- **Auth model (VERIFIED):** OAuth (consumer key/secret) → time-bound bearer token;
  B2C/B2B/Status/Reversal/Balance additionally require an **Initiator + SecurityCredential**
  (initiator password RSA-encrypted with Safaricom's public certificate — **sandbox and
  production certificates differ**; re-encrypt at go-live). Callbacks must be **public
  HTTPS** endpoints. Go-live is tied to a live PayBill/Till and org-portal admin
  verification; **as of May 2025 Safaricom is moving Daraja onboarding/go-live to a
  fully self-service model**, reducing manual review friction — good news for our
  Phase 0 timeline.
- **Async handling (VERIFIED pattern):** all payment results arrive via async callbacks
  (ResultURL/QueueTimeoutURL); STK processing can take ~60s and **payments can succeed
  after your timeout**. Required design: ack callbacks with 200 immediately and process
  async; **idempotent handlers** deduped on MpesaReceiptNumber/CheckoutRequestID
  (Safaricom may redeliver callbacks); Transaction Status / Express Query sweeps for
  missed callbacks; periodic reconciliation of pending payments. (Matches 04 §5 design.)
- **Aggregators (VERIFIED):** Kopo Kopo, Pesapal, IntaSend, Flutterwave (also DPO Pay,
  Paystack) are widely used to shortcut onboarding and add **card/bank rails**, at
  ~1.4–3.8% per-transaction fees. **Decision stands:** integrate Daraja directly for
  M-Pesa (flagship differentiator; margin matters — and self-service go-live lowers the
  onboarding cost that justified aggregators), keep an aggregator adapter interface for
  cards/other rails.
- **Reconciliation (the killer feature):** every C2B confirmation and statement line is
  matched to open invoices automatically (amount + account reference + fuzzy payer
  matching), with an exception queue for manual matching. This is the single most
  painful daily task we remove for Kenyan SMEs.

---

## 5. Other compliance surfaces (later phases)

- **VAT return (VAT3) preparation** from eTIMS-consistent ledgers; **withholding tax**
  (WHT) and **withholding VAT** handling for relevant customers.
- **TIMS/eTIMS for retail POS** hardware coexistence (legacy ETR fleets).
- **County-level licensing** (single business permits) — document store + renewal
  reminders only, no filing integration initially.
- **E-invoicing regional trend:** Tanzania (TRA VFD), Uganda (EFRIS), Rwanda (EBM) — the
  fiscalization engine must be **country-pluggable** from day one for EAC expansion.

---

## 6. Verification checklist (run before each implementing module ships)

| Item | Source of truth |
|---|---|
| eTIMS integrator certification steps, VSCU/OSCU specs | kra.go.ke + KRA integrator portal |
| eTIMS small-supplier threshold & reverse invoicing | Tax Procedures (Amendment) Act 2024 + KRA notices |
| PAYE bands/reliefs current year | KRA + Finance Act |
| NSSF Year 4 (Feb 2026) LEL/UEL gazette | nssf.or.ke / Kenya Gazette |
| SHIF rate/min & remittance rules | sha.go.ke / SHIF Regulations |
| Housing levy rate & deadline | housinglevy portal / KRA |
| NITA unified return mechanics | KRA/NITA joint notices |
| ODPC registration tiers/fees/renewal | odpc.go.ke |
| Daraja API catalogue & go-live process | developer.safaricom.co.ke |
