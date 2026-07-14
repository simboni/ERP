/**
 * Ledger + invoicing integration tests against jenga_test:
 *  - postings balance or the DATABASE rejects them (deferred trigger),
 *  - journal immutability, idempotent posting, entry numbering,
 *  - invoice lifecycle: draft -> issue posts DR AR / CR Sales / CR VAT,
 *    enqueues eTIMS fiscalization, assigns invoice numbers,
 *  - trial balance nets to zero.
 */
import { randomUUID } from "node:crypto";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { FiscalService } from "../src/fiscal/fiscal.service";
import { SandboxFiscalProvider } from "../src/fiscal/provider";
import {
  LedgerService,
  seedDefaultAccounts,
} from "../src/ledger/ledger.service";
import { InvoicesService } from "../src/invoicing/invoices.service";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("ledger + invoicing", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const fiscal = new FiscalService(new SandboxFiscalProvider());
  const invoices = new InvoicesService(ledger, fiscal, audit);

  let tenant: string;
  let user: string;
  let branch: string;
  let customer: string;

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'Ledger Tester') RETURNING id`,
      [`ledger-${suffix}@test.local`],
    );
    user = u.rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["ledger-co", `ledger-co-${suffix}`, user],
    );
    tenant = t.rows[0].id;
    await db.withTenant(tenant, user, async (c) => {
      await seedDefaultAccounts(c, tenant);
      const b = await c.query(
        `INSERT INTO branches (tenant_id, code, name)
         VALUES ($1, 'HQ', 'Head Office') RETURNING id`,
        [tenant],
      );
      branch = b.rows[0].id;
      const cu = await c.query(
        `INSERT INTO customers (tenant_id, name, kra_pin)
         VALUES ($1, 'Mama Mboga Ltd', 'P051234567X') RETURNING id`,
        [tenant],
      );
      customer = cu.rows[0].id;
    });
  });

  afterAll(async () => {
    await fiscal.onModuleDestroy();
    await db.onModuleDestroy();
  });

  test("balanced posting succeeds and numbers sequentially", async () => {
    const first = await db.withTenant(tenant, user, (c) =>
      ledger.post(c, {
        tenantId: tenant,
        postedBy: user,
        entryDate: "2026-07-14",
        memo: "Owner capital",
        sourceType: "manual",
        idempotencyKey: "cap-1",
        lines: [
          { accountCode: "1020", debitCents: 10_000_000 },
          { accountCode: "3000", creditCents: 10_000_000 },
        ],
      }),
    );
    expect(first.entryNo).toBe(1);
    expect(first.deduplicated).toBe(false);

    const again = await db.withTenant(tenant, user, (c) =>
      ledger.post(c, {
        tenantId: tenant,
        postedBy: user,
        entryDate: "2026-07-14",
        memo: "Owner capital (retry)",
        sourceType: "manual",
        idempotencyKey: "cap-1",
        lines: [
          { accountCode: "1020", debitCents: 10_000_000 },
          { accountCode: "3000", creditCents: 10_000_000 },
        ],
      }),
    );
    expect(again.deduplicated).toBe(true);
    expect(again.entryId).toBe(first.entryId);
  });

  test("service rejects unbalanced input", async () => {
    await expect(
      db.withTenant(tenant, user, (c) =>
        ledger.post(c, {
          tenantId: tenant,
          postedBy: user,
          entryDate: "2026-07-14",
          memo: "bad",
          sourceType: "manual",
          idempotencyKey: "bad-1",
          lines: [
            { accountCode: "1020", debitCents: 500 },
            { accountCode: "3000", creditCents: 400 },
          ],
        }),
      ),
    ).rejects.toThrow(/Unbalanced/);
  });

  test("DATABASE rejects unbalanced entries even via raw SQL", async () => {
    await expect(
      db.withTenant(tenant, user, async (c) => {
        const e = await c.query(
          `INSERT INTO journal_entries
             (tenant_id, entry_no, entry_date, source_type, idempotency_key)
           VALUES ($1, 999, '2026-07-14', 'manual', 'raw-evil') RETURNING id`,
          [tenant],
        );
        await c.query(
          `INSERT INTO journal_lines (tenant_id, entry_id, account_id, debit_cents)
           SELECT $1, $2, id, 12345 FROM accounts WHERE code = '1000'`,
          [tenant, e.rows[0].id],
        );
        // no matching credit — the deferred trigger must abort the COMMIT
      }),
    ).rejects.toThrow(/unbalanced/i);
  });

  test("journal is immutable", async () => {
    await expect(
      db.withTenant(tenant, user, (c) =>
        c.query("UPDATE journal_entries SET memo = 'rewrite history'"),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      db.withTenant(tenant, user, (c) => c.query("DELETE FROM journal_lines")),
    ).rejects.toThrow(/permission denied/i);
  });

  test("invoice lifecycle: draft -> issue -> ledger + fiscal, atomically", async () => {
    const draft = await db.withTenant(tenant, user, (c) =>
      invoices.createDraft(c, {
        tenantId: tenant,
        userId: user,
        branchId: branch,
        customerId: customer,
        lines: [
          {
            description: "Unga wa dola 2kg",
            quantity: 10,
            unitPriceCents: 20_000, // 200.00 each, VATable
            vatRate: "0.16",
          },
          {
            description: "Maziwa (zero-rated)",
            quantity: 5,
            unitPriceCents: 6_000, // 60.00 each
            vatRate: "0",
          },
        ],
      }),
    );

    const issued = await db.withTenant(tenant, user, (c) =>
      invoices.issue(c, {
        tenantId: tenant,
        userId: user,
        invoiceId: draft.id,
        issueDate: "2026-07-14",
      }),
    );
    // subtotal 2,000 + 300 = 2,300.00; VAT 16% of 2,000 = 320.00; total 2,620.00
    expect(issued.invoiceNo).toBe(1);
    expect(issued.totalCents).toBe(262_000);

    const inv = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        `SELECT status, subtotal_cents, vat_cents, total_cents,
                journal_entry_id, fiscal_document_id
         FROM invoices WHERE id = $1`,
        [draft.id],
      );
      return r.rows[0];
    });
    expect(inv.status).toBe("issued");
    expect(Number(inv.subtotal_cents)).toBe(230_000);
    expect(Number(inv.vat_cents)).toBe(32_000);

    // Ledger entry: DR AR 2,620 / CR Sales 2,300 / CR VAT 320.
    const lines = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        `SELECT a.code, jl.debit_cents, jl.credit_cents
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
         WHERE jl.entry_id = $1 ORDER BY a.code`,
        [inv.journal_entry_id],
      );
      return r.rows.map((x) => ({
        code: x.code,
        d: Number(x.debit_cents),
        c: Number(x.credit_cents),
      }));
    });
    expect(lines).toEqual([
      { code: "1100", d: 262_000, c: 0 },
      { code: "2200", d: 0, c: 32_000 },
      { code: "4000", d: 0, c: 230_000 },
    ]);

    // Fiscal doc enqueued with the invoice payload; worker signs it. The
    // queue is shared with other suites' leftovers, so drain until OUR doc
    // leaves the pending/signing states.
    for (let i = 0; i < 50; i++) {
      const status = await db.withTenant(tenant, user, async (c) => {
        const r = await c.query(
          "SELECT status FROM fiscal_documents WHERE id = $1",
          [inv.fiscal_document_id],
        );
        return r.rows[0].status as string;
      });
      if (status !== "pending" && status !== "signing") break;
      await fiscal.processOnce();
    }
    const fdoc = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        `SELECT status, control_number, payload FROM fiscal_documents WHERE id = $1`,
        [inv.fiscal_document_id],
      );
      return r.rows[0];
    });
    expect(fdoc.status).toBe("signed");
    expect(fdoc.control_number).toMatch(/^SBX/);
    expect(fdoc.payload.buyer.kra_pin).toBe("P051234567X");
    expect(fdoc.payload.totalCents).toBe(262_000);

    // Issuing twice fails cleanly.
    await expect(
      db.withTenant(tenant, user, (c) =>
        invoices.issue(c, {
          tenantId: tenant,
          userId: user,
          invoiceId: draft.id,
          issueDate: "2026-07-14",
        }),
      ),
    ).rejects.toThrow(/Only draft/);
  });

  test("trial balance nets to zero across all postings", async () => {
    const tb = await db.withTenant(tenant, user, (c) => ledger.trialBalance(c));
    const net = tb.reduce((s, a) => s + a.balanceCents, 0);
    expect(net).toBe(0);
    const ar = tb.find((a) => a.code === "1100");
    expect(ar?.balanceCents).toBe(262_000);
  });

  test("second tenant sees no accounts, entries or invoices", async () => {
    const suffix = randomUUID().slice(0, 8);
    const t2 = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["ledger-other", `ledger-other-${suffix}`, user],
    );
    const other = t2.rows[0].id;
    await db.withTenant(other, user, async (c) => {
      for (const table of ["accounts", "journal_entries", "journal_lines", "invoices", "customers"]) {
        const r = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect({ table, n: r.rows[0].n }).toEqual({ table, n: 0 });
      }
    });
  });
});
