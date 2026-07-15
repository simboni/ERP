import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
const CATEGORIES = [
  "contract",
  "invoice",
  "receipt",
  "id",
  "license",
  "certificate",
  "report",
  "other",
] as const;
type Category = (typeof CATEGORIES)[number];

const DOC_COLS = `d.id, d.name, d.mime, d.size_bytes, d.entity_type,
  d.entity_id, d.folder_id, d.category, d.tags, d.description,
  d.expires_on, d.created_at, u.full_name AS uploaded_by`;

/** Trim + cap free-text; returns null for blanks so columns stay clean. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

/** Normalise a tags payload (array or comma string) to a clean string[]. */
function normTags(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v
    : typeof v === "string"
      ? v.split(",")
      : [];
  const out: string[] = [];
  for (const t of raw) {
    const s = String(t).trim().slice(0, 40);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 20) break;
  }
  return out;
}

/** Accepts YYYY-MM-DD or null/empty; rejects anything else with a 400. */
function isoDateOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new BadRequestException("Date must be YYYY-MM-DD");
  }
  return v;
}

function checkCategory(v: unknown): Category {
  if (v === undefined || v === null || v === "") return "other";
  if (!CATEGORIES.includes(v as never)) {
    throw new BadRequestException(
      `category must be one of ${CATEGORIES.join(" | ")}`,
    );
  }
  return v as Category;
}

/**
 * Document management: uploads arrive as base64 JSON (keeps the client static
 * export simple), bytes live in Postgres under RLS. On top of the flat store
 * this adds a folder tree, per-file metadata (category, tags, description,
 * expiry) and compliance queries (expiring licences, category summary).
 * Downloads stream with the original content type; content-disposition forces
 * save-as so a hostile HTML upload can never execute on our origin.
 */
@Controller("tenants/current/documents")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class DocumentsController {
  constructor(private readonly db: DbService) {}

  // ---- Folders ------------------------------------------------------------

  /** Flat folder list with the count of documents filed directly in each. */
  @Get("folders")
  async listFolders(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT f.id, f.name, f.parent_id, f.created_at,
                (SELECT count(*) FROM documents d WHERE d.folder_id = f.id)::int
                  AS doc_count,
                (SELECT count(*) FROM document_folders c WHERE c.parent_id = f.id)::int
                  AS child_count
         FROM document_folders f
         ORDER BY lower(f.name)`,
      );
      return res.rows;
    });
  }

  @Post("folders")
  async createFolder(
    @TenantClaims() claims: TenantTokenClaims,
    @Body() body: { name?: string; parentId?: string | null },
  ) {
    const name = text(body?.name, 120);
    if (!name) throw new BadRequestException("Folder name is required");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      if (body.parentId) {
        const p = await client.query(
          "SELECT 1 FROM document_folders WHERE id = $1",
          [body.parentId],
        );
        if (!p.rows[0])
          throw new BadRequestException("Parent folder not found");
      }
      const res = await client.query(
        `INSERT INTO document_folders (tenant_id, name, parent_id, created_by)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, parent_id, created_at`,
        [claims.tid, name, body.parentId || null, claims.sub],
      );
      return res.rows[0];
    });
  }

  /** Rename and/or move a folder. A folder cannot become its own ancestor. */
  @Patch("folders/:id")
  async updateFolder(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: { name?: string; parentId?: string | null },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const cur = await client.query(
        "SELECT id, name, parent_id FROM document_folders WHERE id = $1",
        [id],
      );
      if (!cur.rows[0]) throw new BadRequestException("Folder not found");

      const sets: string[] = [];
      const params: unknown[] = [];
      const name = body.name === undefined ? undefined : text(body.name, 120);
      if (name !== undefined) {
        if (!name) throw new BadRequestException("Folder name cannot be empty");
        params.push(name);
        sets.push(`name = $${params.length}`);
      }
      if (body.parentId !== undefined) {
        const parentId = body.parentId || null;
        if (parentId === id)
          throw new BadRequestException("A folder cannot be its own parent");
        if (parentId) {
          // Walk up from the proposed parent; if we meet this folder the move
          // would create a cycle.
          let walk: string | null = parentId;
          let hops = 0;
          while (walk && hops++ < 1000) {
            if (walk === id)
              throw new BadRequestException(
                "Cannot move a folder into its own subtree",
              );
            const r: { rows: { parent_id: string | null }[] } =
              await client.query(
                "SELECT parent_id FROM document_folders WHERE id = $1",
                [walk],
              );
            if (!r.rows[0])
              throw new BadRequestException("Parent folder not found");
            walk = r.rows[0].parent_id;
          }
        }
        params.push(parentId);
        sets.push(`parent_id = $${params.length}`);
      }
      if (sets.length === 0) return cur.rows[0];
      params.push(id);
      const res = await client.query(
        `UPDATE document_folders SET ${sets.join(", ")}
         WHERE id = $${params.length}
         RETURNING id, name, parent_id, created_at`,
        params,
      );
      return res.rows[0];
    });
  }

  /** Delete a folder only when empty — no documents and no child folders. */
  @Delete("folders/:id")
  @Roles("owner", "admin")
  async removeFolder(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const exists = await client.query(
        "SELECT 1 FROM document_folders WHERE id = $1",
        [id],
      );
      if (!exists.rows[0]) throw new BadRequestException("Folder not found");
      const docs = await client.query(
        "SELECT count(*)::int AS n FROM documents WHERE folder_id = $1",
        [id],
      );
      const kids = await client.query(
        "SELECT count(*)::int AS n FROM document_folders WHERE parent_id = $1",
        [id],
      );
      if (docs.rows[0].n > 0 || kids.rows[0].n > 0) {
        throw new BadRequestException(
          "Folder is not empty — move or delete its contents first",
        );
      }
      await client.query("DELETE FROM document_folders WHERE id = $1", [id]);
      return { deleted: true };
    });
  }

  // ---- Compliance / summary ----------------------------------------------

  /** Documents whose expiry falls within the next N days (default 30). */
  @Get("expiring")
  async expiring(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("days") days?: string,
  ) {
    const n = Math.min(365, Math.max(1, Number(days) || 30));
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT ${DOC_COLS},
                (d.expires_on - current_date)::int AS days_left
         FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
         WHERE d.expires_on IS NOT NULL
           AND d.expires_on <= current_date + ($1 || ' days')::interval
         ORDER BY d.expires_on ASC`,
        [n],
      );
      return res.rows;
    });
  }

  /** Cabinet overview: counts per category, total size, expiring-soon count. */
  @Get("summary")
  async summary(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const totals = await client.query(
        `SELECT count(*)::int AS total_docs,
                coalesce(sum(size_bytes), 0)::bigint AS total_bytes,
                count(*) FILTER (
                  WHERE expires_on IS NOT NULL
                    AND expires_on <= current_date + interval '30 days'
                )::int AS expiring_soon,
                count(*) FILTER (
                  WHERE expires_on IS NOT NULL AND expires_on < current_date
                )::int AS expired
         FROM documents`,
      );
      const byCat = await client.query(
        `SELECT category, count(*)::int AS n
         FROM documents GROUP BY category ORDER BY category`,
      );
      const folders = await client.query(
        "SELECT count(*)::int AS n FROM document_folders",
      );
      const t = totals.rows[0];
      return {
        total_docs: t.total_docs,
        total_bytes: Number(t.total_bytes),
        expiring_soon: t.expiring_soon,
        expired: t.expired,
        folders: folders.rows[0].n,
        by_category: byCat.rows,
      };
    });
  }

  // ---- Documents ----------------------------------------------------------

  @Get()
  async list(
    @TenantClaims() claims: TenantTokenClaims,
    @Query("entityType") entityType?: string,
    @Query("entityId") entityId?: string,
    @Query("folderId") folderId?: string,
    @Query("category") category?: string,
    @Query("tag") tag?: string,
    @Query("q") q?: string,
    @Query("expiringInDays") expiringInDays?: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const where: string[] = [];
      const params: unknown[] = [];
      // Push a value and return its "$n" placeholder so clauses read cleanly.
      const p = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };

      if (entityType && entityId) {
        where.push(`d.entity_type = ${p(entityType)}`);
        where.push(`d.entity_id = ${p(entityId)}`);
      }
      if (folderId === "root" || folderId === "none") {
        where.push("d.folder_id IS NULL");
      } else if (folderId) {
        where.push(`d.folder_id = ${p(folderId)}`);
      }
      if (category) {
        if (!CATEGORIES.includes(category as never))
          throw new BadRequestException("Unknown category");
        where.push(`d.category = ${p(category)}`);
      }
      if (tag) where.push(`${p(tag.trim())} = ANY(d.tags)`);
      if (q && q.trim()) {
        const like = p(`%${q.trim()}%`);
        where.push(`(d.name ILIKE ${like} OR d.description ILIKE ${like})`);
      }
      if (expiringInDays) {
        const n = Math.min(365, Math.max(1, Number(expiringInDays) || 30));
        where.push(
          `d.expires_on IS NOT NULL AND d.expires_on <= current_date + (${p(n)} || ' days')::interval`,
        );
      }

      const res = await client.query(
        `SELECT ${DOC_COLS}
         FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY d.created_at DESC LIMIT 500`,
        params,
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
      folderId?: string | null;
      category?: string;
      tags?: string[] | string;
      description?: string;
      expiresOn?: string | null;
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
    const category = checkCategory(body.category);
    const tags = normTags(body.tags);
    const description = text(body.description, 1000);
    const expiresOn = isoDateOrNull(body.expiresOn);
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
      if (body.folderId) {
        const f = await client.query(
          "SELECT 1 FROM document_folders WHERE id = $1",
          [body.folderId],
        );
        if (!f.rows[0]) throw new BadRequestException("Folder not found");
      }
      const res = await client.query(
        `INSERT INTO documents (tenant_id, name, mime, size_bytes, data,
                                entity_type, entity_id, uploaded_by,
                                folder_id, category, tags, description, expires_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id, name, size_bytes, category, folder_id, created_at`,
        [
          claims.tid,
          body.name!.trim().slice(0, 200),
          body.mime?.trim() || "application/octet-stream",
          bytes.length,
          bytes,
          body.entityType || null,
          body.entityId || null,
          claims.sub,
          body.folderId || null,
          category,
          tags,
          description,
          expiresOn,
        ],
      );
      return res.rows[0];
    });
  }

  /** Edit metadata (rename, move, recategorize, retag, expiry) — no re-upload. */
  @Patch(":id")
  async updateDocument(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) id: string,
    @Body()
    body: {
      name?: string;
      folderId?: string | null;
      category?: string;
      tags?: string[] | string;
      description?: string | null;
      expiresOn?: string | null;
      entityType?: string | null;
      entityId?: string | null;
    },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const cur = await client.query(
        "SELECT id FROM documents WHERE id = $1",
        [id],
      );
      if (!cur.rows[0]) throw new BadRequestException("Document not found");

      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (col: string, value: unknown): void => {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      };

      if (body.name !== undefined) {
        const name = text(body.name, 200);
        if (!name) throw new BadRequestException("Name cannot be empty");
        push("name", name);
      }
      if (body.folderId !== undefined) {
        if (body.folderId) {
          const f = await client.query(
            "SELECT 1 FROM document_folders WHERE id = $1",
            [body.folderId],
          );
          if (!f.rows[0]) throw new BadRequestException("Folder not found");
        }
        push("folder_id", body.folderId || null);
      }
      if (body.category !== undefined) push("category", checkCategory(body.category));
      if (body.tags !== undefined) push("tags", normTags(body.tags));
      if (body.description !== undefined)
        push("description", text(body.description, 1000));
      if (body.expiresOn !== undefined)
        push("expires_on", isoDateOrNull(body.expiresOn));
      if (body.entityType !== undefined) {
        if (body.entityType && !ENTITY_TYPES.includes(body.entityType as never))
          throw new BadRequestException("Unknown entityType");
        push("entity_type", body.entityType || null);
      }
      if (body.entityId !== undefined) push("entity_id", body.entityId || null);

      if (sets.length === 0) throw new BadRequestException("Nothing to update");
      params.push(id);
      const res = await client.query(
        `UPDATE documents d SET ${sets.join(", ")}
         WHERE d.id = $${params.length}
         RETURNING id, name, folder_id, category, tags, description, expires_on,
                   entity_type, entity_id`,
        params,
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
