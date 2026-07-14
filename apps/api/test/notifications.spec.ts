/**
 * Notification fabric tests: template rendering, atomic enqueue with the
 * business event, two-phase send with retry/dead-letter, and the
 * invoice-issued + payment-received hooks firing end to end.
 */
import { randomUUID } from "node:crypto";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import { FiscalService } from "../src/fiscal/fiscal.service";
import { SandboxFiscalProvider } from "../src/fiscal/provider";
import { LedgerService, seedDefaultAccounts } from "../src/ledger/ledger.service";
import { InvoicesService } from "../src/invoicing/invoices.service";
import { PaymentsService } from "../src/payments/payments.service";
import { SandboxPaymentProvider } from "../src/payments/provider";
import {
  NotificationsService,
  SandboxNotificationProvider,
} from "../src/notifications/notifications.service";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("notification fabric", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const fiscal = new FiscalService(new SandboxFiscalProvider());
  const notifyProvider = new SandboxNotificationProvider();
  const notifications = new NotificationsService(notifyProvider);
  const invoices = new InvoicesService(ledger, fiscal, audit, notifications);
  const payments = new PaymentsService(
    db, ledger, audit, new SandboxPaymentProvider(), notifications,
  );

  const shortcode = String(700000 + Math.floor(Math.random() * 99999));
  const runId = randomUUID().slice(0, 6).toUpperCase();
  let tenant: string;
  let user: string;
  let branch: string;
  let customer: string;

  const drainNotifications = async (targetIds: string[]): Promise<void> => {
    for (let i = 0; i < 50; i++) {
      const res = await db.withTenant(tenant, user, async (c) => {
        const r = await c.query(
          `SELECT count(*)::int AS n FROM notifications
           WHERE id = ANY($1) AND status IN ('pending', 'sending')`,
          [targetIds],
        );
        return r.rows[0].n;
      });
      if (res === 0) return;
      await notifications.processOnce();
    }
  };

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'Notify Tester') RETURNING id`,
      [`notify-${suffix}@test.local`],
    );
    user = u.rows[0].id;
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["Notify Traders", `notify-co-${suffix}`, user],
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
        `INSERT INTO customers (tenant_id, name, phone)
         VALUES ($1, 'SMS Customer', '254733111222') RETURNING id`,
        [tenant],
      );
      customer = cu.rows[0].id;
      await payments.registerShortcode(c, tenant, shortcode);
    });
  });

  afterAll(async () => {
    await notifications.onModuleDestroy();
    await fiscal.onModuleDestroy();
    await db.onModuleDestroy();
  });

  test("template rendering and unknown-template guard", () => {
    const body = notifications.render("deadline_reminder", {
      businessName: "Duka",
      label: "VAT3",
      dueDate: "2026-08-20",
      daysRemaining: 5,
    });
    expect(body).toContain("VAT3 due 2026-08-20 (5 days)");
    expect(() => notifications.render("nope", {})).toThrow(/Unknown template/);
  });

  test("invoice issue enqueues customer SMS; payment reconciliation enqueues receipt SMS", async () => {
    const draft = await db.withTenant(tenant, user, (c) =>
      invoices.createDraft(c, {
        tenantId: tenant, userId: user, branchId: branch, customerId: customer,
        lines: [{ description: "Goods", quantity: 1, unitPriceCents: 100_000, vatRate: "0.16" }],
      }),
    );
    const issued = await db.withTenant(tenant, user, (c) =>
      invoices.issue(c, {
        tenantId: tenant, userId: user, invoiceId: draft.id, issueDate: "2026-07-14",
      }),
    );

    await payments.handleC2bConfirmation({
      TransID: `NTF${runId}R1`,
      TransAmount: "1160.00",
      BusinessShortCode: shortcode,
      BillRefNumber: `INV-${issued.invoiceNo}`,
      MSISDN: "254733111222",
    });

    const queued = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        `SELECT id, template_key, recipient, rendered, status
         FROM notifications ORDER BY created_at`,
      );
      return r.rows;
    });
    expect(queued.map((q) => q.template_key)).toEqual([
      "invoice_issued",
      "payment_received",
    ]);
    expect(queued[0].recipient).toBe("254733111222");
    expect(queued[0].rendered).toContain(`Invoice #${issued.invoiceNo} for KES 1160.00`);
    expect(queued[1].rendered).toContain("PAID");

    await drainNotifications(queued.map((q) => q.id));
    const sent = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        `SELECT status, provider_ref FROM notifications WHERE id = ANY($1)`,
        [queued.map((q) => q.id)],
      );
      return r.rows;
    });
    expect(sent.every((s) => s.status === "sent" && s.provider_ref)).toBe(true);
  });

  test("undeliverable recipient retries with backoff, not silent loss", async () => {
    const id = await db.withTenant(tenant, user, (c) =>
      notifications.enqueue(c, tenant, {
        channel: "sms",
        recipient: "2547_0000000",
        templateKey: "deadline_reminder",
        payload: { businessName: "X", label: "PAYE", dueDate: "2026-08-09", daysRemaining: 3 },
      }),
    );
    await notifications.processOnce();
    const row = await db.withTenant(tenant, user, async (c) => {
      const r = await c.query(
        "SELECT status, attempts, last_error, next_attempt_at > now() AS backed_off FROM notifications WHERE id = $1",
        [id],
      );
      return r.rows[0];
    });
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.backed_off).toBe(true);
    expect(row.last_error).toMatch(/undeliverable/);
  });
});
