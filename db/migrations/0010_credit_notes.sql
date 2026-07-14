-- 0010: Credit notes — the compliant correction path (02-kenya-compliance
-- §1.4: fiscalized documents are immutable; corrections are credit notes,
-- never edits). v1 supports full reversal of an issued/paid invoice.

CREATE TABLE credit_notes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  invoice_id         uuid NOT NULL REFERENCES invoices (id),
  credit_note_no     bigint NOT NULL,
  reason             text NOT NULL,
  subtotal_cents     bigint NOT NULL,
  vat_cents          bigint NOT NULL,
  total_cents        bigint NOT NULL,
  journal_entry_id   uuid REFERENCES journal_entries (id),
  fiscal_document_id uuid REFERENCES fiscal_documents (id),
  created_by         uuid REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, credit_note_no),
  UNIQUE (invoice_id) -- v1: one full-reversal credit note per invoice
);

ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_notes_tenant ON credit_notes
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT ON credit_notes TO jenga_app;

-- Invoices gain the credited terminal state.
ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft', 'issued', 'paid', 'void', 'credited'));
