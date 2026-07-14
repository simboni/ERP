-- 0009: Inventory — items catalogue and per-branch stock movements.
-- Movements are an append-only quantity ledger (same philosophy as the
-- journal); stock on hand is always the sum of movements, never a mutable
-- counter that can drift.

CREATE TABLE items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  sku         text NOT NULL,
  name        text NOT NULL,
  unit        text NOT NULL DEFAULT 'pcs',
  cost_cents  bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  price_cents bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  vat_rate    text NOT NULL DEFAULT '0.16',
  track_stock boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
CREATE POLICY items_tenant ON items
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TABLE stock_movements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  item_id      uuid NOT NULL REFERENCES items (id),
  branch_id    uuid NOT NULL REFERENCES branches (id),
  qty_delta    numeric(12,3) NOT NULL CHECK (qty_delta <> 0),
  reason       text NOT NULL CHECK (reason IN
               ('purchase', 'sale', 'adjustment', 'transfer_in', 'transfer_out')),
  ref_type     text,
  ref_id       text,
  created_by   uuid REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stock_movements_item_idx
  ON stock_movements (tenant_id, item_id, branch_id);

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movements_read ON stock_movements FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE POLICY stock_movements_insert ON stock_movements FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TRIGGER stock_movements_no_rewrite
  BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Invoice lines may reference a catalogue item (stock + COGS on issue).
ALTER TABLE invoice_lines ADD COLUMN item_id uuid REFERENCES items (id);

GRANT SELECT, INSERT, UPDATE ON items TO jenga_app;
GRANT SELECT, INSERT ON stock_movements TO jenga_app;
