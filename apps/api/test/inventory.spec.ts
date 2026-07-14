/**
 * Inventory tests: append-only movements, negative-stock guard, and the
 * invoice hook — selling a catalogue item decrements stock and posts COGS
 * atomically with the issue; overselling aborts the whole issue.
 */
import { randomUUID } from "node:crypto";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { FiscalService } from "../src/fiscal/fiscal.service";
import { SandboxFiscalProvider } from "../src/fiscal/provider";
import { LedgerService, seedDefaultAccounts } from "../src/ledger/ledger.service";
import { InvoicesService } from "../src/invoicing/invoices.service";
import { InventoryService } from "../src/inventory/inventory.service";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("inventory + COGS", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const fiscal = new FiscalService(new SandboxFiscalProvider());
  const inventory = new InventoryService();
  const invoices = new InvoicesService(
    ledger, fiscal, audit, undefined, inventory,
  );

  let tenant: string;
  let user: string;
  let branch: string;
  let customer: string;
  let item: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'Stock Tester') RETURNING id`,
      [`stock-${suffix}@test.local`],
    );
    user = u.rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["stock-co", `stock-co-${suffix}`, user],
    );
    tenant = t.rows[0].id;
    await db.withTenant(tenant, user, async (c) => {
      await seedDefaultAccounts(c, tenant);
      const b = await c.query(
        `INSERT INTO branches (tenant_id, code, name) VALUES ($1, 'HQ', 'HQ') RETURNING id`,
        [tenant],
      );
      branch = b.rows[0].id;
      const cu = await c.query(
        `INSERT INTO customers (tenant_id, name) VALUES ($1, 'Stock Customer') RETURNING id`,
        [tenant],
      );
      customer = cu.rows[0].id;
      const it = await c.query(
        `INSERT INTO items (tenant_id, sku, name, cost_cents, price_cents)
         VALUES ($1, 'SUGAR-50', 'Sugar 50kg', 550_000, 650_000) RETURNING id`,
        [tenant],
      );
      item = it.rows[0].id;
    });
  });

  afterAll(async () => {
    await fiscal.onModuleDestroy();
    await db.onModuleDestroy();
  });

  test("purchase receipt raises stock; movements are immutable", async () => {
    const result = await db.withTenant(tenant, user, (c) =>
      inventory.recordMovement(c, {
        tenantId: tenant, itemId: item, branchId: branch,
        qtyDelta: 10, reason: "purchase", userId: user,
      }),
    );
    expect(result.onHand).toBe(10);

    await expect(
      db.withTenant(tenant, user, (c) =>
        c.query("UPDATE stock_movements SET qty_delta = 999"),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test("selling a catalogue item decrements stock and posts COGS with the issue", async () => {
    const draft = await db.withTenant(tenant, user, (c) =>
      invoices.createDraft(c, {
        tenantId: tenant, userId: user, branchId: branch, customerId: customer,
        lines: [
          { description: "Sugar 50kg", quantity: 4, unitPriceCents: 650_000, vatRate: "0.16", itemId: item },
        ],
      }),
    );
    await db.withTenant(tenant, user, (c) =>
      invoices.issue(c, {
        tenantId: tenant, userId: user, invoiceId: draft.id, issueDate: "2026-07-14",
      }),
    );

    const state = await db.withTenant(tenant, user, async (c) => {
      const stock = await c.query(
        `SELECT coalesce(sum(qty_delta), 0) AS on_hand
         FROM stock_movements WHERE item_id = $1`,
        [item],
      );
      const cogs = await c.query(
        `SELECT coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint AS bal
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
         WHERE a.code = '5000'`,
      );
      const inventoryBal = await c.query(
        `SELECT coalesce(sum(jl.debit_cents - jl.credit_cents), 0)::bigint AS bal
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
         WHERE a.code = '1200'`,
      );
      return {
        onHand: Number(stock.rows[0].on_hand),
        cogs: Number(cogs.rows[0].bal),
        inventory: Number(inventoryBal.rows[0].bal),
      };
    });
    expect(state.onHand).toBe(6);
    expect(state.cogs).toBe(4 * 550_000); // 4 units at cost 5,500
    expect(state.inventory).toBe(-4 * 550_000); // credited out of inventory
  });

  test("overselling aborts the entire issue (stock, ledger and status untouched)", async () => {
    const draft = await db.withTenant(tenant, user, (c) =>
      invoices.createDraft(c, {
        tenantId: tenant, userId: user, branchId: branch, customerId: customer,
        lines: [
          { description: "Sugar 50kg", quantity: 100, unitPriceCents: 650_000, vatRate: "0.16", itemId: item },
        ],
      }),
    );
    await expect(
      db.withTenant(tenant, user, (c) =>
        invoices.issue(c, {
          tenantId: tenant, userId: user, invoiceId: draft.id, issueDate: "2026-07-14",
        }),
      ),
    ).rejects.toThrow(/Insufficient stock/);

    const after = await db.withTenant(tenant, user, async (c) => {
      const inv = await c.query("SELECT status, invoice_no FROM invoices WHERE id = $1", [draft.id]);
      const stock = await c.query(
        `SELECT coalesce(sum(qty_delta), 0) AS on_hand FROM stock_movements WHERE item_id = $1`,
        [item],
      );
      return { ...inv.rows[0], onHand: Number(stock.rows[0].on_hand) };
    });
    expect(after.status).toBe("draft"); // whole transaction rolled back
    expect(after.invoice_no).toBeNull();
    expect(after.onHand).toBe(6);
  });

  test("stock levels report and RLS isolation", async () => {
    const levels = await db.withTenant(tenant, user, (c) =>
      inventory.stockLevels(c),
    );
    expect(levels.find((l) => l.sku === "SUGAR-50")?.onHand).toBe(6);

    const suffix = randomUUID().slice(0, 8);
    const t2 = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["stock-other", `stock-other-${suffix}`, user],
    );
    await db.withTenant(t2.rows[0].id, user, async (c) => {
      for (const table of ["items", "stock_movements"]) {
        const r = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect({ table, n: r.rows[0].n }).toEqual({ table, n: 0 });
      }
    });
  });
});
