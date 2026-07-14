/**
 * Managed-Postgres pre-deploy: create/refresh the runtime roles, then run
 * migrations — fully automatic (used by render.yaml's preDeployCommand).
 *
 * Env: ADMIN_DB_URL (database owner), APP_DB_PASSWORD, WORKER_DB_PASSWORD.
 * Idempotent: roles are created if missing and their passwords re-synced,
 * so rotating the env secrets rotates the DB passwords on next deploy.
 */
import { createHmac } from "node:crypto";
import { Client } from "pg";
import { runMigrations } from "./migrate";

/**
 * When no explicit role password is provided, derive one from JWT_SECRET
 * (same derivation as apps/api/src/config.ts) so single-secret platforms
 * like Railway need only ADMIN_DB_URL + JWT_SECRET to be fully wired.
 */
function derivedPassword(role: string): string | undefined {
  const seed = process.env.JWT_SECRET;
  if (!seed) return undefined;
  return createHmac("sha256", seed).update(`${role}-db-password`).digest("hex");
}

async function main(): Promise<void> {
  const adminUrl = process.env.ADMIN_DB_URL;
  const appPw = process.env.APP_DB_PASSWORD ?? derivedPassword("jenga_app");
  const workerPw =
    process.env.WORKER_DB_PASSWORD ?? derivedPassword("jenga_worker");
  if (!adminUrl) throw new Error("ADMIN_DB_URL is required");
  if (!appPw || !workerPw) {
    throw new Error(
      "Set APP_DB_PASSWORD and WORKER_DB_PASSWORD, or JWT_SECRET to derive them",
    );
  }

  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const dbName = (await client.query("SELECT current_database() AS db"))
      .rows[0].db as string;
    for (const [role, pw] of [
      ["jenga_app", appPw],
      ["jenga_worker", workerPw],
    ] as const) {
      const exists = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [role],
      );
      const quotedPw = pw.replace(/'/g, "''");
      try {
        if (exists.rows[0]) {
          // BYPASSRLS attribute changes need superuser on managed PG;
          // it was already denied at CREATE, so only refresh credentials.
          await client.query(
            `ALTER ROLE ${role} WITH LOGIN PASSWORD '${quotedPw}'`,
          );
        } else {
          await client.query(
            `CREATE ROLE ${role} WITH LOGIN PASSWORD '${quotedPw}' NOBYPASSRLS`,
          );
        }
      } catch (err) {
        // NEVER fail the deploy on role provisioning: the API preflight
        // falls back to the owner connection (FORCE RLS still walls
        // tenants) and logs how to fix. Migrations below must still run.
        console.warn(
          `WARNING: could not provision role ${role} ` +
            `(${err instanceof Error ? err.message : err}). ` +
            `Run db/bootstrap-managed.sql manually per docs/deploy-render.md ` +
            `to restore role-level defence-in-depth.`,
        );
        continue;
      }
      try {
        await client.query(`GRANT CONNECT ON DATABASE "${dbName}" TO ${role}`);
      } catch (err) {
        console.warn(
          `WARNING: could not grant connect to ${role}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    console.log("role provisioning done");
  } finally {
    await client.end();
  }

  await runMigrations(adminUrl);
}

main().catch((err) => {
  // Pre-deploy must never block the service from starting: the API boots
  // regardless and reports database state via /health, where the problem
  // is visible and fixable. Log loudly and let the deploy proceed.
  console.error(
    `WARNING: bootstrap/migrations did not complete (${err instanceof Error ? err.message : err}). ` +
      "The service will start; check /health and the env vars per docs/deploy-render.md.",
  );
  process.exit(0);
});
