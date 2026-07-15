import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Pool, PoolClient } from "pg";
import { loadConfig } from "../config";
import { makePool } from "./pool";

/**
 * Database access with the RLS tenancy contract (04-architecture.md §3):
 *
 * ALL tenant-scoped work goes through withTenant(), which opens a
 * transaction and sets transaction-local `app.current_tenant` /
 * `app.current_user` via set_config(..., is_local => true). Policies key off
 * those settings; when unset they are NULL and every policy denies.
 * Because the settings are transaction-local, this is safe under
 * transaction-mode pooling — nothing leaks across requests.
 *
 * withUser() sets only the user context (pre-tenant-selection flows:
 * listing one's own memberships). query() is for global tables only.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    this.pool = makePool(loadConfig().appDbUrl, 10);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async query(text: string, params?: unknown[]) {
    return this.pool.query(text, params);
  }

  async withTenant<T>(
    tenantId: string,
    userId: string | null,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.inTransaction(async (client) => {
      await client.query(
        "SELECT set_config('app.current_tenant', $1, true), set_config('app.current_user', $2, true)",
        [tenantId, userId ?? ""],
      );
      return fn(client);
    });
  }

  async withUser<T>(
    userId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.inTransaction(async (client) => {
      await client.query("SELECT set_config('app.current_user', $1, true)", [
        userId,
      ]);
      return fn(client);
    });
  }

  private async inTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      // A dead connection makes ROLLBACK itself throw — always surface
      // the original error, not the rollback failure.
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
