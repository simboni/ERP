# 01 — Market Research: Why Existing ERPs Underserve Kenya

**Status:** Research phase deliverable · July 2026
**Method:** Multi-source web research with adversarial claim verification (each claim
independently checked by 3 verifiers; claims failing 2/3 were discarded). Findings below
are separated into **verified** (survived verification, cited) and **assessed** (industry
analysis from practitioner knowledge, to be validated in customer discovery).

---

## 1. Verified findings

### 1.1 Kenyan ERP implementations fail for locally-rooted, organisational reasons — confidence: HIGH

Peer-reviewed research on Kenyan ERP projects (Otieno 2008, Springer LNBIP, surveying ERP
consultants across five Kenyan organisations) documents that ERP projects in Kenya face
**distinct economic, cultural, and basic-infrastructure challenges** beyond those in
developed-market ERP literature, and that *"many organisations in Kenya have not been able
to reap benefits out of their investment in ERP systems due to unsuccessful or incomplete
implementation."* Post-2020 Kenyan studies (geothermal sector 2022, state agencies,
healthcare/NGO 2023–2024) corroborate the same pattern: resource constraints, ICT
infrastructure limits, and change-resistant organisational culture.

> Source: https://link.springer.com/chapter/10.1007/978-3-540-79396-0_35
> Caveat: foundational (2008) study, small consultant-perspective sample; treat as a
> historical pattern corroborated by newer studies, not a current-state market census.

**Design implication:** an ERP for Kenya wins or dies on *implementation experience*, not
feature count. Guided in-product onboarding, templated chart of accounts, and
days-not-months time-to-value directly attack the documented failure mode.

### 1.2 Pre-implementation failure is a distinct, documented failure mode — confidence: MEDIUM

Kenyan institutions have seen ERP/IS projects die **before ever going live**. Case study:
Moi University's Academic Register Information System (ARIS) — donor-funded via the Dutch
MHO programme — was "choked" by accumulating challenges and never reached operation,
with failure coinciding with donor-programme wind-down (~2003). External-funding
dependency is a structural fragility of big-bang IS projects in Kenya.

> Sources: https://www.researchgate.net/publication/334801387 ·
> https://academicjournals.org/journal/IJLIS/article-abstract/97FB99461139
> Caveat: single-institution case, events from the 2000s, journal rigor questioned.

**Design implication:** avoid big-bang implementations entirely. Modular activation
(start with invoicing + eTIMS, switch on inventory/payroll later) means a customer is
*live and getting value* before any large commitment exists to fail.

### 1.3 The top global ERP failure factors are organisational — confidence: MEDIUM

A 2023 systematic literature review (55 articles, 2000–2022, 35 failure factors) ranks
the top five ERP failure factors as: **(1) lack of top-management support, (2) inadequate
education and training, (3) mismatch between system and business strategy, (4) weak
project management, (5) user unwillingness to adopt.**

> Sources: https://jbt.sljol.info/articles/10.4038/jbt.v7i1.109 ·
> https://www.researchgate.net/publication/370394801
> Caveat: review excludes Africa; application to Kenya is inferential (but consistent
> with §1.1's Kenya-specific evidence).

**Design implication:** training and adoption are product problems, not services
problems. Build Swahili/English UI, role-based simplicity (a shopkeeper sees a POS, an
accountant sees a ledger), and embedded learning — don't outsource adoption to
consultants the SME can't afford.

### 1.4 African POS platforms are converging upward into "light ERP" — confidence: MEDIUM

Modern African POS/payments platforms (Moniepoint's Moniebook at ~₦6,000/month, Nomba
MAX, Yoco, AvadaPay) already bundle inventory, cash-register functions, digital receipts,
and SMS confirmations for low-connectivity zones. **POS-plus-back-office is the
established SME entry point.** A new Kenyan ERP either out-competes these upward-expanding
POS players or differentiates with the full ERP depth they lack (double-entry accounting,
payroll, statutory compliance, procurement, manufacturing).

> Source: https://weetracker.com/2025/11/05/how-offline-pos-works-africa-avadapay/
> (weak primary source; convergence trend independently corroborated via 2023–2026
> coverage of Moniepoint, Nomba, Yoco)

**Design implication:** our wedge is *compliance-grade depth with POS-grade simplicity*.
The POS players can't do eTIMS-integrated accounting and statutory payroll; the global
ERPs can't do POS-grade onboarding and pricing. We occupy the middle.

### 1.5 PostgreSQL Row-Level Security is a verified low-cost multi-tenancy pattern — confidence: HIGH

For a pooled multi-tenant SaaS on a startup budget, PostgreSQL RLS (9.5+) moves tenant
isolation from application code into the database engine: one shared database, a
per-session tenant runtime parameter, and `CREATE POLICY ... USING (tenant_id =
current_setting('app.current_tenant')::uuid)`. AWS's reference implementation demonstrates
cross-tenant access being blocked; RLS runs on managed Aurora/RDS PostgreSQL.
Operational caveats: tenant-setting and queries must share a transaction under pooling
(`SET LOCAL`); the app role must not own tables (or use `FORCE ROW LEVEL SECURITY`) and
must lack `BYPASSRLS`; composite indexes should lead with `tenant_id`.

> Sources: https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/ ·
> https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/rls.html ·
> https://github.com/aws-samples/aws-saas-factory-postgresql-rls

**Design implication:** adopted as the core tenancy model — see `04-architecture.md`.

### 1.6 Claims that failed verification (do not build on these)

The following were **refuted 0–3** during verification and must not be cited:
- "Offline POS store-and-forward is a proven pattern with no lost transactions" (single
  promotional source). Offline-first remains a *design goal* here, but we must validate
  the sync architecture ourselves — see `04-architecture.md` §6.
- "SMEs drive 80% of Sub-Saharan Africa's economy / 70% informal" (UNECA citation
  could not be verified as stated).
- "Most African SMEs operate in unstable-connectivity areas" (as a quantified claim).
- AvadaPay's claimed 20-market scale.

---

## 2. Assessed weaknesses of incumbent ERPs in Kenya

The claims below come from practitioner/industry knowledge and vendor-published
characteristics. They shape our differentiation hypotheses and **must be pressure-tested
in customer discovery interviews (Roadmap Phase 0)** before major bets are placed on any
single one.

| Incumbent | Strengths in Kenya | Weaknesses we exploit |
|---|---|---|
| **SAP (S/4HANA, Business One)** | Deep functionality; large-enterprise credibility (banks, manufacturers, parastatals) | USD licensing + consultant-led implementations measured in months/years; B1 partner quality varies; overkill for SMEs; eTIMS via third-party add-ons |
| **Microsoft Dynamics 365 BC/F&O** | Strong partner network in Nairobi; Office integration | Per-user USD pricing stacks up fast; localization (eTIMS, statutory payroll) delivered by partner add-ons of varying quality; heavy for small firms |
| **Oracle NetSuite** | True cloud, strong financials | Priced for mid-market+ in USD; thin local partner bench; Kenya localization not first-class |
| **Sage (50/200/300 People)** | Entrenched in Kenyan accounting/payroll practice; accountants know it | Aging desktop-era architecture in lower tiers; server-based deployments; modules feel stitched together; cloud transition incomplete |
| **Odoo** | Modular, affordable entry, big community; popular with Kenyan SMEs | Community edition needs technical self-support; per-app/per-user costs grow; eTIMS/payroll localization depends on third-party modules of uneven maintenance; offline story weak |
| **ERPNext (Frappe)** | Open-source, full-suite, low cost; growing Kenya community (KRA eTIMS community app exists) | Self-hosting burden or thin local managed-hosting options; UX oriented to power users; localization community-maintained; support SLAs scarce |
| **Local vendors / custom systems** | Local support relationships; KES pricing | Narrow scope (often accounting-only or POS-only); limited R&D depth; key-person risk; weak security/audit posture |
| **POS-plus platforms (§1.4)** | Instant onboarding, payments-native, cheap | No double-entry accounting, no statutory payroll, no procurement/manufacturing depth; not a system of record an auditor accepts |

### Cross-cutting gaps (our opportunity space)

1. **Compliance is an add-on, not the core.** Every incumbent treats KRA eTIMS and
   Kenyan statutory payroll as partner modules or after-market integrations. When KRA
   validates returns against eTIMS data, "the add-on broke" becomes an existential
   business risk for the customer.
2. **Connectivity is assumed.** Cloud ERPs degrade to unusable without stable internet;
   desktop ERPs don't sync. Nobody does graceful offline for the daily operations loop
   (sell, receipt, invoice).
3. **M-Pesa is bolted on.** Incumbents reconcile M-Pesa via CSV imports or third-party
   middleware. None treat mobile-money rails as a first-class ledger citizen with
   automatic reconciliation.
4. **Pricing and implementation are calibrated for the West.** USD per-user pricing,
   consultant-led implementation, and training days price out the Kenyan SME — the
   segment that is 90%+ of businesses.
5. **The phone is an afterthought.** Owner-operators run businesses from Android phones;
   incumbent mobile apps are dashboards, not operational tools.
6. **English-only, accountant-only UX.** No Swahili; screens designed for trained
   back-office staff, not the owner-operator or the shop assistant.

---

## 3. Conclusions carried into design

| Research finding | Design response (see docs 03–06) |
|---|---|
| Failure is organisational: training, change mgmt, cost | Guided self-serve onboarding; role-scoped minimal UIs; modular activation; KES SME pricing |
| Pre-implementation death of big-bang projects | Land with one killer module (eTIMS invoicing), expand in-product |
| POS players own the SME entry point | POS-grade front end on ERP-grade core: "compliance-grade depth, POS-grade simplicity" |
| Compliance treated as add-on by incumbents | eTIMS + statutory payroll as core, first-party, SLA-backed features |
| M-Pesa reconciliation pain | Payments-native ledger: Daraja integration + auto-reconciliation as flagship feature |
| Offline claims unverified in literature | Offline-tolerant (not fully offline-first) architecture, validated with field pilots |
| RLS multi-tenancy verified | Pooled Postgres + RLS tenancy (04-architecture.md) |
