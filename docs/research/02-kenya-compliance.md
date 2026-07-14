# 02 — Kenya Compliance Requirements for the ERP

**Status:** Drafted from knowledge base current to **January 2026**. Live web verification
of the flagged figures was queued (session research quota) — every item marked
⚠️ VERIFY must be confirmed against the cited official source before the module that
implements it ships. Statutory figures change with Finance Acts and gazette notices, so
this document must be re-reviewed **every July (Finance Act cycle) and on every gazette
alert**.

**Architectural rule this document imposes:** all rates, bands, thresholds and levies
below live in a **versioned, effective-dated `statutory_rules` configuration store** —
never hard-coded — so a gazette change is a data update, not a code release.

---

## 1. KRA eTIMS (electronic Tax Invoice Management System)

### 1.1 Who must comply
- All **VAT-registered** businesses must issue electronic tax invoices through eTIMS.
- Finance Act 2023 (amending the Income Tax Act): from **1 January 2024**, business
  expenses **not supported by an eTIMS-generated invoice are not deductible** for income
  tax — this pulled effectively *all* businesses (including non-VAT) into the system,
  because their B2B customers demand eTIMS invoices.
- Tax Procedures (Amendment) Act 2024 introduced relief for small suppliers
  (turnover below **KES 5M** ⚠️ VERIFY current threshold/status and the buyer-initiated
  "reverse invoicing" mechanism that lets buyers self-generate eTIMS invoices for
  small suppliers).
- ⚠️ VERIFY: Finance Act 2025/2026 changes, and the reported KRA move to validate
  income-tax returns against eTIMS data (an "income/expense validation engine").

### 1.2 Integration options (what our ERP must implement)
KRA offers several compliance routes; the ones relevant to an ERP vendor:

| Route | What it is | Our use |
|---|---|---|
| **VSCU** (Virtual Sales Control Unit) | Software SDK/service embedded in the taxpayer's system for high-volume, system-to-system invoicing | Primary route for our core invoicing engine ⚠️ VERIFY current certification process |
| **OSCU** (Online Sales Control Unit) | Online control unit for systems that are always connected; invoices signed via KRA online component | Alternative/complement to VSCU |
| **eTIMS Lite / web & USSD** | KRA's own free tools for micro-taxpayers | Not our route, but informs the UX bar |
| **Third-party integrator certification** | KRA approves system-to-system integrators; sandbox testing then production approval | We must complete this as a vendor ⚠️ VERIFY current onboarding steps & timelines |

Technical notes (validate in sandbox):
- Device/branch initialization, item registration with **classification codes**
  (UNSPSC-derived), customer PIN capture, invoice + credit-note flows, and stock
  movement reporting are part of the OSCU/VSCU API surface.
- Invoices must carry KRA-required fields: seller PIN, control-unit invoice number,
  **QR code** for verification, SCU ID, buyer PIN (for B2B deductibility), timestamps.
- Transmission is real-time/near-real-time when online; the spec provides for offline
  queuing with sequence integrity ⚠️ VERIFY offline rules and maximum offline window.

### 1.3 Penalties
- Failure to issue an electronic tax invoice: penalties under the VAT Act / Tax
  Procedures Act (historically **2× the tax due** or KES-scale fixed penalties)
  ⚠️ VERIFY current figures.
- Practical penalty: **customer's expense is non-deductible without our invoice** — for
  the ERP this means eTIMS availability is a P0 reliability concern; an outage stops the
  customer's sales legally, not just operationally.

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
