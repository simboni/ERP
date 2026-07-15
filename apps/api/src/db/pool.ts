import { Pool } from "pg";

/**
 * All pg pools MUST be created through here. node-postgres emits 'error'
 * on the pool when an idle client's connection is dropped (managed
 * databases and their proxies do this routinely); with no listener that
 * event crashes the entire process. The client is already discarded by
 * the pool — logging is the only correct action.
 */
export function makePool(connectionString: string, max: number): Pool {
  const pool = new Pool({ connectionString, max, keepAlive: true });
  pool.on("error", (err) => {
    console.warn(
      `pg pool: idle connection dropped (${err.message}) — continuing`,
    );
  });
  return pool;
}
