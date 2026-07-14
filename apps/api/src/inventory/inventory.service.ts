import { BadRequestException, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";

/**
 * Inventory: append-only stock movements; on-hand is always SUM(qty_delta).
 * recordMovement serializes per item+branch (advisory lock) and refuses to
 * take tracked stock negative — overselling is blocked at issue time, not
 * discovered at stock-take.
 */
@Injectable()
export class InventoryService {
  async recordMovement(
    client: PoolClient,
    args: {
      tenantId: string;
      itemId: string;
      branchId: string;
      qtyDelta: number;
      reason: "purchase" | "sale" | "adjustment" | "transfer_in" | "transfer_out";
      refType?: string;
      refId?: string;
      userId?: string | null;
    },
  ): Promise<{ onHand: number }> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('stock:' || $1 || ':' || $2))",
      [args.itemId, args.branchId],
    );
    const current = await client.query(
      `SELECT coalesce(sum(qty_delta), 0) AS on_hand
       FROM stock_movements WHERE item_id = $1 AND branch_id = $2`,
      [args.itemId, args.branchId],
    );
    const onHand = Number(current.rows[0].on_hand);
    const after = onHand + args.qtyDelta;
    if (args.qtyDelta < 0) {
      const tracked = await client.query(
        "SELECT track_stock, name FROM items WHERE id = $1",
        [args.itemId],
      );
      if (tracked.rows[0]?.track_stock && after < 0) {
        throw new BadRequestException(
          `Insufficient stock for ${tracked.rows[0].name}: on hand ${onHand}, needed ${-args.qtyDelta}`,
        );
      }
    }
    await client.query(
      `INSERT INTO stock_movements
         (tenant_id, item_id, branch_id, qty_delta, reason, ref_type, ref_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        args.tenantId,
        args.itemId,
        args.branchId,
        args.qtyDelta,
        args.reason,
        args.refType ?? null,
        args.refId ?? null,
        args.userId ?? null,
      ],
    );
    return { onHand: after };
  }

  async stockLevels(
    client: PoolClient,
  ): Promise<{ itemId: string; sku: string; name: string; branchId: string; onHand: number }[]> {
    const res = await client.query(
      `SELECT i.id AS item_id, i.sku, i.name, sm.branch_id,
              coalesce(sum(sm.qty_delta), 0) AS on_hand
       FROM items i
       LEFT JOIN stock_movements sm ON sm.item_id = i.id
       GROUP BY i.id, sm.branch_id
       ORDER BY i.sku`,
    );
    return res.rows.map((r) => ({
      itemId: r.item_id,
      sku: r.sku,
      name: r.name,
      branchId: r.branch_id,
      onHand: Number(r.on_hand),
    }));
  }
}
