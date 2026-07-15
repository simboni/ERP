import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import type { TenantTokenClaims } from "@jenga/shared";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB per file at pilot scale
const ENTITY_TYPES = [
  "invoice",
  "customer",
  "supplier",
  "employee",
  "bill",
  "quote",
] as const;

/**
 * Document store: uploads arrive as base64 JSON (keeps the client static
 * export simple), bytes live in Postgres under RLS. Downloads stream with
 * the original content type; content-disposition forces save-as so a
 * hostile HTML upload can never execute on our origin.
 */
@Controller("tenants/current/documents")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class DocumentsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("entityType") entityType?: string,
    @Query("entityId") entityId?: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res =
        entityType && entityId
          ? await client.query(
              `SELECT d.id, d.name, d.mime, d.size_bytes, d.entity_type,
                      d.entity_id, d.created_at, u.full_name AS uploaded_by
               FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
               WHERE d.entity_type = $1 AND d.entity_id = $2
               ORDER BY d.created_at DESC`,
              [entityType, entityId],
            )
          : await client.query(
              `SELECT d.id, d.name, d.mime, d.size_bytes, d.entity_type,
                      d.entity_id, d.created_at, u.full_name AS uploaded_by
               FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
               ORDER BY d.created_at DESC LIMIT 500`,
            );
      return res.rows;
    });
  }

  @Post()
  async upload(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      name?: string;
      mime?: string;
      dataBase64?: string;
      entityType?: string;
      entityId?: string;
    },
  ) {
    if (!body?.name?.trim() || !body?.dataBase64) {
      throw new BadRequestException("name and dataBase64 are required");
    }
    if (body.entityType && !ENTITY_TYPES.includes(body.entityType as never)) {
      throw new BadRequestException(
        `entityType must be one of ${ENTITY_TYPES.join(" | ")}`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.dataBase64, "base64");
    } catch {
      throw new BadRequestException("dataBase64 is not valid base64");
    }
    if (bytes.length === 0) throw new BadRequestException("File is empty");
    if (bytes.length > MAX_BYTES) {
      throw new BadRequestException(
        `File too large: ${Math.round(bytes.length / 1024 / 1024)}MB (max 5MB)`,
      );
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO documents (tenant_id, name, mime, size_bytes, data,
                                entity_type, entity_id, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, name, size_bytes, created_at`,
        [
          claims.tid,
          body.name!.trim().slice(0, 200),
          body.mime?.trim() || "application/octet-stream",
          bytes.length,
          bytes,
          body.entityType || null,
          body.entityId || null,
          claims.sub,
        ],
      );
      return res.rows[0];
    });
  }

  @Get(":id/download")
  async download(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const doc = await this.db.withTenant(
      claims.tid,
      claims.sub,
      async (client) => {
        const r = await client.query(
          "SELECT name, mime, data FROM documents WHERE id = $1",
          [id],
        );
        return r.rows[0];
      },
    );
    if (!doc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }
    res.setHeader("Content-Type", doc.mime);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${String(doc.name).replace(/["\\\r\n]/g, "_")}"`,
    );
    res.send(doc.data);
  }

  @Delete(":id")
  @Roles("owner", "admin")
  async remove(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        "DELETE FROM documents WHERE id = $1 RETURNING id",
        [id],
      );
      if (!res.rows[0]) throw new BadRequestException("Document not found");
      return { deleted: true };
    });
  }
}
