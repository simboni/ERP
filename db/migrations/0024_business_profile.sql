-- 0024: Business profile, tax defaults and branch details.
-- The Settings hub turns thin one-offs into a real configuration surface:
-- the tenant's own legal identity (KRA PIN, VAT number, addresses, contacts)
-- and the numbering/tax defaults that invoices, quotes and receipts read as
-- their source of truth. All new columns hang off the existing RLS-protected
-- tenants/branches tables, so no new policies are needed — only a widened
-- grant so the app role may UPDATE the tenant row it can already read.

-- ---------------------------------------------------------------------------
-- Tenant business profile + tax/numbering defaults. Nullable text so an
-- existing workspace keeps working; typed defaults where a sane value exists.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS legal_name        text,
  ADD COLUMN IF NOT EXISTS kra_pin           text,
  ADD COLUMN IF NOT EXISTS vat_number        text,
  ADD COLUMN IF NOT EXISTS phone             text,
  ADD COLUMN IF NOT EXISTS email             text,
  ADD COLUMN IF NOT EXISTS postal_address    text,
  ADD COLUMN IF NOT EXISTS physical_address  text,
  ADD COLUMN IF NOT EXISTS currency          text NOT NULL DEFAULT 'KES',
  ADD COLUMN IF NOT EXISTS fiscal_year_start_month int NOT NULL DEFAULT 1
    CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS invoice_footer    text,
  ADD COLUMN IF NOT EXISTS invoice_prefix    text,
  ADD COLUMN IF NOT EXISTS quote_prefix      text,
  ADD COLUMN IF NOT EXISTS default_vat_rate  text NOT NULL DEFAULT '16',
  ADD COLUMN IF NOT EXISTS prices_vat_inclusive boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_payment_terms_days int NOT NULL DEFAULT 30
    CHECK (default_payment_terms_days >= 0);

-- The app role could only read the tenant row (0001). Profile/tax edits are
-- app-layer restricted to owner/admin and RLS still confines the write to the
-- caller's own tenant, so a plain UPDATE grant is safe.
GRANT UPDATE ON tenants TO jenga_app;

-- ---------------------------------------------------------------------------
-- Branch details for multi-vendor businesses: contact/address, one default
-- location, and a soft-deactivate flag (branches are referenced by fiscal
-- documents and purchase orders, so they are retired, not deleted).
-- ---------------------------------------------------------------------------
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS phone      text,
  ADD COLUMN IF NOT EXISTS address    text,
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS active     boolean NOT NULL DEFAULT true;

-- At most one default branch per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS branches_one_default
  ON branches (tenant_id) WHERE is_default;
