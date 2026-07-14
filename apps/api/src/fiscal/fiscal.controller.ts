import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import { AuditService } from "../audit/audit.service";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";
import { FiscalService } from "./fiscal.service";

@Controller("tenants/current")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class FiscalController {
  constructor(
    private readonly db: DbService,
    private readonly fiscal: FiscalService,
    private readonly audit: AuditService,
  ) {}

  @Post("branches")
  @Roles("owner", "admin")
  async createBranch(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { code?: string; name?: string },
  ) {
    if (!body?.code?.trim() || !body?.name?.trim()) {
      throw new BadRequestException("code and name are required");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO branches (tenant_id, code, name)
         VALUES ($1, $2, $3) RETURNING id, code, name, created_at`,
        [claims.tid, body.code!.trim(), body.name!.trim()],
      );
      await this.audit.record(client, {
        tenantId: claims.tid,
        actorUserId: claims.sub,
        action: "branch.created",
        entityType: "branch",
        entityId: res.rows[0].id,
        payload: { code: body.code, name: body.name },
      });
      return res.rows[0];
    });
  }

  @Get("branches")
  async listBranches(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        "SELECT id, code, name, created_at FROM branches ORDER BY created_at",
      );
      return res.rows;
    });
  }

  @Post("fiscal/documents")
  @Roles("owner", "admin", "accountant", "cashier")
  async enqueue(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      branchId?: string;
      docType?: "invoice" | "credit_note";
      idempotencyKey?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    if (
      !body?.branchId ||
      !body?.idempotencyKey?.trim() ||
      !body?.payload ||
      !["invoice", "credit_note"].includes(body?.docType ?? "")
    ) {
      throw new BadRequestException(
        "branchId, docType (invoice|credit_note), idempotencyKey and payload are required",
      );
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const doc = await this.fiscal.enqueue(client, claims.tid, {
        branchId: body.branchId!,
        docType: body.docType!,
        idempotencyKey: body.idempotencyKey!.trim(),
        payload: body.payload!,
      });
      if (!doc.deduplicated) {
        await this.audit.record(client, {
          tenantId: claims.tid,
          actorUserId: claims.sub,
          action: "fiscal.enqueued",
          entityType: "fiscal_document",
          entityId: doc.id,
          payload: { docType: body.docType, idempotencyKey: body.idempotencyKey },
        });
      }
      return doc;
    });
  }

  @Get("fiscal/documents")
  async list(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, branch_id, doc_type, status, seq, control_number,
                qr_payload, attempts, last_error, signed_at, created_at
         FROM fiscal_documents
         ORDER BY created_at DESC
         LIMIT 100`,
      );
      return res.rows;
    });
  }
}
