import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { AuditService } from "../audit/audit.service";
import { ControlsService } from "../controls/controls.service";
import { InventoryService } from "../inventory/inventory.service";
import { mulRate } from "../payroll/calculator";
import { BillsService } from "./bills.service";

export interface PoLineInput {
  itemId: string;
  description?: string;
  quantity: number;
  unitCostCents: number;
  vatRate?: "0.16" | "0" | "exempt";
}

/**
 * Purchase orders: a commercial commitment, not an accounting event.
 * Nothing touches the ledger until goods are received (stock_movements,
 * reason 'purchase') and the supplier bill is drafted/approved through
 * the existing bills path.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly inventory: InventoryService,
    private readonly bills: BillsService,
    private readonly audit: AuditService,
    private readonly controls: ControlsService,
  ) {}

  async createDraft(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      supplierId: string;
      branchId: string;
      expectedDate?: string;
      lines: PoLineInput[];
    },
  ): Promise<{ id: string; poNo: number; totalCents: number }> {
    if (!args.lines.length) {
      throw new BadRequestException("A purchase order needs at least one line");
    }
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('po-no:' || $1))",
      [args.tenantId],
    );
    const noRes = await client.query(
      "SELECT coalesce(max(po_no), 0) + 1 AS next FROM purchase_orders",
    );
    const poNo = Number(noRes.rows[0].next);
    const header = await client.query(
      `INSERT INTO purchase_orders
         (tenant_id, branch_id, supplier_id, po_no, expected_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        args.tenantId,
        args.branchId,
        args.supplierId,
        poNo,
        args.expectedDate || null,
        args.userId,
      ],
    );
    const poId = header.rows[0].id as string;

    let subtotal = 0;
    let vat = 0;
    for (const line of args.lines) {
      if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
        throw new BadRequestException("Line quantity must be positive");
      }
      if (!Number.isInteger(line.unitCostCents) || line.unitCostCents < 0) {
        throw new BadRequestException("unitCostCents must be a whole number");
      }
      const itemRes = await client.query(
        "SELECT name, vat_rate FROM items WHERE id = $1",
        [line.itemId],
      );
      const item = itemRes.rows[0];
      if (!item) throw new NotFoundException(`Item ${line.itemId} not found`);
      const vatRate = line.vatRate ?? item.vat_rate;
      const lineTotal = Math.round(
        (line.unitCostCents * Math.round(line.quantity * 1000)) / 1000,
      );
      const lineVat = vatRate === "0.16" ? mulRate(lineTotal, "0.16") : 0;
      subtotal += lineTotal;
      vat += lineVat;
      await client.query(
        `INSERT INTO purchase_order_lines
           (tenant_id, po_id, item_id, description, quantity,
            unit_cost_cents, vat_rate, line_total_cents, vat_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          args.tenantId,
          poId,
          line.itemId,
          line.description?.trim() || item.name,
          line.quantity,
          line.unitCostCents,
          vatRate,
          lineTotal,
          lineVat,
        ],
      );
    }
    await client.query(
      `UPDATE purchase_orders
       SET subtotal_cents = $2, vat_cents = $3, total_cents = $4
       WHERE id = $1`,
      [poId, subtotal, vat, subtotal + vat],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "po.drafted",
      entityType: "purchase_order",
      entityId: poId,
      payload: { poNo, totalCents: subtotal + vat },
    });
    return { id: poId, poNo, totalCents: subtotal + vat };
  }

  async send(
    client: PoolClient,
    args: { tenantId: string; userId: string; poId: string },
  ): Promise<{ status: string }> {
    const res = await client.query(
      "SELECT status, total_cents FROM purchase_orders WHERE id = $1 FOR UPDATE",
      [args.poId],
    );
    if (!res.rows[0]) throw new NotFoundException("Purchase order not found");
    if (res.rows[0].status !== "draft") {
      throw new BadRequestException("Only draft POs can be sent");
    }
    // Approval-threshold gate (business controls). Runs in its own
    // transaction so the pending request survives the 403 that aborts
    // this send.
    await this.controls.enforce({
      tenantId: args.tenantId,
      userId: args.userId,
      docType: "purchase_order",
      docId: args.poId,
      amountCents: Number(res.rows[0].total_cents),
    });
    await client.query(
      "UPDATE purchase_orders SET status = 'sent' WHERE id = $1",
      [args.poId],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "po.sent",
      entityType: "purchase_order",
      entityId: args.poId,
      payload: {},
    });
    return { status: "sent" };
  }

  async cancel(
    client: PoolClient,
    args: { tenantId: string; userId: string; poId: string },
  ): Promise<{ status: string }> {
    const res = await client.query(
      "SELECT status FROM purchase_orders WHERE id = $1 FOR UPDATE",
      [args.poId],
    );
    if (!res.rows[0]) throw new NotFoundException("Purchase order not found");
    if (!["draft", "sent"].includes(res.rows[0].status)) {
      throw new BadRequestException("Only draft or sent POs can be cancelled");
    }
    const rec = await client.query(
      `SELECT coalesce(sum(qty_received), 0) AS rec
       FROM purchase_order_lines WHERE po_id = $1`,
      [args.poId],
    );
    if (Number(rec.rows[0].rec) > 0) {
      throw new BadRequestException(
        "A PO with received goods cannot be cancelled",
      );
    }
    await client.query(
      "UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1",
      [args.poId],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "po.cancelled",
      entityType: "purchase_order",
      entityId: args.poId,
      payload: {},
    });
    return { status: "cancelled" };
  }

  async receive(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      poId: string;
      receipts: { lineId: string; qty: number }[];
    },
  ): Promise<{ status: string; receivedLines: number }> {
    const poRes = await client.query(
      "SELECT id, status, branch_id FROM purchase_orders WHERE id = $1 FOR UPDATE",
      [args.poId],
    );
    const po = poRes.rows[0];
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status !== "sent") {
      throw new BadRequestException("Only sent POs can receive goods");
    }
    if (!args.receipts?.length) {
      throw new BadRequestException("receipts must be non-empty");
    }
    for (const r of args.receipts) {
      if (!Number.isFinite(r.qty) || r.qty <= 0) {
        throw new BadRequestException("Receipt quantities must be positive");
      }
      const lineRes = await client.query(
        `SELECT id, item_id, quantity, qty_received, description
         FROM purchase_order_lines
         WHERE id = $1 AND po_id = $2
         FOR UPDATE`,
        [r.lineId, args.poId],
      );
      const line = lineRes.rows[0];
      if (!line) throw new NotFoundException("PO line not found");
      const remaining = Number(line.quantity) - Number(line.qty_received);
      if (r.qty > remaining) {
        throw new BadRequestException(
          `Line ${line.description}: only ${remaining} outstanding`,
        );
      }
      await this.inventory.recordMovement(client, {
        tenantId: args.tenantId,
        itemId: line.item_id,
        branchId: po.branch_id,
        qtyDelta: r.qty,
        reason: "purchase",
        refType: "purchase_order",
        refId: args.poId,
        userId: args.userId,
      });
      await client.query(
        `UPDATE purchase_order_lines
         SET qty_received = qty_received + $2 WHERE id = $1`,
        [r.lineId, r.qty],
      );
    }
    const flipped = await client.query(
      `UPDATE purchase_orders po SET status = 'received'
       WHERE po.id = $1
         AND NOT EXISTS (SELECT 1 FROM purchase_order_lines l
                         WHERE l.po_id = po.id AND l.qty_received < l.quantity)
       RETURNING status`,
      [args.poId],
    );
    const complete = Boolean(flipped.rows[0]);
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "po.received",
      entityType: "purchase_order",
      entityId: args.poId,
      payload: { receipts: args.receipts, complete },
    });
    return {
      status: complete ? "received" : "sent",
      receivedLines: args.receipts.length,
    };
  }

  async convertToBill(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      poId: string;
      billDate?: string;
      supplierInvoiceNo?: string;
      etimsControlNumber?: string;
    },
  ): Promise<{ billId: string; totalCents: number }> {
    const poRes = await client.query(
      `SELECT id, status, bill_id, supplier_id
       FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [args.poId],
    );
    const po = poRes.rows[0];
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.bill_id) throw new BadRequestException("PO already has a bill");
    if (!["sent", "received"].includes(po.status)) {
      throw new BadRequestException(
        "Only sent or received POs convert to bills",
      );
    }
    const lines = (
      await client.query(
        `SELECT description, quantity, unit_cost_cents, vat_rate
         FROM purchase_order_lines WHERE po_id = $1 ORDER BY id`,
        [args.poId],
      )
    ).rows;
    const bill = await this.bills.createDraft(client, {
      tenantId: args.tenantId,
      userId: args.userId,
      supplierId: po.supplier_id,
      billDate: args.billDate ?? new Date().toISOString().slice(0, 10),
      supplierInvoiceNo: args.supplierInvoiceNo,
      etimsControlNumber: args.etimsControlNumber,
      lines: lines.map((l) => ({
        description: l.description,
        quantity: Number(l.quantity),
        unitPriceCents: Number(l.unit_cost_cents),
        vatRate: l.vat_rate,
        accountCode: "5000",
      })),
    });
    await client.query(
      "UPDATE purchase_orders SET bill_id = $2 WHERE id = $1",
      [args.poId, bill.id],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "po.converted_to_bill",
      entityType: "purchase_order",
      entityId: args.poId,
      payload: { billId: bill.id },
    });
    return { billId: bill.id, totalCents: bill.totalCents };
  }
}
