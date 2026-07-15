/**
 * Business controls tests against jenga_test:
 *  - approval policy upsert is owner-only and replaces per doc_type,
 *  - bill payments below the threshold settle normally (no request rows),
 *  - at/above the threshold the payment 403s and files ONE pending
 *    approval request; retries surface the pending status,
 *  - self-approval is blocked; a different owner/admin approves and the
 *    payment then succeeds; reject requires a reason and keeps blocking,
 *  - the same gate applies to sending purchase orders,
 *  - the audit-log viewer endpoint paginates, filters by action /
 *    entityType / date range, clamps limit at 100, and lists distinct
 *    actions for the filter dropdown.
 */
import { randomUUID } from "node:crypto";
import type { TenantTokenClaims } from "@jenga/shared";
import { DbService } from "../src/db/db.service";
import { AuditService } from "../src/audit/audit.service";
import {
  LedgerService,
  seedDefaultAccounts,
} from "../src/ledger/ledger.service";
import { SandboxPayoutProvider } from "../src/payments/payout.provider";
import { BillsService } from "../src/purchases/bills.service";
import { PurchaseOrdersService } from "../src/purchases/purchase-orders.service";
import { InventoryService } from "../src/inventory/inventory.service";
import { ControlsController } from "../src/controls/controls.controller";
import { ControlsService } from "../src/controls/controls.service";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("business controls (approval thresholds + audit viewer)", () => {
  const db = new DbService();
  const ledger = new LedgerService();
  const audit = new AuditService();
  const controls = new ControlsService(db, audit);
  const bills = new BillsService(
    ledger,
    audit,
    new SandboxPayoutProvider(),
    db,
    controls,
  );
  const pos = new PurchaseOrdersService(
    new InventoryService(),
    bills,
    audit,
    controls,
  );
  const controller = new ControlsController(db, controls);

  let tenant: string;
  let owner: string;
  let admin: string;
  let supplier: string;
  let branch: string;
  let ownerClaims: TenantTokenClaims;
  let adminClaims: TenantTokenClaims;

  const draftBill = async (totalCents: number): Promise<string> => {
    const d = await db.withTenant(tenant, owner, (c) =>
      bills.createDraft(c, {
        tenantId: tenant,
        userId: owner,
        supplierId: supplier,
        billDate: "2026-07-01",
        lines: [
          {
            description: "Stock",
            quantity: 1,
            unitPriceCents: totalCents,
            vatRate: "0",
          },
        ],
      }),
    );
    await db.withTenant(tenant, owner, (c) =>
      bills.approve(c, { tenantId: tenant, userId: owner, billId: d.id }),
    );
    return d.id;
  };

  const requestFor = async (docId: string) =>
    db.withTenant(tenant, owner, async (c) => {
      const r = await c.query(
        "SELECT * FROM approval_requests WHERE doc_id = $1",
        [docId],
      );
      return r.rows;
    });

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const mkUser = async (name: string) =>
      (
        await db.query(
          `INSERT INTO users (email, password_hash, full_name)
           VALUES ($1, 'x', $2) RETURNING id`,
          [`controls-${name}-${suffix}@test.local`, `Controls ${name}`],
        )
      ).rows[0].id as string;
    owner = await mkUser("Owner");
    admin = await mkUser("Admin");
    const t = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      ["controls-co", `controls-co-${suffix}`, owner],
    );
    tenant = t.rows[0].id;
    ownerClaims = { sub: owner, tid: tenant, rol: "owner", typ: "tenant" };
    adminClaims = { sub: admin, tid: tenant, rol: "admin", typ: "tenant" };
    await db.withTenant(tenant, owner, async (c) => {
      await seedDefaultAccounts(c, tenant);
      await c.query(
        `INSERT INTO memberships (tenant_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [tenant, admin],
      );
      supplier = (
        await c.query(
          `INSERT INTO suppliers (tenant_id, name, kra_pin)
           VALUES ($1, 'Gated Supplies Ltd', 'P051111222C') RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
      branch = (
        await c.query(
          `INSERT INTO branches (tenant_id, code, name)
           VALUES ($1, 'HQ', 'Head Office') RETURNING id`,
          [tenant],
        )
      ).rows[0].id;
    });
  });

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it("policy upsert is owner-only and replaces per doc_type", async () => {
    await expect(
      controller.putPolicy(adminClaims, {
        docType: "bill_payment",
        thresholdCents: 5_000_000,
        active: true,
      }),
    ).rejects.toThrow(/Only the owner/);

    const first = await controller.putPolicy(ownerClaims, {
      docType: "bill_payment",
      thresholdCents: 9_000_000,
      active: true,
    });
    expect(Number(first.threshold_cents)).toBe(9_000_000);

    // Upsert replaces the same doc_type in place.
    await controller.putPolicy(ownerClaims, {
      docType: "bill_payment",
      thresholdCents: 5_000_000,
      active: true,
    });
    const listed = await controller.listPolicies(ownerClaims);
    expect(listed).toHaveLength(1);
    expect(listed[0].doc_type).toBe("bill_payment");
    expect(Number(listed[0].threshold_cents)).toBe(5_000_000);
    expect(listed[0].active).toBe(true);

    await expect(
      controller.putPolicy(ownerClaims, {
        docType: "bill_payment",
        thresholdCents: -1,
        active: true,
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it("bill payment below the threshold settles with no approval request", async () => {
    const billId = await draftBill(1_000_000); // KES 10,000 < 50,000
    const paid = await bills.pay({
      tenantId: tenant,
      userId: admin,
      billId,
      method: "cash",
    });
    expect(paid.journalEntryId).toBeTruthy();
    expect(await requestFor(billId)).toHaveLength(0);
  });

  let gatedBill: string;
  let gatedRequest: string;

  it("payment at/above the threshold 403s and files one pending request", async () => {
    gatedBill = await draftBill(8_000_000); // KES 80,000 >= 50,000
    await expect(
      bills.pay({ tenantId: tenant, userId: admin, billId: gatedBill, method: "cash" }),
    ).rejects.toThrow(
      "Payment requires approval — request created for approver review",
    );
    const rows = await requestFor(gatedBill);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].requested_by).toBe(admin);
    expect(Number(rows[0].amount_cents)).toBe(8_000_000);
    gatedRequest = rows[0].id;

    // Bill was NOT paid and no settlement entry was posted.
    await db.withTenant(tenant, owner, async (c) => {
      const b = await c.query("SELECT status FROM bills WHERE id = $1", [gatedBill]);
      expect(b.rows[0].status).toBe("approved");
      const je = await c.query(
        "SELECT 1 FROM journal_entries WHERE idempotency_key = $1",
        [`bill-payment:${gatedBill}`],
      );
      expect(je.rows).toHaveLength(0);
    });

    // A retry does not duplicate the request; it reports the status.
    await expect(
      bills.pay({ tenantId: tenant, userId: admin, billId: gatedBill, method: "cash" }),
    ).rejects.toThrow(/pending/);
    expect(await requestFor(gatedBill)).toHaveLength(1);
  });

  it("blocks self-approval, approves via a different admin, then pays", async () => {
    // The requester cannot approve their own request.
    await expect(
      controller.decide(adminClaims, gatedRequest, { approve: true }),
    ).rejects.toThrow(/Self-approval/);

    // Pending queue shows document context for the approver.
    const pending = await controller.listApprovals(ownerClaims, "pending");
    const mine = pending.find((r: { id: string }) => r.id === gatedRequest);
    expect(mine.doc_type).toBe("bill_payment");
    expect(mine.supplier_name).toBe("Gated Supplies Ltd");
    expect(mine.requested_by_name).toBe("Controls Admin");

    const decided = await controller.decide(ownerClaims, gatedRequest, {
      approve: true,
    });
    expect(decided.status).toBe("approved");

    // Deciding twice is a clean 400, not a rewrite.
    await expect(
      controller.decide(ownerClaims, gatedRequest, { approve: true }),
    ).rejects.toThrow(/already approved/);

    const paid = await bills.pay({
      tenantId: tenant,
      userId: admin,
      billId: gatedBill,
      method: "cash",
    });
    expect(paid.journalEntryId).toBeTruthy();
    await db.withTenant(tenant, owner, async (c) => {
      const b = await c.query("SELECT status FROM bills WHERE id = $1", [gatedBill]);
      expect(b.rows[0].status).toBe("paid");
    });
  });

  it("reject requires a reason and keeps the payment blocked", async () => {
    const billId = await draftBill(6_000_000);
    await expect(
      bills.pay({ tenantId: tenant, userId: owner, billId, method: "cash" }),
    ).rejects.toThrow(/requires approval/);
    const [req] = await requestFor(billId);

    await expect(
      controller.decide(adminClaims, req.id, { approve: false }),
    ).rejects.toThrow(/reason is required/);
    await expect(
      controller.decide(adminClaims, req.id, { approve: false, reason: "  " }),
    ).rejects.toThrow(/reason is required/);

    const decided = await controller.decide(adminClaims, req.id, {
      approve: false,
      reason: "Wrong supplier account",
    });
    expect(decided.status).toBe("rejected");

    await expect(
      bills.pay({ tenantId: tenant, userId: owner, billId, method: "cash" }),
    ).rejects.toThrow(/rejected/);
    const rows = await requestFor(billId);
    expect(rows[0].reason).toBe("Wrong supplier account");
    expect(rows[0].decided_by).toBe(admin);
  });

  it("gates sending a purchase order the same way", async () => {
    await controller.putPolicy(ownerClaims, {
      docType: "purchase_order",
      thresholdCents: 3_000_000,
      active: true,
    });
    const mkPo = async (totalCents: number) =>
      db.withTenant(tenant, admin, async (c) => {
        const r = await c.query(
          `INSERT INTO purchase_orders
             (tenant_id, branch_id, supplier_id, po_no, total_cents, created_by)
           VALUES ($1, $2, $3,
                   (SELECT coalesce(max(po_no), 0) + 1 FROM purchase_orders),
                   $4, $5)
           RETURNING id`,
          [tenant, branch, supplier, totalCents, admin],
        );
        return r.rows[0].id as string;
      });

    // Below the threshold: sends without any request.
    const smallPo = await mkPo(1_000_000);
    const sent = await db.withTenant(tenant, admin, (c) =>
      pos.send(c, { tenantId: tenant, userId: admin, poId: smallPo }),
    );
    expect(sent.status).toBe("sent");
    expect(await requestFor(smallPo)).toHaveLength(0);

    // At/above: blocked, request filed, approval unblocks.
    const bigPo = await mkPo(5_000_000);
    await expect(
      db.withTenant(tenant, admin, (c) =>
        pos.send(c, { tenantId: tenant, userId: admin, poId: bigPo }),
      ),
    ).rejects.toThrow(/requires approval/);
    const [req] = await requestFor(bigPo);
    expect(req.status).toBe("pending");
    expect(req.doc_type).toBe("purchase_order");
    await db.withTenant(tenant, owner, async (c) => {
      const r = await c.query(
        "SELECT status FROM purchase_orders WHERE id = $1",
        [bigPo],
      );
      expect(r.rows[0].status).toBe("draft"); // the 403 rolled the send back
    });

    await controller.decide(ownerClaims, req.id, { approve: true });
    const sent2 = await db.withTenant(tenant, admin, (c) =>
      pos.send(c, { tenantId: tenant, userId: admin, poId: bigPo }),
    );
    expect(sent2.status).toBe("sent");

    // An inactive policy stops gating without losing the threshold.
    await controller.putPolicy(ownerClaims, {
      docType: "purchase_order",
      thresholdCents: 3_000_000,
      active: false,
    });
    const bigPo2 = await mkPo(5_000_000);
    const sent3 = await db.withTenant(tenant, admin, (c) =>
      pos.send(c, { tenantId: tenant, userId: admin, poId: bigPo2 }),
    );
    expect(sent3.status).toBe("sent");
    expect(await requestFor(bigPo2)).toHaveLength(0);
  });

  it("audit-log endpoint returns decisions with working filters", async () => {
    const all = await controller.auditLog(ownerClaims, {});
    expect(all.total).toBeGreaterThan(0);
    expect(all.rows.length).toBeLessThanOrEqual(50); // default limit
    expect(all.rows[0].actor).toBeTruthy(); // joined user name

    // Action filter: only the approval decisions come back.
    const approvals = await controller.auditLog(ownerClaims, {
      action: "approval.approved",
    });
    expect(approvals.total).toBe(2); // gated bill + gated PO
    for (const row of approvals.rows) {
      expect(row.action).toBe("approval.approved");
      expect(row.entity_type).toBe("approval_request");
    }
    const rejected = await controller.auditLog(ownerClaims, {
      action: "approval.rejected",
    });
    expect(rejected.total).toBe(1);
    expect(rejected.rows[0].payload.reason).toBe("Wrong supplier account");

    // entityType filter.
    const requests = await controller.auditLog(ownerClaims, {
      entityType: "approval_request",
    });
    expect(requests.total).toBe(
      await db.withTenant(tenant, owner, async (c) =>
        Number(
          (
            await c.query(
              "SELECT count(*) AS n FROM audit_log WHERE entity_type = 'approval_request'",
            )
          ).rows[0].n,
        ),
      ),
    );

    // Date range: everything happened today; a window in the past is empty.
    const today = new Date().toISOString().slice(0, 10);
    const fromToday = await controller.auditLog(ownerClaims, { from: today });
    expect(fromToday.total).toBe(all.total);
    const past = await controller.auditLog(ownerClaims, {
      from: "2000-01-01",
      to: "2000-12-31",
    });
    expect(past.total).toBe(0);
    await expect(
      controller.auditLog(ownerClaims, { from: "01/01/2026" }),
    ).rejects.toThrow(/YYYY-MM-DD/);

    // Pagination: limit clamps at 100 and offset walks the set.
    const clamped = await controller.auditLog(ownerClaims, { limit: "5000" });
    expect(clamped.limit).toBe(100);
    const page1 = await controller.auditLog(ownerClaims, { limit: "2" });
    const page2 = await controller.auditLog(ownerClaims, {
      limit: "2",
      offset: "2",
    });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows[0].id).not.toBe(page1.rows[0].id);

    // Distinct actions feed the filter dropdown.
    const actions = await controller.auditActions(ownerClaims);
    for (const a of [
      "approval.requested",
      "approval.approved",
      "approval.rejected",
      "controls.policy_set",
      "bill.paid",
    ]) {
      expect(actions.actions).toContain(a);
    }
    expect(actions.entityTypes).toContain("approval_request");
  });
});
