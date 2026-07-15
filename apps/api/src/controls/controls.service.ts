import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PoolClient } from "pg";
import { AuditService } from "../audit/audit.service";
import { DbService } from "../db/db.service";

export const CONTROLLED_DOC_TYPES = ["bill_payment", "purchase_order"] as const;
export type ControlledDocType = (typeof CONTROLLED_DOC_TYPES)[number];

const GATE_MESSAGE: Record<ControlledDocType, string> = {
  bill_payment:
    "Payment requires approval — request created for approver review",
  purchase_order:
    "Sending this purchase order requires approval — request created for approver review",
};

/**
 * Business controls: tenant-configurable approval thresholds. A gated
 * action (bill payment, PO send) at/above the active threshold needs an
 * approved approval_requests row for its document; the first blocked
 * attempt files the request, an owner/admin who is NOT the requester
 * decides it (self-approval is blocked), then the action can retry.
 */
@Injectable()
export class ControlsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async listPolicies(client: PoolClient) {
    const res = await client.query(
      `SELECT doc_type, threshold_cents, active, updated_at
       FROM approval_policies ORDER BY doc_type`,
    );
    return res.rows;
  }

  async upsertPolicy(
    client: PoolClient,
    args: {
      tenantId: string;
      userId: string;
      docType: ControlledDocType;
      thresholdCents: number;
      active: boolean;
    },
  ) {
    if (!CONTROLLED_DOC_TYPES.includes(args.docType)) {
      throw new BadRequestException(
        "docType must be bill_payment | purchase_order",
      );
    }
    if (
      !Number.isInteger(args.thresholdCents) ||
      args.thresholdCents < 0
    ) {
      throw new BadRequestException(
        "thresholdCents must be a non-negative integer",
      );
    }
    const res = await client.query(
      `INSERT INTO approval_policies
         (tenant_id, doc_type, threshold_cents, active, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, doc_type) DO UPDATE
       SET threshold_cents = EXCLUDED.threshold_cents,
           active = EXCLUDED.active,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
       RETURNING doc_type, threshold_cents, active, updated_at`,
      [
        args.tenantId,
        args.docType,
        args.thresholdCents,
        args.active,
        args.userId,
      ],
    );
    await this.audit.record(client, {
      tenantId: args.tenantId,
      actorUserId: args.userId,
      action: "controls.policy_set",
      entityType: "approval_policy",
      entityId: args.docType,
      payload: { thresholdCents: args.thresholdCents, active: args.active },
    });
    return res.rows[0];
  }

  /**
   * Gate a monetary action behind the tenant's approval policy. Runs in
   * its OWN transaction so the pending request it files survives the 403
   * that aborts the caller's work. No active policy, an amount below the
   * threshold, or an approved request lets the action proceed.
   */
  async enforce(args: {
    tenantId: string;
    userId: string;
    docType: ControlledDocType;
    docId: string;
    amountCents: number;
  }): Promise<void> {
    const outcome = await this.db.withTenant(
      args.tenantId,
      args.userId,
      async (client) => {
        const pol = await client.query(
          `SELECT threshold_cents FROM approval_policies
           WHERE doc_type = $1 AND active`,
          [args.docType],
        );
        if (
          !pol.rows[0] ||
          args.amountCents < Number(pol.rows[0].threshold_cents)
        ) {
          return "allowed";
        }
        const existing = await client.query(
          `SELECT status FROM approval_requests
           WHERE doc_type = $1 AND doc_id = $2`,
          [args.docType, args.docId],
        );
        const status = existing.rows[0]?.status as string | undefined;
        if (status === "approved") return "allowed";
        if (status) return status; // pending | rejected
        let requestId: string;
        try {
          const ins = await client.query(
            `INSERT INTO approval_requests
               (tenant_id, doc_type, doc_id, amount_cents, requested_by)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [
              args.tenantId,
              args.docType,
              args.docId,
              args.amountCents,
              args.userId,
            ],
          );
          requestId = ins.rows[0].id;
        } catch (err) {
          // Concurrent attempt filed it first — report it as pending.
          if ((err as { code?: string }).code === "23505") return "pending";
          throw err;
        }
        await this.audit.record(client, {
          tenantId: args.tenantId,
          actorUserId: args.userId,
          action: "approval.requested",
          entityType: "approval_request",
          entityId: requestId,
          payload: {
            docType: args.docType,
            docId: args.docId,
            amountCents: args.amountCents,
          },
        });
        return "created";
      },
    );
    if (outcome === "allowed") return;
    if (outcome === "created") {
      throw new ForbiddenException(GATE_MESSAGE[args.docType]);
    }
    throw new ForbiddenException(
      `Approval request for this ${
        args.docType === "bill_payment" ? "payment" : "purchase order"
      } is ${outcome}`,
    );
  }

  async listApprovals(client: PoolClient, status?: string) {
    if (status && !["pending", "approved", "rejected"].includes(status)) {
      throw new BadRequestException(
        "status must be pending | approved | rejected",
      );
    }
    const res = await client.query(
      `SELECT ar.id, ar.doc_type, ar.doc_id, ar.amount_cents, ar.status,
              ar.reason, ar.created_at, ar.decided_at,
              coalesce(ru.full_name, ru.email) AS requested_by_name,
              coalesce(du.full_name, du.email) AS decided_by_name,
              CASE WHEN ar.doc_type = 'bill_payment' THEN bs.name
                   ELSE ps.name END AS supplier_name,
              b.supplier_invoice_no, po.po_no
       FROM approval_requests ar
       JOIN users ru ON ru.id = ar.requested_by
       LEFT JOIN users du ON du.id = ar.decided_by
       LEFT JOIN bills b
         ON ar.doc_type = 'bill_payment' AND b.id = ar.doc_id
       LEFT JOIN suppliers bs ON bs.id = b.supplier_id
       LEFT JOIN purchase_orders po
         ON ar.doc_type = 'purchase_order' AND po.id = ar.doc_id
       LEFT JOIN suppliers ps ON ps.id = po.supplier_id
       WHERE ($1::text IS NULL OR ar.status = $1)
       ORDER BY ar.created_at DESC
       LIMIT 200`,
      [status ?? null],
    );
    return res.rows;
  }

  /** Owner/admin decision. Self-approval is blocked; reject needs a reason. */
  async decide(args: {
    tenantId: string;
    userId: string;
    requestId: string;
    approve: boolean;
    reason?: string;
  }): Promise<{ id: string; status: "approved" | "rejected" }> {
    return this.db.withTenant(args.tenantId, args.userId, async (client) => {
      const res = await client.query(
        `SELECT id, doc_type, doc_id, amount_cents, status, requested_by
         FROM approval_requests WHERE id = $1 FOR UPDATE`,
        [args.requestId],
      );
      const req = res.rows[0];
      if (!req) throw new NotFoundException("Approval request not found");
      if (req.status !== "pending") {
        throw new BadRequestException(`Request is already ${req.status}`);
      }
      if (args.approve && req.requested_by === args.userId) {
        throw new ForbiddenException(
          "Self-approval is blocked — a different owner/admin must approve",
        );
      }
      const reason = args.reason?.trim() || null;
      if (!args.approve && !reason) {
        throw new BadRequestException("A reason is required to reject");
      }
      const status = args.approve ? ("approved" as const) : ("rejected" as const);
      await client.query(
        `UPDATE approval_requests
         SET status = $2, decided_by = $3, decided_at = now(), reason = $4
         WHERE id = $1`,
        [args.requestId, status, args.userId, reason],
      );
      await this.audit.record(client, {
        tenantId: args.tenantId,
        actorUserId: args.userId,
        action: args.approve ? "approval.approved" : "approval.rejected",
        entityType: "approval_request",
        entityId: args.requestId,
        payload: {
          docType: req.doc_type,
          docId: req.doc_id,
          amountCents: Number(req.amount_cents),
          reason,
        },
      });
      return { id: args.requestId, status };
    });
  }
}
