# Go-Live Checklist

Everything the platform needs between "all tests green" and "real Kenyan
businesses run on this." Items are grouped by who can complete them.

## A. Founder actions (only you)

| # | Item | Notes |
|---|---|---|
| A1 | ☐ KRA eTIMS integrator application | Sandbox signup → Bio Data Form, ≥3 technical staff evidence, solvency declaration (02 §1.2) |
| A2 | ☐ Safaricom Daraja production app | Self-service go-live; needs a live PayBill/Till (02 §4) |
| A3 | ☐ Cloud account + domain | AWS af-south-1 recommended (docs/deploy.md); Render/Railway fine for a pilot |
| A4 | ☐ ODPC registration | Data controller + processor; fees per tier (02 §3) |
| A5 | ☐ Company/legal scaffolding | Terms of service, tenant DPA template, privacy policy |
| A6 | ☐ SMS/WhatsApp provider account | Africa's Talking or WhatsApp Business Cloud API |
| A7 | ☐ 5 design partners recruited | Roadmap Phase 0 gate — pilot before public launch |

## B. Engineering, unblocked by A (config + certification work)

| # | Item | Depends on |
|---|---|---|
| B1 | ☐ Deploy staging: images are CI-published; run bootstrap + migrate, set secrets (`JWT_SECRET`, `DATA_ENCRYPTION_KEY`, DB URLs) | A3 |
| B2 | ☐ eTIMS sandbox certification: validate OSCU adapter field mapping, item classification codes, credit-note flow; pass KRA demo | A1 |
| B3 | ☐ Daraja production wiring: `PAYMENT_PROVIDER=daraja`, B2C initiator credential (RSA-encrypt with prod cert), callback URLs + Safaricom IP allowlist at the edge | A2, B1 |
| B4 | ☐ Notification provider adapter (implements existing interface) + `NOTIFY_WORKER_ENABLED=true` | A6 |
| B5 | ☐ Backup verification: restore drill on staging DB | B1 |
| B6 | ☐ External penetration test (required before payroll GA per 05 §5) | B1 |
| B7 | ☐ DPIA filed with ODPC ≥60 days before payroll processing | A4 |

## C. Engineering, deliberately post-pilot (do not block go-live)

- POS offline mode — field-pilot-gated by design (04 §6)
- Accountant multi-client console — channel play, after first cohort
- OpenTelemetry traces — structured logs + ops metrics suffice for pilot scale
- Multi-region DR — single-region + PITR backups suffice for pilot scale

## D. Already done (verified by the 95-test suite)

Multi-tenant RLS isolation · eTIMS queue + credit notes · M-Pesa STK/C2B with
partial payments and exception queue · double-entry ledger with DB-enforced
balance · statutory payroll (verified July-2026 rules) + payslips + P10 ·
purchases with s.23A surfacing · VAT3 drafts · inventory with COGS ·
notifications outbox · 2FA + rate limiting + security headers · PII
encryption · tenant data export · Docker images auto-published by CI ·
deadline countdown feed · audit hash-chain.

## Launch-day sequence (when A+B are checked)

1. `git tag v1.0.0-pilot` on the green commit; deploy the SHA-tagged images.
2. Run bootstrap + migrations against production DB; verify `/health`.
3. Flip providers: `FISCAL_PROVIDER=oscu`, `PAYMENT_PROVIDER=daraja`, notification provider on.
4. Canary: one real invoice on the founder's own tenant → eTIMS control number verified on the KRA portal → one KES 10 STK push → reconciled.
5. Onboard design partner #1 in person. Watch everything. Fix. Repeat ×5.
