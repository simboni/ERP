-- 0030: Logo storage for branding on invoices and downloadable documents.
-- Store logo as base64 data URI so it travels with the tenant and renders
-- in PDFs without external requests. The data URL includes MIME type.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS logo text;
