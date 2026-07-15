-- Documents: tenant file store (contracts, LPOs, receipts, KRA letters)
-- attachable to business records. Files live in Postgres (bytea, 5MB cap
-- enforced in the API) which keeps the single-container deployment true —
-- no external object store needed at pilot scale.

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name        text NOT NULL,
  mime        text NOT NULL,
  size_bytes  integer NOT NULL CHECK (size_bytes > 0),
  data        bytea NOT NULL,
  entity_type text CHECK (entity_type IN
              ('invoice', 'customer', 'supplier', 'employee', 'bill', 'quote')),
  entity_id   uuid,
  uploaded_by uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_tenant_idx ON documents (tenant_id, created_at DESC);
CREATE INDEX documents_entity_idx ON documents (tenant_id, entity_type, entity_id);
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_tenant ON documents
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON documents TO jenga_app;
