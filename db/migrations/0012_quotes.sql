-- 0012: Quotations — the start of most Kenyan B2B trade. A quote converts
-- into a draft invoice; nothing posts to the ledger until that invoice
-- is issued.

CREATE TABLE quotes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  branch_id      uuid NOT NULL REFERENCES branches (id),
  customer_id    uuid NOT NULL REFERENCES customers (id),
  quote_no       bigint NOT NULL,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'sent', 'accepted', 'expired', 'converted')),
  valid_until    date,
  subtotal_cents bigint NOT NULL DEFAULT 0,
  vat_cents      bigint NOT NULL DEFAULT 0,
  total_cents    bigint NOT NULL DEFAULT 0,
  invoice_id     uuid REFERENCES invoices (id), -- set on conversion
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, quote_no)
);

CREATE INDEX quotes_tenant_idx ON quotes (tenant_id, created_at DESC);

ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes FORCE ROW LEVEL SECURITY;
CREATE POLICY quotes_tenant ON quotes
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TABLE quote_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  quote_id         uuid NOT NULL REFERENCES quotes (id),
  description      text NOT NULL,
  quantity         numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  vat_rate         text NOT NULL DEFAULT '0.16',
  line_total_cents bigint NOT NULL,
  vat_cents        bigint NOT NULL DEFAULT 0,
  item_id          uuid REFERENCES items (id)
);

CREATE INDEX quote_lines_quote_idx ON quote_lines (tenant_id, quote_id);

ALTER TABLE quote_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY quote_lines_tenant ON quote_lines
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON quotes TO jenga_app;
GRANT SELECT, INSERT ON quote_lines TO jenga_app;
