-- 0006: Purchases — suppliers and bills with input VAT.
-- The eTIMS control number on a bill is the taxpayer's proof of expense
-- deductibility under s.23A (02-kenya-compliance.md §1.1); the product
-- surfaces bills missing it before the return is filed.

CREATE TABLE suppliers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  name       text NOT NULL,
  kra_pin    text,
  phone      text,
  email      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX suppliers_tenant_idx ON suppliers (tenant_id, name);

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY suppliers_tenant ON suppliers
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TABLE bills (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  supplier_id           uuid NOT NULL REFERENCES suppliers (id),
  supplier_invoice_no   text,
  etims_control_number  text, -- proof of deductibility; nullable but surfaced
  status                text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'approved', 'paid', 'void')),
  bill_date             date NOT NULL,
  due_date              date,
  subtotal_cents        bigint NOT NULL DEFAULT 0,
  vat_cents             bigint NOT NULL DEFAULT 0,
  total_cents           bigint NOT NULL DEFAULT 0,
  journal_entry_id      uuid REFERENCES journal_entries (id),
  created_by            uuid REFERENCES users (id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bills_tenant_idx ON bills (tenant_id, bill_date DESC);

ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills FORCE ROW LEVEL SECURITY;
CREATE POLICY bills_tenant ON bills
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TABLE bill_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  bill_id          uuid NOT NULL REFERENCES bills (id),
  description      text NOT NULL,
  quantity         numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  vat_rate         text NOT NULL DEFAULT '0.16',
  line_total_cents bigint NOT NULL,
  vat_cents        bigint NOT NULL DEFAULT 0,
  account_code     text NOT NULL DEFAULT '6000' -- expense/COGS account
);

CREATE INDEX bill_lines_bill_idx ON bill_lines (tenant_id, bill_id);

ALTER TABLE bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY bill_lines_tenant ON bill_lines
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON suppliers TO jenga_app;
GRANT SELECT, INSERT, UPDATE ON bills TO jenga_app;
GRANT SELECT, INSERT, UPDATE ON bill_lines TO jenga_app;
