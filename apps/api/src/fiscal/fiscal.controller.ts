import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
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
    @Body()
    body: {
      code?: string;
      name?: string;
      phone?: string;
      address?: string;
      isDefault?: boolean;
    },
  ) {
    if (!body?.code?.trim() || !body?.name?.trim()) {
      throw new BadRequestException("code and name are required");
    }
    const isDefault = body.isDefault === true;
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      // At most one default branch per tenant (enforced by a partial unique
      // index); clear the incumbent before promoting a new one.
      if (isDefault) {
        await client.query(
          "UPDATE branches SET is_default = false WHERE is_default",
        );
      }
      const res = await client.query(
        `INSERT INTO branches (tenant_id, code, name, phone, address, is_default)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, code, name, phone, address, is_default, active, created_at`,
        [
          claims.tid,
          body.code!.trim(),
          body.name!.trim(),
          body.phone?.trim() || null,
          body.address?.trim() || null,
          isDefault,
        ],
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

  @Patch("branches/:id")
  @Roles("owner", "admin")
  async updateBranch(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) id: string,
    @Body()
    body: {
      code?: string;
      name?: string;
      phone?: string;
      address?: string;
      isDefault?: boolean;
      active?: boolean;
    },
  ) {
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const addText = (col: string, val: unknown, required = false): void => {
      if (val === undefined) return;
      if (val !== null && typeof val !== "string") {
        throw new BadRequestException(`${col} must be text`);
      }
      const trimmed = val === null ? null : (val as string).trim();
      if (required && !trimmed) {
        throw new BadRequestException(`${col} cannot be blank`);
      }
      sets.push(`${col} = $${i++}`);
      params.push(trimmed === "" ? null : trimmed);
    };
    addText("code", body.code, true);
    addText("name", body.name, true);
    addText("phone", body.phone);
    addText("address", body.address);
    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") {
        throw new BadRequestException("active must be a boolean");
      }
      sets.push(`active = $${i++}`);
      params.push(body.active);
    }
    if (sets.length === 0 && body.isDefault === undefined) {
      throw new BadRequestException("No editable fields provided");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      if (body.isDefault === true) {
        await client.query(
          "UPDATE branches SET is_default = false WHERE is_default AND id <> $1",
          [id],
        );
        sets.push(`is_default = $${i++}`);
        params.push(true);
      } else if (body.isDefault === false) {
        sets.push(`is_default = $${i++}`);
        params.push(false);
      }
      params.push(id);
      const res = await client.query(
        `UPDATE branches SET ${sets.join(", ")}
         WHERE id = $${i}
         RETURNING id, code, name, phone, address, is_default, active, created_at`,
        params,
      );
      if (!res.rows[0]) throw new NotFoundException("Branch not found");
      await this.audit.record(client, {
        tenantId: claims.tid,
        actorUserId: claims.sub,
        action: "branch.updated",
        entityType: "branch",
        entityId: id,
        payload: { fields: sets.map((s) => s.split(" = ")[0]) },
      });
      return res.rows[0];
    });
  }

  @Get("branches")
  async listBranches(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT id, code, name, phone, address, is_default, active, created_at
         FROM branches ORDER BY is_default DESC, created_at`,
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
