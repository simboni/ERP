/**
 * Purchase orders: draft -> send -> receive posts stock; over-receipt and
 * cancel guards; once-only bill conversion that balances; low-stock report.
 */
import { randomUUID } from "node:crypto";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { ControlsService } from "../src/controls/controls.service";
import { InventoryService } from "../src/inventory/inventory.service";
import { LedgerService, seedDefaultAccounts } from "../src/ledger/ledger.service";
import { SandboxPayoutProvider } from "../src/payments/payout.provider";
import { BillsService } from "../src/purchases/bills.service";
import { PurchaseOrdersService } from "../src/purchases/purchase-orders.service";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("purchase orders", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const inventory = new InventoryService();
  // No approval_policies rows exist in these fixtures, so the controls
  // gate is a no-op here.
  const controls = new ControlsService(db, audit);
  const bills = new BillsService(
    ledger,
    audit,
    new SandboxPayoutProvider(),
    db,
    controls,
  );
  const pos = new PurchaseOrdersService(inventory, bills, audit, controls);

  let tenant: string;
  let user: string;
  let branch: string;
  let supplier: string;
  let itemA: string;
  let itemB: string;
  let poId: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'PO Tester') RETURNING id`,
      [`po-${suffix}@test.local`],
    );
    user = u.rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["po-co", `po-co-${suffix}`, user],
    );
    tenant = t.rows[0].id;
    await db.withTenant(tenant, user, async (c) => {
      await seedDefaultAccounts(c, tenant);
      branch = (
        await c.query(
          `INSERT INTO branches (tenant_id, code, name)
           VALUES ($1, 'HQ', 'HQ') RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
      supplier = (
        await c.query(
          `INSERT INTO suppliers (tenant_id, name)
           VALUES ($1, 'PO Supplies Ltd') RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
      itemA = (
        await c.query(
          `INSERT INTO items (tenant_id, sku, name, cost_cents, price_cents)
           VALUES ($1, 'PO-A', 'Item A', 30000, 45000) RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
      itemB = (
        await c.query(
          `INSERT INTO items (tenant_id, sku, name, cost_cents, price_cents)
           VALUES ($1, 'PO-B', 'Item B', 50000, 70000) RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
    });
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it("draft -> send -> receive posts stock and completes", async () => {
    const draft = await db.withTenant(tenant, user, (c) =>
      pos.createDraft(c, {
        tenantId: tenant,
        userId: user,
        supplierId: supplier,
        branchId: branch,
        lines: [
          { itemId: itemA, quantity: 10, unitCostCents: 30000 },
          { itemId: itemB, quantity: 4, unitCostCents: 50000 },
        ],
      }),
    );
    poId = draft.id;
    // net 10*300 + 4*500 = 5000 KES = 500000c; VAT 16% = 80000c
    expect(draft.totalCents).toBe(580000);

    await db.withTenant(tenant, user, (c) =>
      pos.send(c, { tenantId: tenant, userId: user, poId }),
    );
    const lines = await db.withTenant(tenant, user, async (c) =>
      (
        await c.query(
          "SELECT id, item_id, quantity FROM purchase_order_lines WHERE po_id = $1 ORDER BY line_total_cents DESC",
          [poId],
        )
      ).rows,
    );
    const result = await db.withTenant(tenant, user, (c) =>
      pos.receive(c, {
        tenantId: tenant,
        userId: user,
        poId,
        receipts: lines.map((l: { id: string; quantity: string }) => ({
          lineId: l.id,
          qty: Number(l.quantity),
        })),
      }),
    );
    expect(result.status).toBe("received");

    await db.withTenant(tenant, user, async (c) => {
      const mv = await c.query(
        `SELECT item_id, qty_delta FROM stock_movements
         WHERE ref_type = 'purchase_order' AND ref_id = $1`,
        [poId],
      );
      expect(mv.rows).toHaveLength(2);
      const onHandA = await c.query(
        "SELECT coalesce(sum(qty_delta),0) AS q FROM stock_movements WHERE item_id = $1",
        [itemA],
      );
      expect(Number(onHandA.rows[0].q)).toBe(10);
    });
  });

  it("blocks over-receipt and receiving on drafts", async () => {
    const po2 = await db.withTenant(tenant, user, (c) =>
      pos.createDraft(c, {
        tenantId: tenant,
        userId: user,
        supplierId: supplier,
        branchId: branch,
        lines: [{ itemId: itemA, quantity: 10, unitCostCents: 30000 }],
      }),
    );
    // draft cannot receive
    await expect(
      db.withTenant(tenant, user, async (c) => {
        const line = (
          await c.query(
            "SELECT id FROM purchase_order_lines WHERE po_id = $1",
            [po2.id],
          )
        ).rows[0];
        return pos.receive(c, {
          tenantId: tenant,
          userId: user,
          poId: po2.id,
          receipts: [{ lineId: line.id, qty: 1 }],
        });
      }),
    ).rejects.toThrow(/Only sent/);

    await db.withTenant(tenant, user, (c) =>
      pos.send(c, { tenantId: tenant, userId: user, poId: po2.id }),
    );
    const line = await db.withTenant(tenant, user, async (c) =>
      (
        await c.query(
          "SELECT id FROM purchase_order_lines WHERE po_id = $1",
          [po2.id],
        )
      ).rows[0],
    );
    const partial = await db.withTenant(tenant, user, (c) =>
      pos.receive(c, {
        tenantId: tenant,
        userId: user,
        poId: po2.id,
        receipts: [{ lineId: line.id, qty: 6 }],
      }),
    );
    expect(partial.status).toBe("sent"); // not complete yet
    await expect(
      db.withTenant(tenant, user, (c) =>
        pos.receive(c, {
          tenantId: tenant,
          userId: user,
          poId: po2.id,
          receipts: [{ lineId: line.id, qty: 5 }],
        }),
      ),
    ).rejects.toThrow(/only 4 outstanding/);
    // partially received PO cannot be cancelled
    await expect(
      db.withTenant(tenant, user, (c) =>
        pos.cancel(c, { tenantId: tenant, userId: user, poId: po2.id }),
      ),
    ).rejects.toThrow(/received goods/);
  });

  it("converts to a balanced bill exactly once", async () => {
    const conv = await db.withTenant(tenant, user, (c) =>
      pos.convertToBill(c, {
        tenantId: tenant,
        userId: user,
        poId,
        supplierInvoiceNo: "SUP-42",
      }),
    );
    expect(conv.totalCents).toBe(580000);
    await expect(
      db.withTenant(tenant, user, (c) =>
        pos.convertToBill(c, { tenantId: tenant, userId: user, poId }),
      ),
    ).rejects.toThrow(/already has a bill/);

    await db.withTenant(tenant, user, (c) =>
      bills.approve(c, { tenantId: tenant, userId: user, billId: conv.billId }),
    );
    await db.withTenant(tenant, user, async (c) => {
      const sums = await c.query(
        `SELECT sum(jl.debit_cents)::bigint AS d, sum(jl.credit_cents)::bigint AS cr
         FROM journal_lines jl`,
      );
      expect(Number(sums.rows[0].d)).toBe(Number(sums.rows[0].cr));
    });
  });

  it("cancels clean sent POs and reports low stock with on-order", async () => {
    const po3 = await db.withTenant(tenant, user, (c) =>
      pos.createDraft(c, {
        tenantId: tenant,
        userId: user,
        supplierId: supplier,
        branchId: branch,
        lines: [{ itemId: itemB, quantity: 3, unitCostCents: 50000 }],
      }),
    );
    await db.withTenant(tenant, user, (c) =>
      pos.send(c, { tenantId: tenant, userId: user, poId: po3.id }),
    );
    const cancelled = await db.withTenant(tenant, user, (c) =>
      pos.cancel(c, { tenantId: tenant, userId: user, poId: po3.id }),
    );
    expect(cancelled.status).toBe("cancelled");

    // Low stock: itemA on hand 10 + 6 = 16; set reorder above it.
    await db.withTenant(tenant, user, (c) =>
      c.query("UPDATE items SET reorder_level = 100 WHERE id = $1", [itemA]),
    );
    const low = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        `SELECT i.id, coalesce(sum(sm.qty_delta),0) AS on_hand
         FROM items i LEFT JOIN stock_movements sm ON sm.item_id = i.id
         WHERE i.reorder_level > 0 AND i.id = $1 GROUP BY i.id`,
        [itemA],
      );
      return r.rows[0];
    });
    expect(Number(low.on_hand)).toBe(16);
  });
});
