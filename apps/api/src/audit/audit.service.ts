import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export interface AuditEntry {
  tenantId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string;
  payload?: Record<string, unknown>;
}

/**
 * Append-only, per-tenant hash-chained audit trail (05-security.md §3).
 * record() MUST be called inside the same withTenant() transaction as the
 * mutation it describes, so the audit entry and the change commit or roll
 * back together. An advisory xact lock serializes writers per tenant so the
 * chain never forks.
 */
@Injectable()
export class AuditService {
  async record(client: PoolClient, entry: AuditEntry): Promise<void> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('audit:' || $1))",
      [entry.tenantId],
    );
    const prevRes = await client.query(
      `SELECT hash FROM audit_log WHERE tenant_id = $1
       ORDER BY id DESC LIMIT 1`,
      [entry.tenantId],
    );
    const prevHash: string | null = prevRes.rows[0]?.hash ?? null;
    const payload = entry.payload ?? {};
    const hash = createHash("sha256")
      .update(prevHash ?? "genesis")
      .update(entry.action)
      .update(entry.entityType)
      .update(entry.entityId ?? "")
      .update(JSON.stringify(payload))
      .digest("hex");
    await client.query(
      `INSERT INTO audit_log
         (tenant_id, actor_user_id, action, entity_type, entity_id, payload, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.tenantId,
        entry.actorUserId,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        JSON.stringify(payload),
        prevHash,
        hash,
      ],
    );
  }
}
