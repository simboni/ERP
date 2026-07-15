-- 0017: Purchase orders + goods receiving. A PO is a commercial commitment,
-- not an accounting event: nothing posts to the ledger until goods are
-- received (stock_movements, reason 'purchase') and the supplier bill is
-- drafted/approved through the existing bills path. qty_received is a
-- cached progress counter; the movement ledger stays the source of truth.

CREATE TABLE purchase_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  branch_id      uuid NOT NULL REFERENCES branches (id),
  supplier_id    uuid NOT NULL REFERENCES suppliers (id),
  po_no          bigint NOT NULL,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'sent', 'received', 'cancelled')),
  order_date     date NOT NULL DEFAULT current_date,
  expected_date  date,
  subtotal_cents bigint NOT NULL DEFAULT 0,
  vat_cents      bigint NOT NULL DEFAULT 0,
  total_cents    bigint NOT NULL DEFAULT 0,
  bill_id        uuid REFERENCES bills (id), -- set once on convert-to-bill
  created_by     uuid REFERENCES users (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, po_no)
);

CREATE INDEX purchase_orders_tenant_idx
  ON purchase_orders (tenant_id, created_at DESC);

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_orders_tenant ON purchase_orders
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TABLE purchase_order_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  po_id            uuid NOT NULL REFERENCES purchase_orders (id),
  item_id          uuid NOT NULL REFERENCES items (id), -- receiving posts stock, so every line is a catalogue item
  description      text NOT NULL,
  quantity         numeric(12,3) NOT NULL CHECK (quantity > 0),
  qty_received     numeric(12,3) NOT NULL DEFAULT 0
                   CHECK (qty_received >= 0 AND qty_received <= quantity),
  unit_cost_cents  bigint NOT NULL CHECK (unit_cost_cents >= 0),
  vat_rate         text NOT NULL DEFAULT '0.16',
  line_total_cents bigint NOT NULL,
  vat_cents        bigint NOT NULL DEFAULT 0
);

CREATE INDEX purchase_order_lines_po_idx
  ON purchase_order_lines (tenant_id, po_id);
CREATE INDEX purchase_order_lines_item_idx
  ON purchase_order_lines (tenant_id, item_id);

ALTER TABLE purchase_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_order_lines_tenant ON purchase_order_lines
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Reorder point: low-stock report fires when on-hand <= reorder_level (> 0).
ALTER TABLE items ADD COLUMN reorder_level numeric(12,3) NOT NULL DEFAULT 0
  CHECK (reorder_level >= 0);

GRANT SELECT, INSERT, UPDATE ON purchase_orders TO jenga_app;
GRANT SELECT, INSERT, UPDATE ON purchase_order_lines TO jenga_app;
