-- 0002: Statutory rules store + eTIMS fiscalization queue.
-- Rules store: docs/research/02-kenya-compliance.md — every rate/band/limit
-- is effective-dated DATA, never code. Fiscal queue: 04-architecture.md §5.

-- ---------------------------------------------------------------------------
-- Statutory rules (global, read-only to the app; changes ship as migrations
-- with source citations so the audit trail of statutory changes is git+db).
-- Amounts are integer cents; rates are decimal strings in payload JSON.
-- ---------------------------------------------------------------------------
CREATE TABLE statutory_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key       text NOT NULL,
  jurisdiction   text NOT NULL DEFAULT 'KE',
  effective_from date NOT NULL,
  effective_to   date,
  payload        jsonb NOT NULL,
  source_url     text,
  verified_at    date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_key, jurisdiction, effective_from),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX statutory_rules_lookup_idx
  ON statutory_rules (jurisdiction, rule_key, effective_from DESC);

GRANT SELECT ON statutory_rules TO jenga_app;

-- Seeds: verified July 2026 (docs/research/02-kenya-compliance.md §2).

-- PAYE bands + reliefs, in force since 1 Jul 2023 (unchanged through FA2026).
INSERT INTO statutory_rules
  (rule_key, jurisdiction, effective_from, payload, source_url, verified_at)
VALUES (
  'paye', 'KE', '2023-07-01',
  '{
    "bands": [
      {"uptoCents": 2400000,  "rate": "0.10"},
      {"uptoCents": 3233300,  "rate": "0.25"},
      {"uptoCents": 50000000, "rate": "0.30"},
      {"uptoCents": 80000000, "rate": "0.325"},
      {"uptoCents": null,     "rate": "0.35"}
    ],
    "personalReliefCents": 240000,
    "insuranceReliefRate": "0.15",
    "insuranceReliefCapCents": 500000,
    "pensionDeductibleCapCents": 3000000
  }',
  'https://www.kra.go.ke/individual/filing-paying/types-of-taxes/paye',
  '2026-07-14'
);

-- NSSF Act 2013 phase-in. Year 3 (Feb 2025) and Year 4 (Feb 2026).
INSERT INTO statutory_rules
  (rule_key, jurisdiction, effective_from, effective_to, payload, source_url, verified_at)
VALUES
(
  'nssf', 'KE', '2025-02-01', '2026-01-31',
  '{"rate": "0.06", "lelCents": 800000, "uelCents": 7200000}',
  'https://www.nssf.or.ke/new-nssf-rates-employer-obligations', '2026-07-14'
),
(
  'nssf', 'KE', '2026-02-01', NULL,
  '{"rate": "0.06", "lelCents": 900000, "uelCents": 10800000}',
  'https://www.nssf.or.ke/new-nssf-rates-employer-obligations', '2026-07-14'
);

-- SHIF: 2.75% of gross, min KES 300, no cap (since 1 Oct 2024).
INSERT INTO statutory_rules
  (rule_key, jurisdiction, effective_from, payload, source_url, verified_at)
VALUES (
  'shif', 'KE', '2024-10-01',
  '{"rate": "0.0275", "minCents": 30000}',
  'https://vialtopartners.com/regional-alerts/kenya-employment-tax-the-social-health-insurance-fund-shif',
  '2026-07-14'
);

-- Affordable Housing Levy: 1.5% employee + 1.5% employer (Act assented 19 Mar 2024).
INSERT INTO statutory_rules
  (rule_key, jurisdiction, effective_from, payload, source_url, verified_at)
VALUES (
  'ahl', 'KE', '2024-03-19',
  '{"employeeRate": "0.015", "employerRate": "0.015"}',
  'https://kpmg.com/ke/en/home/insights/2024/03/the-affordable-housing-act-2024.html',
  '2026-07-14'
);

-- NITA training levy: KES 50/employee/month, employer-borne.
INSERT INTO statutory_rules
  (rule_key, jurisdiction, effective_from, payload, source_url, verified_at)
VALUES (
  'nita', 'KE', '2020-01-01',
  '{"perEmployeeCents": 5000}',
  'https://www.nita.go.ke/our-services/levy-inspectorate.html',
  '2026-07-14'
);

-- Statutory deductibility switch (TLAA 2024, effective 27 Dec 2024):
-- SHIF + AHL become income deductions (pre-PAYE) instead of reliefs.
INSERT INTO statutory_rules
  (rule_key, jurisdiction, effective_from, payload, source_url, verified_at)
VALUES (
  'paye_deductions', 'KE', '2024-12-27',
  '{"shifDeductible": true, "ahlDeductible": true}',
  'https://www.kra.go.ke/news-center/public-notices/2157-amendments-to-paye-computation-pursuant-to-the-tax-laws-amendment-act,-2024',
  '2026-07-14'
);

-- ---------------------------------------------------------------------------
-- Branches (tenant-scoped): the unit of fiscal sequencing (one eTIMS
-- control-unit sequence per branch/device).
-- ---------------------------------------------------------------------------
CREATE TABLE branches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  code       text NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;

CREATE POLICY branches_tenant ON branches
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON branches TO jenga_app;

-- ---------------------------------------------------------------------------
-- Fiscal documents: the durable eTIMS signing queue (04-architecture.md §5).
-- Tenant-facing access is RLS-scoped like everything else; the background
-- worker role gets an explicit cross-tenant policy on THIS TABLE ONLY.
-- ---------------------------------------------------------------------------
CREATE TABLE fiscal_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  branch_id       uuid NOT NULL REFERENCES branches (id),
  doc_type        text NOT NULL CHECK (doc_type IN ('invoice', 'credit_note')),
  idempotency_key text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'signing', 'signed', 'failed', 'dead_letter')),
  seq             bigint,
  control_number  text,
  qr_payload      text,
  signed_at       timestamptz,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, branch_id, seq)
);

CREATE INDEX fiscal_documents_queue_idx
  ON fiscal_documents (status, next_attempt_at)
  WHERE status IN ('pending', 'signing', 'failed');
CREATE INDEX fiscal_documents_tenant_idx ON fiscal_documents (tenant_id, created_at DESC);

ALTER TABLE fiscal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY fiscal_tenant ON fiscal_documents
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- The worker drains the queue across tenants. Scope: this table only, and
-- the role holds no other grants (verified by tests).
CREATE POLICY fiscal_worker ON fiscal_documents
  FOR ALL TO jenga_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON fiscal_documents TO jenga_app;
GRANT USAGE ON SCHEMA public TO jenga_worker;
GRANT SELECT, UPDATE ON fiscal_documents TO jenga_worker;
