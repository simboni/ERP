-- 0019: Finance+ — budgets, fixed-asset register, recurring invoice
-- templates. Budgets are pure planning data (no postings). Depreciation
-- posts through LedgerService only (DR 6200 / CR 1500, one entry per
-- asset per month, idempotency key asset:<id>:dep:<YYYY-MM>). Recurring
-- templates draft invoices through InvoicesService.createDraft.

-- ---------------------------------------------------------------------------
-- Budgets: one row per account code per fiscal year per period slot.
-- month 1-12 is a monthly amount; month 0 is an annual lump amount.
-- Integer cents, income/expense account codes only (enforced in the API).
-- ---------------------------------------------------------------------------
CREATE TABLE budgets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  account_code text NOT NULL,
  fiscal_year  int NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2100),
  month        int NOT NULL DEFAULT 0 CHECK (month BETWEEN 0 AND 12),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, account_code, fiscal_year, month)
);

CREATE INDEX budgets_year_idx ON budgets (tenant_id, fiscal_year);

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY budgets_tenant ON budgets
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON budgets TO jenga_app;

-- ---------------------------------------------------------------------------
-- Fixed assets: register rows. Accumulated depreciation lives in the
-- journal (source_type 'depreciation', source_id = asset id) — the
-- register never caches money that the ledger owns.
-- ---------------------------------------------------------------------------
CREATE TABLE fixed_assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  name               text NOT NULL,
  cost_cents         bigint NOT NULL CHECK (cost_cents > 0),
  salvage_cents      bigint NOT NULL DEFAULT 0
                     CHECK (salvage_cents >= 0 AND salvage_cents < cost_cents),
  acquired_date      date NOT NULL,
  useful_life_months int NOT NULL CHECK (useful_life_months BETWEEN 1 AND 600),
  disposed           boolean NOT NULL DEFAULT false,
  created_by         uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fixed_assets_tenant_idx
  ON fixed_assets (tenant_id, disposed, acquired_date);

ALTER TABLE fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY fixed_assets_tenant ON fixed_assets
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON fixed_assets TO jenga_app;

-- ---------------------------------------------------------------------------
-- Recurring invoice templates. `lines` is a JSON snapshot of
-- InvoiceLineInput[] (description, quantity, unitPriceCents, vatRate,
-- itemId?) replayed through InvoicesService.createDraft on each run.
-- Drafts only — issue/eTIMS stays a human action on the Invoices page.
-- ---------------------------------------------------------------------------
CREATE TABLE recurring_invoice_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  customer_id   uuid NOT NULL REFERENCES customers (id),
  branch_id     uuid NOT NULL REFERENCES branches (id),
  cadence       text NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('monthly')),
  next_run_date date NOT NULL,
  lines         jsonb NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recurring_invoice_templates_due_idx
  ON recurring_invoice_templates (tenant_id, next_run_date) WHERE active;

ALTER TABLE recurring_invoice_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_invoice_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY recurring_invoice_templates_tenant ON recurring_invoice_templates
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON recurring_invoice_templates TO jenga_app;
