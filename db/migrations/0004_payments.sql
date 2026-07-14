-- 0004: Payments — M-Pesa rails + auto-reconciliation (04-architecture.md §5).
-- Design per verified Daraja integration pattern (02-kenya-compliance.md §4):
-- async callbacks, idempotent handlers deduped on receipt/checkout ids,
-- timeout reconciliation via Transaction Status sweeps.

-- ---------------------------------------------------------------------------
-- Shortcode -> tenant routing (global infrastructure table, like users):
-- webhooks arrive with no tenant token; the paybill/till shortcode is how a
-- callback finds its tenant. No RLS by design; app-layer only.
-- ---------------------------------------------------------------------------
CREATE TABLE mpesa_shortcodes (
  shortcode  text PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON mpesa_shortcodes TO jenga_app;

-- ---------------------------------------------------------------------------
-- Callback inbox: exactly-once processing of provider events (05-security §3).
-- Global for the same reason as shortcodes; unique event id is the dedupe key.
-- ---------------------------------------------------------------------------
CREATE TABLE payment_inbox (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_event_id text NOT NULL UNIQUE,
  event_type        text NOT NULL,           -- 'c2b_confirmation' | 'stk_callback'
  payload           jsonb NOT NULL,
  processed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE (processed_at) ON payment_inbox TO jenga_app;

-- ---------------------------------------------------------------------------
-- Payments (tenant-scoped). State machine per the verified Daraja pattern:
-- initiated -> pending -> confirmed | failed | timeout_reconciling.
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  rail             text NOT NULL CHECK (rail IN ('mpesa_stk', 'mpesa_c2b', 'cash')),
  state            text NOT NULL DEFAULT 'initiated'
                   CHECK (state IN ('initiated', 'pending', 'confirmed',
                                    'failed', 'timeout_reconciling')),
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  msisdn           text,
  account_ref      text,                    -- payer-entered reference (invoice no)
  provider_ref     text,                    -- CheckoutRequestID for STK
  receipt_number   text,                    -- MpesaReceiptNumber once confirmed
  invoice_id       uuid REFERENCES invoices (id),
  journal_entry_id uuid REFERENCES journal_entries (id),
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error       text,
  confirmed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, receipt_number),
  UNIQUE (tenant_id, provider_ref)
);

CREATE INDEX payments_tenant_idx ON payments (tenant_id, created_at DESC);
CREATE INDEX payments_unmatched_idx
  ON payments (tenant_id, state)
  WHERE state = 'confirmed' AND invoice_id IS NULL;

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY payments_tenant ON payments
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON payments TO jenga_app;
