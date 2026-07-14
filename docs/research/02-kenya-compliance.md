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

## 2. Statutory payroll (2025–2026 baseline)

All figures are the January-2026 baseline; the payroll engine reads them from the
versioned rules store with effective dates.

### 2.1 PAYE (income tax on employment)
Monthly bands (in force since Finance Act 2023, unchanged through Jan 2026 ⚠️ VERIFY):

| Monthly taxable income (KES) | Rate |
|---|---|
| Up to 24,000 | 10% |
| 24,001 – 32,333 | 25% |
| 32,334 – 500,000 | 30% |
| 500,001 – 800,000 | 32.5% |
| Above 800,000 | 35% |

- **Personal relief:** KES 2,400/month. **Insurance relief:** 15% of premiums, capped
  KES 5,000/month.
- **Tax Laws (Amendment) Act 2024, effective 27 Dec 2024:** SHIF contributions and the
  Affordable Housing Levy became **deductible from taxable income** (replacing the prior
  relief treatment); the affordable-housing relief was repealed accordingly ⚠️ VERIFY
  exact current treatment and any mortgage/pension deduction cap changes (post-2024
  pension contribution deductible limit rose to KES 30,000/month ⚠️ VERIFY).

### 2.2 NSSF (pensions — NSSF Act 2013 tiered phase-in)
- Rates: **6% employee + 6% employer** of pensionable earnings.
- Tier I on earnings up to the Lower Earnings Limit (LEL); Tier II from LEL to Upper
  Earnings Limit (UEL). Year 3 (from **Feb 2025**): LEL 8,000 / UEL 72,000 →
  max employee contribution 4,320. Year 4 (from **Feb 2026**): UEL stepped up again
  (schedule ties UEL to national average earnings; reported Year 4 figures LEL 9,000 /
  UEL 108,000 ⚠️ VERIFY the gazetted Feb 2026 limits before implementing).
- Tier II may be directed to a registered private scheme with RBA approval — the payroll
  module must support contracted-out Tier II.

### 2.3 SHIF (Social Health Insurance Fund — replaced NHIF, 1 Oct 2024)
- **2.75% of gross salary**, minimum **KES 300/month**, no upper cap ⚠️ VERIFY any
  2025/2026 amendments.
- Employer deducts and remits by the **9th of the following month**.
- Non-payroll persons pay 2.75% of household income (min KES 300) — relevant only for
  informing employee self-service education screens.

### 2.4 Affordable Housing Levy
- **1.5% of gross salary from the employee + 1.5% employer match** (Affordable Housing
  Act 2024), remitted with the payroll cycle by the 9th working day ⚠️ VERIFY exact
  deadline wording.
- Deductible for PAYE from Dec 2024 (see §2.1).

### 2.5 NITA industrial training levy
- **KES 50 per employee per month**, employer-borne; collected **via the KRA unified
  payroll return alongside PAYE** ⚠️ VERIFY current remittance mechanics.

### 2.6 Filing mechanics the payroll module must automate
- **PAYE + housing levy + NITA:** monthly filing via iTax (P10/unified payroll return),
  payment by the **9th of the following month**.
- **NSSF:** monthly return and payment (by the 9th ⚠️ VERIFY current deadline).
- **SHIF:** monthly, by the 9th.
- Outputs the module must generate: P9 annual employee tax card, payslips with all
  statutory lines, bank/M-Pesa net-pay files, and CSV/API-ready returns for each agency.
- Penalties (late PAYE: 25% of tax due min KES 10,000; late NSSF/SHIF/levy penalties
  ⚠️ VERIFY each) — the product should surface deadline countdowns and auto-drafted
  returns as a headline feature.

---

## 3. Data Protection Act 2019 (DPA) & ODPC obligations

- **Registration:** Data controllers/processors must register with the ODPC (Registration
  Regulations 2021) unless exempt (annual turnover below KES 5M **and** fewer than 10
  employees — with sector carve-outs that void the exemption ⚠️ VERIFY our SaaS falls
  outside carve-outs; as a payroll processor we almost certainly must register).
  Registration renews every ⚠️ VERIFY (24 months baseline).
- **Roles:** We are a **data processor** for tenant employee/customer data and a
  **controller** for our own account data — contracts (DPAs with tenants) must reflect both.
- **Cross-border transfers (ss. 48–49):** permitted with appropriate safeguards
  (contractual, adequacy, or consent). There is **no general data-localization mandate**
  for ordinary business data; s.50 allows the Cabinet Secretary to require local
  processing for **strategic interests** (civil registration data must be processed
  in-country). Hosting in **AWS af-south-1 (Cape Town)** with standard safeguards is the
  recommended posture ⚠️ VERIFY current ODPC guidance notes and any new s.50 gazettes.
- **Data subject rights:** access, rectification, erasure, objection, portability —
  tenant-facing DSR tooling required.
- **Breach notification:** to ODPC **within 72 hours** of becoming aware (and to data
  subjects where there is real risk of harm).
- **Penalties:** up to **KES 5,000,000 or 1% of annual turnover** (whichever is lower)
  per infringement ⚠️ VERIFY, plus reputational/enforcement actions.
- **DPIA:** required for high-risk processing — payroll and financial profiling likely
  qualify; run one before payroll GA.

**Product consequences:** tenant data isolation (RLS + tested cross-tenant controls),
encryption at rest and in transit, granular consent/purpose records, DSR endpoints,
audit logs, breach-response runbook, ODPC registration before first paying tenant.

---

## 4. M-Pesa / mobile money integration (Safaricom Daraja)

- **Core APIs:** M-Pesa Express (STK Push) for customer-present collection; **C2B**
  (register validation/confirmation URLs) for paybill/till collections; **B2C** for
  payouts (salaries, refunds, supplier disbursement); **B2B** (incl. pay-bill-to-pay-bill);
  **Transaction Status**, **Account Balance**, **Reversal**; **Dynamic QR**; Tax
  Remittance API ⚠️ VERIFY current availability tiers.
- **Auth model:** OAuth (consumer key/secret) → bearer token; B2C/B2B require the
  initiator **security credential** (password RSA-encrypted with Safaricom's public
  cert). Production go-live requires app review and a **public HTTPS callback**
  infrastructure; callbacks are asynchronous — the integration must be
  **idempotent**, persist a pending state, and reconcile timeouts via Transaction Status
  queries (payments can succeed after a timeout).
- **Aggregators (Kopo Kopo, Pesapal, IntaSend, Flutterwave):** commonly used to shortcut
  Safaricom onboarding and to add card/bank rails; trade-off is per-transaction fees and
  an added dependency. **Decision:** integrate Daraja directly for M-Pesa (it is our
  flagship differentiator and margin matters), keep an aggregator adapter interface for
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
