/**
 * Integration tests against jenga_test:
 *  - statutory rules store: effective-date resolution (NSSF Y3 vs Y4)
 *  - fiscal queue: enqueue idempotency, two-phase signing, monotonic
 *    per-branch sequence, retry/backoff, dead-letter, RLS isolation,
 *    and jenga_worker role confinement.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { FiscalService, FISCAL_PROVIDER } from "../src/fiscal/fiscal.service";
import { SandboxFiscalProvider } from "../src/fiscal/provider";
import { DbService } from "../src/db/db.service";
import { RulesService } from "../src/rules/rules.service";

process.env.APP_DB_URL =
  process.env.APP_DB_URL_TEST ??
  "postgres://jenga_app:app_dev_pw@localhost:5432/jenga_test";
process.env.WORKER_DB_URL =
  process.env.WORKER_DB_URL_TEST ??
  "postgres://jenga_worker:worker_dev_pw@localhost:5432/jenga_test";

describe("statutory rules store", () => {
  const db = new DbService();
  const rules = new RulesService(db);

  afterAll(async () => {
    await db.onModuleDestroy();
  });

  test("resolves NSSF Year 3 vs Year 4 by date", async () => {
    const y3 = await rules.get<{ uelCents: number }>("nssf", "2025-06-15");
    expect(y3.uelCents).toBe(7_200_000);
    const y4 = await rules.get<{ uelCents: number }>("nssf", "2026-03-01");
    expect(y4.uelCents).toBe(10_800_000);
  });

  test("PAYE bands effective since 2023 resolve today", async () => {
    const paye = await rules.get<{ personalReliefCents: number }>(
      "paye",
      "2026-07-14",
    );
    expect(paye.personalReliefCents).toBe(240_000);
  });

  test("unknown rule or pre-effective date throws", async () => {
    await expect(rules.get("shif", "2024-01-01")).rejects.toThrow(/No statutory/);
    await expect(rules.get("nope", "2026-01-01")).rejects.toThrow(/No statutory/);
  });
});

describe("fiscal queue", () => {
  const db = new DbService();
  const fiscal = new FiscalService(new SandboxFiscalProvider());
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let branchA: string;

  const drain = async (): Promise<void> => {
    // Run the worker until the queue has nothing due right now.
    for (let i = 0; i < 20; i++) {
      const processed = await fiscal.processOnce();
      if (!processed) return;
    }
  };

  beforeAll(async () => {
    const suffix = randomUUID().slice(0, 8);
    const u = await db.query(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1, 'x', 'Fiscal Tester') RETURNING id`,
      [`fiscal-${suffix}@test.local`],
    );
    userA = u.rows[0].id;
    const tA = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      [`fiscal-a`, `fiscal-a-${suffix}`, userA],
    );
    tenantA = tA.rows[0].id;
    const tB = await db.query(
      "SELECT create_tenant_with_owner($1, $2, $3) AS id",
      [`fiscal-b`, `fiscal-b-${suffix}`, userA],
    );
    tenantB = tB.rows[0].id;
    branchA = await db.withTenant(tenantA, userA, async (c) => {
      const r = await c.query(
        `INSERT INTO branches (tenant_id, code, name)
         VALUES ($1, 'HQ', 'Head Office') RETURNING id`,
        [tenantA],
      );
      return r.rows[0].id;
    });
  });

  afterAll(async () => {
    await fiscal.onModuleDestroy();
    await db.onModuleDestroy();
  });

  test("enqueue is idempotent per (tenant, idempotencyKey)", async () => {
    const first = await db.withTenant(tenantA, userA, (c) =>
      fiscal.enqueue(c, tenantA, {
        branchId: branchA,
        docType: "invoice",
        idempotencyKey: "inv-001",
        payload: { totalCents: 116000, lines: [{ desc: "Maize flour" }] },
      }),
    );
    expect(first.deduplicated).toBe(false);
    const again = await db.withTenant(tenantA, userA, (c) =>
      fiscal.enqueue(c, tenantA, {
        branchId: branchA,
        docType: "invoice",
        idempotencyKey: "inv-001",
        payload: { totalCents: 116000 },
      }),
    );
    expect(again.deduplicated).toBe(true);
    expect(again.id).toBe(first.id);
  });

  test("worker signs pending docs with monotonic per-branch sequence", async () => {
    await db.withTenant(tenantA, userA, (c) =>
      fiscal.enqueue(c, tenantA, {
        branchId: branchA,
        docType: "invoice",
        idempotencyKey: "inv-002",
        payload: { totalCents: 250000 },
      }),
    );
    await drain();

    const docs = await db.withTenant(tenantA, userA, async (c) => {
      const r = await c.query(
        `SELECT idempotency_key, status, seq, control_number, qr_payload
         FROM fiscal_documents WHERE branch_id = $1 ORDER BY seq`,
        [branchA],
      );
      return r.rows;
    });
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.status)).toEqual(["signed", "signed"]);
    expect(docs.map((d) => Number(d.seq))).toEqual([1, 2]);
    for (const d of docs) {
      expect(d.control_number).toMatch(/^SBX\d{10}$/);
      expect(d.qr_payload).toContain("etims-sbx.kra.go.ke/verify/");
    }
  });

  test("transient failure retries with backoff; permanent goes dead_letter", async () => {
    const transient = await db.withTenant(tenantA, userA, (c) =>
      fiscal.enqueue(c, tenantA, {
        branchId: branchA,
        docType: "invoice",
        idempotencyKey: "inv-transient",
        payload: { simulate: "transient-fail" },
      }),
    );
    const permanent = await db.withTenant(tenantA, userA, (c) =>
      fiscal.enqueue(c, tenantA, {
        branchId: branchA,
        docType: "credit_note",
        idempotencyKey: "cn-reject",
        payload: { simulate: "permanent-reject" },
      }),
    );
    await drain();

    const rows = await db.withTenant(tenantA, userA, async (c) => {
      const r = await c.query(
        `SELECT id, status, attempts, last_error, next_attempt_at > now() AS backed_off
         FROM fiscal_documents WHERE id = ANY($1)`,
        [[transient.id, permanent.id]],
      );
      return Object.fromEntries(r.rows.map((row) => [row.id, row]));
    });

    expect(rows[transient.id].status).toBe("failed");
    expect(rows[transient.id].attempts).toBe(1);
    expect(rows[transient.id].backed_off).toBe(true);
    expect(rows[transient.id].last_error).toMatch(/timeout/);

    expect(rows[permanent.id].status).toBe("dead_letter");
    expect(rows[permanent.id].last_error).toMatch(/rejection/);
  });

  test("fiscal queue is RLS-isolated between tenants", async () => {
    const fromB = await db.withTenant(tenantB, userA, async (c) => {
      const r = await c.query("SELECT count(*)::int AS n FROM fiscal_documents");
      return r.rows[0].n;
    });
    expect(fromB).toBe(0);
  });

  test("jenga_worker role touches fiscal_documents and nothing else", async () => {
    const workerPool = new Pool({
      connectionString: process.env.WORKER_DB_URL,
      max: 1,
    });
    try {
      const ok = await workerPool.query(
        "SELECT count(*) FROM fiscal_documents",
      );
      expect(ok.rows[0].count).toBeDefined();
      for (const table of ["users", "tenants", "memberships", "audit_log", "statutory_rules", "branches"]) {
        await expect(
          workerPool.query(`SELECT * FROM ${table} LIMIT 1`),
        ).rejects.toThrow(/permission denied/i);
      }
      await expect(
        workerPool.query("DELETE FROM fiscal_documents"),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        workerPool.query(
          "INSERT INTO fiscal_documents (tenant_id, branch_id, doc_type, idempotency_key, payload) VALUES ($1, $2, 'invoice', 'evil', '{}')",
          [tenantA, branchA],
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await workerPool.end();
    }
  });
});
