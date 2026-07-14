/**
 * Minimal, auditable SQL migration runner.
 * Applies db/migrations/*.sql in filename order, each inside a transaction,
 * recording applied files in schema_migrations. Connects as jenga_migrator.
 *
 *   ADMIN_DB_URL=postgres://jenga_migrator:...@host/db pnpm db:migrate
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const MIGRATIONS_DIR = join(__dirname, "migrations");
const ADMIN_DB_URL =
  process.env.ADMIN_DB_URL ??
  "postgres://jenga_migrator:migrator_dev_pw@localhost:5432/jenga_dev";

export async function runMigrations(adminUrl: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    // Serialize concurrent runners (e.g. two deploy jobs racing).
    await client.query("SELECT pg_advisory_lock(hashtext('schema_migrations'))");

    const applied = new Set(
      (await client.query("SELECT filename FROM schema_migrations")).rows.map(
        (r: { filename: string }) => r.filename,
      ),
    );
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      process.stdout.write(`applying ${file} ... `);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        process.stdout.write("ok\n");
      } catch (err) {
        await client.query("ROLLBACK");
        process.stdout.write("FAILED\n");
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations(ADMIN_DB_URL).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
