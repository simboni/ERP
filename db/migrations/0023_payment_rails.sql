-- Manual invoice reconciliation needs more rails than the M-Pesa/cash
-- origins the payments table was born with. Allow bank transfers/cheques
-- and hand-keyed M-Pesa amounts so an invoice can be settled by any
-- channel (and in instalments across channels).
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_rail_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_rail_check
  CHECK (rail IN ('mpesa_stk', 'mpesa_c2b', 'mpesa', 'cash', 'bank'));
