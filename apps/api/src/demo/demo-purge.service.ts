import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Pool } from "pg";
import { loadConfig } from "../config";
import { makePool } from "../db/pool";

/** How often the reaper scans for expired demo tenants. */
const PURGE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Reaper for self-expiring demo tenants (migration 0029). Every ~15 minutes it
 * finds demo tenants past their expiry and erases each one — all of its rows
 * across every tenant-scoped table, its memberships, and its demo user(s).
 *
 * The destructive work lives in the SECURITY DEFINER SQL function
 * purge_demo_tenant(): it runs as the table owner (so it can reach the global
 * tables and the append-only audit_log that the NOBYPASSRLS worker role
 * cannot), suspends FK + audit triggers for the transaction so tables delete
 * in any order, and — critically — REFUSES to touch any tenant that is not
 * is_demo=true. We only ever pass it ids we selected with is_demo AND expired,
 * so the guard is enforced twice: here and in the database.
 *
 * Runs on the jenga_worker connection (cross-tenant), mirroring FiscalService.
 */
@Injectable()
export class DemoPurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DemoPurgeService.name);
  private readonly workerPool: Pool;
  private timer?: NodeJS.Timeout;

  constructor() {
    this.workerPool = makePool(loadConfig().workerDbUrl, 2);
  }

  onModuleInit(): void {
    // Default ON; opt out with DEMO_PURGE_ENABLED=false (e.g. in some tests).
    if (process.env.DEMO_PURGE_ENABLED !== "false") {
      this.timer = setInterval(() => {
        void this.purgeExpired().catch((err) =>
          this.logger.error(`demo purge sweep failed: ${err}`),
        );
      }, PURGE_INTERVAL_MS);
      this.timer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.workerPool.end();
  }

  /** Reap every demo tenant whose 24h window has closed. Returns the ids. */
  async purgeExpired(): Promise<string[]> {
    const due = await this.workerPool.query(
      "SELECT id FROM list_expired_demo_tenants($1) AS id",
      [100],
    );
    const purged: string[] = [];
    for (const row of due.rows as { id: string }[]) {
      try {
        await this.purgeTenant(row.id);
        purged.push(row.id);
      } catch (err) {
        this.logger.error(`failed to purge demo tenant ${row.id}: ${err}`);
      }
    }
    if (purged.length) {
      this.logger.log(`purged ${purged.length} expired demo tenant(s)`);
    }
    return purged;
  }

  /**
   * Purge one tenant. The DB function is the authority on the is_demo guard —
   * it raises if the tenant is not a demo — so a real tenant id can never be
   * reaped even if one were passed in by mistake. Each purge is its own
   * transaction (the function call is a single statement).
   */
  async purgeTenant(tenantId: string): Promise<{ tablesCleared: number; usersDeleted: number }> {
    const res = await this.workerPool.query(
      "SELECT purge_demo_tenant($1) AS result",
      [tenantId],
    );
    const result = res.rows[0].result as {
      tables_cleared: number;
      users_deleted: number;
    };
    this.logger.log(
      `purged demo tenant ${tenantId}: ` +
        `${result.tables_cleared} tables cleared, ` +
        `${result.users_deleted} user(s) deleted`,
    );
    return {
      tablesCleared: result.tables_cleared,
      usersDeleted: result.users_deleted,
    };
  }
}
