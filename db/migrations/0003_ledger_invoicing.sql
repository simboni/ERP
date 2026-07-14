-- 0003: Double-entry ledger core + invoicing domain (04-architecture.md §4).
-- Journal is append-only and balance-enforced IN THE DATABASE: a deferred
-- constraint trigger rejects any transaction that commits an unbalanced
-- entry, regardless of which code path wrote it.

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  code       text NOT NULL,
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN
             ('asset', 'liability', 'equity', 'income', 'expense')),
  is_system  boolean NOT NULL DEFAULT false, -- required by auto-posting; cannot be renamed away
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY accounts_tenant ON accounts
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Journal (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE journal_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  entry_no        bigint NOT NULL,
  entry_date      date NOT NULL,
  memo            text NOT NULL DEFAULT '',
  source_type     text NOT NULL,             -- 'invoice', 'manual', 'payment', ...
  source_id       text,
  idempotency_key text NOT NULL,
  posted_by       uuid REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, entry_no)
);

CREATE INDEX journal_entries_tenant_date_idx
  ON journal_entries (tenant_id, entry_date DESC);

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY journal_entries_read ON journal_entries FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY journal_entries_insert ON journal_entries FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TRIGGER journal_entries_no_rewrite
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE journal_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  entry_id     uuid NOT NULL REFERENCES journal_entries (id),
  account_id   uuid NOT NULL REFERENCES accounts (id),
  debit_cents  bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  line_memo    text NOT NULL DEFAULT '',
  -- exactly one side carries a positive amount
  CHECK ((debit_cents > 0 AND credit_cents = 0)
      OR (credit_cents > 0 AND debit_cents = 0))
);

CREATE INDEX journal_lines_entry_idx ON journal_lines (tenant_id, entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines (tenant_id, account_id);

ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY journal_lines_read ON journal_lines FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY journal_lines_insert ON journal_lines FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TRIGGER journal_lines_no_rewrite
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Balance enforcement at commit time: every entry must have equal, nonzero
-- debits and credits no matter who wrote it.
CREATE FUNCTION journal_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_debits  bigint;
  v_credits bigint;
BEGIN
  SELECT coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0)
  INTO v_debits, v_credits
  FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF v_debits <> v_credits OR v_debits = 0 THEN
    RAISE EXCEPTION 'journal entry % is unbalanced: debits % <> credits %',
      NEW.entry_id, v_debits, v_credits;
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journal_lines_balance
  AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();

-- ---------------------------------------------------------------------------
-- Customers & invoices
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  name       text NOT NULL,
  kra_pin    text,          -- buyer PIN: required in practice for B2B deductibility
  phone      text,
  email      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customers_tenant_idx ON customers (tenant_id, name);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY customers_tenant ON customers
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TABLE invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  branch_id          uuid NOT NULL REFERENCES branches (id),
  customer_id        uuid NOT NULL REFERENCES customers (id),
  invoice_no         bigint,                 -- assigned at issue
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  currency           text NOT NULL DEFAULT 'KES',
  subtotal_cents     bigint NOT NULL DEFAULT 0,
  vat_cents          bigint NOT NULL DEFAULT 0,
  total_cents        bigint NOT NULL DEFAULT 0,
  issue_date         date,
  due_date           date,
  journal_entry_id   uuid REFERENCES journal_entries (id),
  fiscal_document_id uuid REFERENCES fiscal_documents (id),
  created_by         uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, invoice_no)
);

CREATE INDEX invoices_tenant_idx ON invoices (tenant_id, created_at DESC);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY invoices_tenant ON invoices
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TABLE invoice_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  invoice_id       uuid NOT NULL REFERENCES invoices (id),
  description      text NOT NULL,
  quantity         numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  vat_rate         text NOT NULL DEFAULT '0.16', -- '0.16' | '0' | 'exempt'
  line_total_cents bigint NOT NULL,
  vat_cents        bigint NOT NULL DEFAULT 0
);

CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (tenant_id, invoice_id);

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_lines_tenant ON invoice_lines
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Grants: journal is append-only for the app role too.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON accounts TO jenga_app;
GRANT SELECT, INSERT ON journal_entries TO jenga_app;
GRANT SELECT, INSERT ON journal_lines TO jenga_app;
GRANT SELECT, INSERT, UPDATE ON customers TO jenga_app;
GRANT SELECT, INSERT, UPDATE ON invoices TO jenga_app;
GRANT SELECT, INSERT, UPDATE ON invoice_lines TO jenga_app;
