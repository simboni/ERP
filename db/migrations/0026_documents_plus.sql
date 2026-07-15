-- 0026: Documents+ — turns the flat document store into a real DMS.
-- Adds a nestable folder tree and richer per-file metadata (category,
-- tags, description, expiry) so a business can file, search and get
-- compliance alerts on expiring licences/permits. Files still live as
-- bytea in Postgres under the same tenant RLS (0016) — no object store.

-- ---------------------------------------------------------------------------
-- Folder tree: one row per folder, parent_id nests them. Self-FK is tenant
-- safe because RLS scopes every row; ON DELETE RESTRICT so a folder with
-- children can't be orphaned (the API also refuses to delete non-empty
-- folders and surfaces a clean 400).
-- ---------------------------------------------------------------------------
CREATE TABLE document_folders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  name       text NOT NULL,
  parent_id  uuid REFERENCES document_folders (id) ON DELETE RESTRICT,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_folders_tenant_idx ON document_folders (tenant_id, parent_id);

ALTER TABLE document_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_folders FORCE ROW LEVEL SECURITY;
CREATE POLICY document_folders_tenant ON document_folders
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON document_folders TO jenga_app;

-- ---------------------------------------------------------------------------
-- Extend the existing documents table with DMS metadata. uploaded_by already
-- exists (0016) so it is not re-added. IF NOT EXISTS keeps this idempotent.
-- ---------------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS folder_id   uuid REFERENCES document_folders (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS category    text NOT NULL DEFAULT 'other',
  ADD COLUMN IF NOT EXISTS tags        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS expires_on  date;

-- Category is a small, sensible set; the API validates too.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_category_chk;
ALTER TABLE documents ADD CONSTRAINT documents_category_chk CHECK (category IN
  ('contract', 'invoice', 'receipt', 'id', 'license', 'certificate', 'report', 'other'));

CREATE INDEX IF NOT EXISTS documents_folder_idx ON documents (tenant_id, folder_id);
CREATE INDEX IF NOT EXISTS documents_category_idx ON documents (tenant_id, category);
CREATE INDEX IF NOT EXISTS documents_expires_idx ON documents (tenant_id, expires_on)
  WHERE expires_on IS NOT NULL;

-- 0016 granted only S/I/D on documents; metadata edits need UPDATE.
GRANT UPDATE ON documents TO jenga_app;
