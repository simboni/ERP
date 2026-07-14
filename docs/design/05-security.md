# 05 — Security Architecture & Secure Development Lifecycle

Security posture target: **an ERP holds a business's money movements, payroll, and tax
identity — we design to bank-adjacent standards from day one**, scaled pragmatically to
team size. Framework anchors: OWASP ASVS L2, CIS benchmarks for infra, Kenya DPA 2019
(02 §3), with SOC 2 Type II as the Phase-3 certification goal (enterprise/mid-market
sales enabler).

## 1. Identity & access

- **Tenant users:** email/phone + password (Argon2id), **TOTP 2FA** (mandatory for
  admin/finance roles), optional SMS OTP for low-tech users, session tokens as
  short-lived JWT + rotating refresh; device list & remote sign-out.
- **RBAC:** deny-by-default roles (owner, admin, accountant, cashier, storekeeper,
  payroll officer, viewer) + per-branch scoping + field-level redaction (e.g. cashier
  never sees payroll). **Maker-checker** on: payouts, payroll runs, credit notes over
  threshold, supplier bank-detail changes, user-role grants.
- **Staff (our side):** SSO + hardware-key MFA; production access via break-glass with
  session recording; no standing access to tenant data; support access requires
  tenant-granted, time-boxed consent (visible to the tenant in their audit log).

## 2. Data protection

- TLS 1.2+ everywhere; HSTS; encrypted at rest (KMS-managed keys; column-level
  encryption for high-sensitivity fields: national IDs, KRA PINs, bank/MSISDN details,
  API secrets in KMS-sealed vault).
- Tenant isolation: Postgres RLS + app guard + CI cross-tenant leak tests (04 §3).
- Backups: automated PITR + daily snapshots, encrypted, cross-region copy; **quarterly
  restore drills** (a backup that hasn't been restored is a hope, not a backup).
- Data lifecycle: retention schedules per record class (tax records: 5+ years per KRA;
  logs: 13 months), DSR tooling (export/erase where legally erasable), crypto-shredding
  for tenant offboarding.
- DPA compliance work items: ODPC registration, DPIA before payroll GA, tenant DPAs,
  breach runbook with 72-hour ODPC notification path, subprocessor register.

## 3. Application security

- Input validation at the edge (schema-validated DTOs), parameterized SQL only,
  output encoding, CSRF tokens on web, strict CORS, CSP.
- **Idempotency keys** on all money-moving endpoints; amounts revalidated server-side;
  no client-supplied prices on posting paths.
- Webhooks (Daraja callbacks): signature/allowlist verification, replay protection
  (nonce + timestamp window), processed exactly-once via inbox table.
- Secrets: never in code/env-files in repo; AWS Secrets Manager + IAM task roles;
  automated rotation for DB and Daraja credentials.
- Dependencies: lockfiles, Dependabot/Renovate, `npm audit`/OSV scanning in CI, SBOM
  generation; container images scanned (Trivy) and pinned by digest.
- Rate limiting & abuse controls per tenant and per IP; bot protection on auth.
- Audit log: append-only, hash-chained, exportable — covers auth events, permission
  changes, money movements, statutory filings, support access.

## 4. Infrastructure security

- Private subnets for DB/Redis; security groups least-privilege; no SSH (SSM only).
- WAF in front of public endpoints; DDoS baseline (AWS Shield).
- IaC scanned (tfsec/Checkov); drift detection; environments (dev/staging/prod) in
  separate AWS accounts with SCP guardrails.
- Centralized structured logs with tenant-id tagging (but never secrets/PII in logs);
  alerting on auth anomalies, RLS policy errors, eTIMS queue depth, payment-state
  mismatches.

## 5. Secure development lifecycle (SDL)

1. **Design:** threat model per module (STRIDE-lite, one page) before build; abuse
   cases for money paths (e.g., "cashier voids sale after M-Pesa confirmation").
2. **Code:** protected main branch, mandatory review, no direct-to-prod; security
   lint rules; pre-commit secret scanning (gitleaks).
3. **CI gates:** unit + property tests on ledger math (postings always balance),
   cross-tenant leak tests, SAST, dependency & container scans, eTIMS sandbox contract
   tests.
4. **Release:** staged deploys with canary invoice/payment probes; feature flags;
   one-command rollback; signed artifacts.
5. **Operate:** on-call with runbooks (eTIMS outage, Daraja outage, breach); incident
   post-mortems; quarterly access reviews; annual external penetration test (before
   payroll GA, then yearly); vulnerability disclosure policy.
6. **People:** security onboarding for every hire; least-privilege by default; laptops
   with disk encryption + MDM once team > ~5.

## 6. Fraud & financial-integrity controls (ERP-specific)

- Immutable fiscalized documents; voids/credits leave the original intact (02 §1.4).
- Cash-drawer variance tracking; per-user Z-reports; discount/void thresholds with
  approvals — targets the leakage problem SME owners fear most (a selling point, not
  just a control).
- Payroll: bank/M-Pesa detail changes trigger owner notification + cooling period;
  duplicate-MSISDN detection across payees.
- Anomaly detection (Phase 3 AI): unusual credit-note velocity, off-hours postings,
  price-override clusters.

## 7. Trust as go-to-market

Publish a plain-language security page (uptime, encryption, ODPC registration number,
audit rights for accountants), status page, and data-export guarantee. In a market
burned by vanished vendors and hostage data (01 §2), verifiable trust is a feature.
