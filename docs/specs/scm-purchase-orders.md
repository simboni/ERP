# Implementation Spec — Purchase Orders + Goods Receiving (Jenga ERP)

Module slice: `purchase_orders` + `purchase_order_lines` (draft → sent → received / cancelled), receive flow posting `stock_movements` (reason `purchase`) via `InventoryService.recordMovement`, one-shot conversion to a supplier bill via `BillsService.createDraft`, `reorder_level` on `items`, and a low-stock report. Estimated footprint: ~120 lines SQL, ~330 lines API, ~250 lines web, ~40 lines demo/i18n — under the 800-line budget.

---

## 1) Migration — `db/migrations/0017_purchase_orders.sql` (complete, ready to paste)

```sql
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
```

Note: `stock_movements.reason` already permits `'purchase'` (0009) — no CHECK change needed. Movements immutability trigger already covers receipts.

---

## 2) API

### New files
- `apps/api/src/purchases/purchase-orders.service.ts`
- `apps/api/src/purchases/purchase-orders.controller.ts`

Register in `apps/api/src/app.module.ts`: add `PurchaseOrdersController` to `controllers` (next to `BillsController`, line ~78) and `PurchaseOrdersService` to `providers` (next to `BillsService`, line ~96). `BillsService` and `InventoryService` are already providers — inject both.

### `PurchaseOrdersService` (all methods take `client: PoolClient` and run inside the caller's `db.withTenant` transaction, mirroring `BillsService`)

```ts
export interface PoLineInput {
  itemId: string;
  description?: string;      // defaults to item name
  quantity: number;
  unitCostCents: number;
  vatRate?: "0.16" | "0" | "exempt"; // default item.vat_rate
}

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly bills: BillsService,
    private readonly audit: AuditService,
  ) {}

  async createDraft(client, args: { tenantId; userId; supplierId; branchId; expectedDate?; lines: PoLineInput[] })
  async send(client, args: { tenantId; userId; poId })        // draft -> sent
  async cancel(client, args: { tenantId; userId; poId })      // draft|sent -> cancelled, only if sum(qty_received) = 0
  async receive(client, args: { tenantId; userId; poId; receipts: { lineId: string; qty: number }[] })
  async convertToBill(client, args: { tenantId; userId; poId; billDate?; supplierInvoiceNo?; etimsControlNumber? })
}
```

**`createDraft`** — PO numbering copies `quotes.service.ts` exactly:

```sql
SELECT pg_advisory_xact_lock(hashtext('po-no:' || $1));          -- $1 = tenantId
SELECT coalesce(max(po_no), 0) + 1 AS next FROM purchase_orders WHERE tenant_id = $1;
```

Then insert header, and per line: resolve the item (`SELECT name, vat_rate FROM items WHERE id = $1`, 404 if missing), compute `line_total_cents = Math.round((unitCostCents * Math.round(quantity * 1000)) / 1000)` and `vat_cents = vatRate === "0.16" ? mulRate(totalCents, "0.16") : 0` (same math as `BillsService.createDraft`, import `mulRate` from `../payroll/calculator`), accumulate subtotal/vat, finally `UPDATE purchase_orders SET subtotal_cents=$2, vat_cents=$3, total_cents=$4 WHERE id=$1`. Audit action `po.drafted`.

**`send`** — `SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE`; require `draft`; `UPDATE ... SET status = 'sent'`; audit `po.sent`.

**`cancel`** — lock row; require status `draft` or `sent` AND:

```sql
SELECT coalesce(sum(qty_received), 0) AS rec FROM purchase_order_lines WHERE po_id = $1
```
`rec` must be 0 (a PO with receipts against it can only run to completion). Set `cancelled`; audit `po.cancelled`.

**`receive`** — the tricky one; whole thing in one transaction:

1. `SELECT id, status, branch_id FROM purchase_orders WHERE id = $1 FOR UPDATE` — 404 if missing; require status `'sent'` (`BadRequestException("Only sent POs can receive goods")`).
2. Validate `receipts` non-empty, every `qty > 0`.
3. Per receipt, lock and over-receipt-guard the line:

```sql
SELECT id, item_id, quantity, qty_received, description
FROM purchase_order_lines
WHERE id = $1 AND po_id = $2
FOR UPDATE
```
Reject if row missing or `qty > Number(quantity) - Number(qty_received)` (`BadRequestException(\`Line ${description}: only ${remaining} outstanding\`)`).

4. Post the stock movement through the existing single path (advisory lock + append-only ledger are inside it):

```ts
await this.inventory.recordMovement(client, {
  tenantId, itemId: line.item_id, branchId: po.branch_id,
  qtyDelta: qty, reason: "purchase",
  refType: "purchase_order", refId: args.poId, userId: args.userId,
});
```

5. `UPDATE purchase_order_lines SET qty_received = qty_received + $2 WHERE id = $1`.
6. Flip status when complete:

```sql
UPDATE purchase_orders po SET status = 'received'
WHERE po.id = $1
  AND NOT EXISTS (SELECT 1 FROM purchase_order_lines l
                  WHERE l.po_id = po.id AND l.qty_received < l.quantity)
RETURNING status
```
7. Audit `po.received` with payload `{ receipts: [{lineId, qty}], complete: boolean }`. Return `{ status, receivedLines: n }`.

**`convertToBill`** — lock header:

```sql
SELECT id, status, bill_id, supplier_id FROM purchase_orders WHERE id = $1 FOR UPDATE
```
Require `bill_id IS NULL` (`BadRequestException("PO already has a bill")`) and status `'sent'` or `'received'`. Load lines, then delegate — **no direct ledger code here**:

```ts
const bill = await this.bills.createDraft(client, {
  tenantId, userId, supplierId: po.supplier_id,
  billDate: args.billDate ?? new Date().toISOString().slice(0, 10),
  supplierInvoiceNo: args.supplierInvoiceNo,
  etimsControlNumber: args.etimsControlNumber,
  lines: lines.map((l) => ({
    description: l.description,
    quantity: Number(l.quantity),
    unitPriceCents: Number(l.unit_cost_cents),
    vatRate: l.vat_rate,
    accountCode: "5000",            // COGS/stock purchases (matches purchases.spec.ts usage)
  })),
});
await client.query("UPDATE purchase_orders SET bill_id = $2 WHERE id = $1", [poId, bill.id]);
```
Audit `po.converted_to_bill`. Return `{ billId: bill.id, totalCents: bill.totalCents }`. Approval/payment stay on the existing `bills/:id/approve|pay` routes.

### `PurchaseOrdersController` — `@Controller("tenants/current")`, guards `JwtAuthGuard, TenantContextGuard, RolesGuard`, `PURCHASE_ROLES = ["owner","admin","accountant","storekeeper"]` (same as bills.controller.ts)

| Route | Roles | Body / notes |
|---|---|---|
| `POST purchase-orders` | PURCHASE_ROLES | `{ supplierId, branchId?, expectedDate?, lines: PoLineInput[] }` — validate supplierId + non-empty lines; if `branchId` omitted, `SELECT id FROM branches ORDER BY created_at LIMIT 1` (400 "Create a branch first" if none) |
| `GET purchase-orders` | any member | list query below |
| `GET purchase-orders/:id` | any member | header + lines (`SELECT ... FROM purchase_order_lines WHERE po_id = $1 ORDER BY id`) |
| `POST purchase-orders/:id/send` | PURCHASE_ROLES | — |
| `POST purchase-orders/:id/cancel` | `"owner","admin","accountant"` | — |
| `POST purchase-orders/:id/receive` | PURCHASE_ROLES | `{ receipts: [{ lineId, qty }] }` |
| `POST purchase-orders/:id/convert-to-bill` | `"owner","admin","accountant"` | `{ billDate?, supplierInvoiceNo?, etimsControlNumber? }` |

All `:id` params use `ParseUUIDPipe`. Each POST wraps its service call in `this.db.withTenant(claims.tid, claims.sub, (client) => ...)`.

**List query** (progress without loading lines):

```sql
SELECT po.id, po.po_no, po.status, po.order_date, po.expected_date,
       po.total_cents, po.bill_id, s.name AS supplier_name,
       coalesce(sum(l.quantity), 0)      AS qty_ordered,
       coalesce(sum(l.qty_received), 0)  AS qty_received
FROM purchase_orders po
JOIN suppliers s ON s.id = po.supplier_id
LEFT JOIN purchase_order_lines l ON l.po_id = po.id
GROUP BY po.id, s.name
ORDER BY po.created_at DESC
LIMIT 200
```

### Inventory changes (`inventory.controller.ts` / `inventory.service.ts`)

1. `createItem`: accept optional `reorderLevel?: number` → add `reorder_level` to the INSERT column list/RETURNING (default 0).
2. `listItems`: add `reorder_level` to the SELECT.
3. New route `POST items/:id/reorder-level`, roles `STOCK_ROLES`, body `{ reorderLevel: number }` (reject `< 0`): `UPDATE items SET reorder_level = $2 WHERE id = $1 RETURNING id, sku, reorder_level` (404 on no row).
4. New route `GET stock/low` → `InventoryService.lowStock(client)`:

```sql
SELECT i.id AS item_id, i.sku, i.name, i.unit, i.reorder_level,
       coalesce(sum(sm.qty_delta), 0) AS on_hand,
       coalesce(max(oo.on_order), 0)  AS on_order
FROM items i
LEFT JOIN stock_movements sm ON sm.item_id = i.id
LEFT JOIN (
  SELECT l.item_id, sum(l.quantity - l.qty_received) AS on_order
  FROM purchase_order_lines l
  JOIN purchase_orders po ON po.id = l.po_id
  WHERE po.status = 'sent'
  GROUP BY l.item_id
) oo ON oo.item_id = i.id
WHERE i.track_stock AND i.reorder_level > 0
GROUP BY i.id
HAVING coalesce(sum(sm.qty_delta), 0) <= i.reorder_level
ORDER BY i.sku
```
Return rows with `Number()` casts, plus `shortfall = reorder_level - on_hand`. (On-hand here is tenant-wide across branches, matching the existing `stockLevels` philosophy; RLS scopes everything to the tenant.)

---

## 3) Web

### Nav + i18n
- `apps/web/lib/i18n.tsx`: add to `en`: `navPurchaseOrders: "Purchase orders"`, `lowStock: "Low stock"`; to `sw`: `navPurchaseOrders: "Oda za manunuzi"`, `lowStock: "Bidhaa zinazokaribia kuisha"`.
- `apps/web/components/AppShell.tsx` Operations section, after the purchases entry: `{ href: "/purchase-orders", labelKey: "navPurchaseOrders", icon: "cart" }`.

### New page `apps/web/app/(app)/purchase-orders/page.tsx` (client component, follows hr/page.tsx tab pattern + DataTable)

```ts
type Tab = "orders" | "new" | "lowstock";
```
`<div className="tabs">` with three buttons (`tab active` class pattern). Loads on mount (redirect to `/` if `!getTenantToken()`, like purchases/page.tsx): `GET /tenants/current/purchase-orders`, `/tenants/current/items`, `/tenants/current/suppliers`, `/tenants/current/branches`, `/tenants/current/stock/low`. Shared `act(fn)` busy/error wrapper, `load()` after each action.

**Tab "orders"** — `DataTable<PoRow>` with `searchKeys={["po_no","supplier_name","status"]}`, `csvName="purchase-orders"`, columns:

| key | label | notes |
|---|---|---|
| `po_no` | PO # | `render: (r) => <>PO-{r.po_no}</>`, `value: (r) => Number(r.po_no)` |
| `supplier_name` | Supplier | |
| `order_date` | Date | slice(0,10) |
| `total_cents` | Total | `num`, `render: fmtKes(r.total_cents)`, `value: Number(...)` |
| `progress` | Received | `render:` `{qty_received}/{qty_ordered}`; `value: (r) => Number(r.qty_received)` |
| `status` | Status | pill: `sent` → `pill`, `received` → `pill paid`, `cancelled` → `pill` muted, `draft` → plain `pill` (same classes as purchases page) |
| `actions` | (blank label) | draft → **Send** + **Cancel**; sent → **Receive all** (posts `receive` with every line's outstanding qty, fetched from `GET purchase-orders/:id` first) + **Cancel** (only if `qty_received === 0`) + **Bill** (convert-to-bill, then link text "billed" once `bill_id` set); received → **Bill** if `bill_id === null`, else muted "billed" |

`toolbar`: status `<select>` filter (`all/draft/sent/received/cancelled`) filtering `rows` before passing to DataTable. Per-line partial receiving UI is deliberately minimal: "Receive all outstanding" button only (partial quantities remain API-capable; see out-of-scope).

**Tab "new"** — card form: supplier `<select>`, expected date `<input type="date">`, then a line editor: rows of item `<select>` (from `/items`, showing `sku — name`), qty `<input type="number">`, unit cost KES `<input>` prefilled from the item's `cost_cents / 100` on select, "+ Add line" button appending to a `lines` state array, running KES total footer. Submit → `POST /tenants/current/purchase-orders` with `unitCostCents: Math.round(kes * 100)`, then switch to "orders" tab. Include the purchases-page fallback: call `POST /tenants/current/accounts/seed-defaults` before first submit is **not** needed (no posting on draft) — omit.

**Tab "lowstock"** — tile row on top (`className="tiles"` pattern): "Items below reorder" (count), "Units short" (sum of shortfall), "On order" (sum on_order). Below, `DataTable<LowRow>` `csvName="low-stock"`, columns: SKU, Name, On hand (`num`), Reorder level (`num`), On order (`num`), Shortfall (`num`, bold when `on_order < shortfall`), and an action column with a **Reorder** button that pre-fills the "new" tab with that item (qty = shortfall, switch tab). Empty state: `"No items below their reorder level. Set reorder levels on the Inventory page."`

### Inventory page touch (`apps/web/app/(app)/inventory/page.tsx`)
Add a "Reorder lvl" column to the items table: inline `<input type="number">` + small save button calling `POST /tenants/current/items/:id/reorder-level`. (~15 lines.)

---

## 4) Tests — `apps/api/test/purchase-orders.spec.ts` (bootstrap copied from purchases.spec.ts: `create_tenant_with_owner`, `seedDefaultAccounts`, one supplier, one branch, two tracked items)

1. **Draft → send → receive posts stock and completes.** Create PO with 2 lines (item A qty 10 @ 30000c 16%, item B qty 4 @ 50000c 16%); assert `total_cents` = 580 000 net + 92 800 VAT = 672 800. Send. Receive all. Assert: two `stock_movements` rows with `reason='purchase'`, `ref_type='purchase_order'`, `ref_id=poId`, correct `qty_delta`; on-hand sums = 10 and 4; PO status `received`; `qty_received = quantity` on both lines.
2. **Partial receive keeps status `sent` and blocks over-receipt.** Receive 6 of item A only → status still `sent`, `qty_received=6`. Receiving 5 more of A rejects (`BadRequestException`, only 4 outstanding); receiving on a `draft` PO rejects.
3. **Convert-to-bill is once-only and books balance.** Convert the fully received PO → bill exists in `draft` with matching `total_cents`, lines carry `account_code='5000'`, `purchase_orders.bill_id` set. Second convert call rejects. Approve the bill via `BillsService.approve` → journal lines DR 5000 net / DR 1300 VAT / CR 2100 total; `SELECT sum(debit_cents) = sum(credit_cents)` over the tenant's journal.
4. **Cancel guard.** Cancel a fresh `sent` PO with zero receipts → `cancelled`; cancelling the partially received PO from test 2 rejects; cancelled PO refuses `receive` and `convert-to-bill`.
5. **RLS isolation + low stock.** Second tenant sees zero rows in `purchase_orders`/`purchase_order_lines`. Set item A `reorder_level = 100` (on-hand 10) → `lowStock` returns it with `on_hand=10`, and after creating a new `sent` PO for 50 units, `on_order=50`; item B (`reorder_level=0`) absent.

---

## 5) Demo data (`apps/api/src/tenants/demo-data.controller.ts`, inside `seed()`)

- Add `purchaseOrders: 0` to `counts`.
- In section 1's item loop, set reorder levels: change the items INSERT to include `reorder_level` = `int(50, 300)` (leaves some items below reorder given opening stock 500–2000 minus sales; guarantees a non-empty low-stock report after the sales section drains stock — additionally force 3 items to `reorder_level = 2500` so the report is never empty).
- New section 5b (after bills, before expenses), 15 POs, each in its own `withTenant` transaction inside try/catch like invoices:
  - lines: 1–3 random items, `quantity: int(20, 200)`, `unitCostCents:` the item's cost, `vatRate: "0.16"`, via `PurchaseOrdersService.createDraft` (inject `PurchaseOrdersService` into the controller constructor);
  - ~85% `send()`; of those, half fully `receive()` (all outstanding), a quarter partially receive (half of each line); a third of received ones `convertToBill()` with `supplierInvoiceNo: \`SUP-PO-${int(1000,9999)}\``;
  - one PO cancelled from `sent`;
  - increment `counts.purchaseOrders` and `counts.stockMovements` per receipt line.

---

## 6) Out of scope (explicit)

- **No ledger posting at PO or receipt time** — no GRNI/accrual account; financial recognition happens only via the existing bill approve path. (Perpetual-inventory GL valuation is a separate pillar.)
- **No PO PDF / email to supplier** — `sent` is a status flip only.
- **No per-line partial-receipt UI** — the web page receives all outstanding; the API supports arbitrary per-line quantities for a future GRN screen.
- **No price variance handling** — convert-to-bill copies PO unit costs verbatim; a differing supplier invoice is edited as a bill concern, not reconciled against the PO.
- **No multi-branch receiving per PO** — one `branch_id` per PO header.
- **No supplier returns / negative receipts** — use stock `adjustment` movements.
- **No approval workflow on POs** (maker-checker stays on bills), no budget checks, no item auto-reorder job/notification — the low-stock report is pull-only.
- **No backorder auto-close** — a partially received PO stays `sent` until fully received or manually cancelled is impossible after first receipt (it simply stays open).