-- 0011: Partial payments. Invoices track how much has been allocated;
-- 'paid' means fully covered. Real Kenyan trade runs on instalments.
ALTER TABLE invoices
  ADD COLUMN amount_paid_cents bigint NOT NULL DEFAULT 0
  CHECK (amount_paid_cents >= 0);

-- Backfill: previously-paid invoices were always fully covered.
UPDATE invoices SET amount_paid_cents = total_cents WHERE status = 'paid';
