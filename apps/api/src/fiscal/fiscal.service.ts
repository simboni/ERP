import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { loadConfig } from "../config";
import {
  FiscalPermanentError,
  FiscalProvider,
  FiscalTransientError,
} from "./provider";

export const FISCAL_PROVIDER = "FISCAL_PROVIDER";

const MAX_ATTEMPTS = 5;
/** Exponential backoff in seconds by attempt number, capped. */
function backoffSeconds(attempt: number): number {
  return Math.min(2 ** attempt, 60);
}
/** A claim older than this is presumed crashed and gets reclaimed. */
const STALE_CLAIM_SECONDS = 120;

export interface EnqueueInput {
  branchId: string;
  docType: "invoice" | "credit_note";
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

/**
 * Durable eTIMS signing queue (04-architecture.md §5).
 *
 * enqueue() runs on the caller's tenant transaction (RLS-scoped, commits
 * atomically with the business document that needs fiscalizing).
 *
 * The worker runs on a SEPARATE pool as jenga_worker — a role whose grants
 * and policies reach fiscal_documents and nothing else. Processing is
 * two-phase so no DB transaction is ever held across the external KRA call:
 *   claim   — pick one due pending/failed/stale-signing row FOR UPDATE SKIP
 *             LOCKED, assign the per-branch monotonic seq, mark 'signing'.
 *   finalize— after the provider call: 'signed' (control number + QR),
 *             retry with exponential backoff, or 'dead_letter'.
 * If we crash between the phases, the stale-claim reclaim picks it up.
 */
@Injectable()
export class FiscalService implements OnModuleInit, OnModuleDestroy {
  private readonly workerPool: Pool;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(FISCAL_PROVIDER) private readonly provider: FiscalProvider,
  ) {
    this.workerPool = new Pool({
      connectionString: loadConfig().workerDbUrl,
      max: 2,
    });
  }

  onModuleInit(): void {
    if (process.env.FISCAL_WORKER_ENABLED === "true") {
      this.timer = setInterval(() => {
        void this.processOnce().catch(() => undefined);
      }, 1000);
      this.timer.unref();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.workerPool.end();
  }

  /** Idempotent enqueue inside the caller's tenant transaction. */
  async enqueue(
    client: PoolClient,
    tenantId: string,
    input: EnqueueInput,
  ): Promise<{ id: string; status: string; deduplicated: boolean }> {
    const inserted = await client.query(
      `INSERT INTO fiscal_documents
         (tenant_id, branch_id, doc_type, idempotency_key, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING id, status`,
      [
        tenantId,
        input.branchId,
        input.docType,
        input.idempotencyKey,
        JSON.stringify(input.payload),
      ],
    );
    if (inserted.rows[0]) {
      return { ...inserted.rows[0], deduplicated: false };
    }
    const existing = await client.query(
      `SELECT id, status FROM fiscal_documents
       WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, input.idempotencyKey],
    );
    return { ...existing.rows[0], deduplicated: true };
  }

  /**
   * Process at most one due document. Returns the document id or null if
   * the queue is empty. Called by the interval worker; called directly and
   * deterministically by tests.
   */
  async processOnce(): Promise<string | null> {
    const claimed = await this.claim();
    if (!claimed) return null;

    try {
      const result = await this.provider.sign({
        tenantId: claimed.tenant_id,
        branchId: claimed.branch_id,
        docType: claimed.doc_type,
        seq: Number(claimed.seq),
        payload: claimed.payload,
      });
      await this.workerPool.query(
        `UPDATE fiscal_documents
         SET status = 'signed', control_number = $2, qr_payload = $3,
             signed_at = now(), last_error = NULL
         WHERE id = $1`,
        [claimed.id, result.controlNumber, result.qrPayload],
      );
    } catch (err) {
      await this.handleFailure(claimed.id, claimed.attempts, err);
    }
    return claimed.id;
  }

  private async claim(): Promise<
    | {
        id: string;
        tenant_id: string;
        branch_id: string;
        doc_type: "invoice" | "credit_note";
        seq: string;
        attempts: number;
        payload: Record<string, unknown>;
      }
    | null
  > {
    const client = await this.workerPool.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query(
        `SELECT id, tenant_id, branch_id, doc_type, seq, attempts, payload
         FROM fiscal_documents
         WHERE (status IN ('pending', 'failed') AND next_attempt_at <= now())
            OR (status = 'signing'
                AND next_attempt_at <= now() - interval '${STALE_CLAIM_SECONDS} seconds')
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      const doc = due.rows[0];
      if (!doc) {
        await client.query("COMMIT");
        return null;
      }

      let seq: string = doc.seq;
      if (seq === null) {
        // Per-branch monotonic sequence: serialize assignment per branch.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('fiscal-seq:' || $1))",
          [doc.branch_id],
        );
        const next = await client.query(
          `SELECT coalesce(max(seq), 0) + 1 AS next
           FROM fiscal_documents
           WHERE tenant_id = $1 AND branch_id = $2`,
          [doc.tenant_id, doc.branch_id],
        );
        seq = next.rows[0].next;
      }

      await client.query(
        `UPDATE fiscal_documents
         SET status = 'signing', seq = $2, attempts = attempts + 1,
             next_attempt_at = now()
         WHERE id = $1`,
        [doc.id, seq],
      );
      await client.query("COMMIT");
      return { ...doc, seq, attempts: doc.attempts + 1 };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async handleFailure(
    id: string,
    attempts: number,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const permanent = err instanceof FiscalPermanentError;
    const exhausted = attempts >= MAX_ATTEMPTS;
    if (permanent || exhausted) {
      await this.workerPool.query(
        `UPDATE fiscal_documents
         SET status = 'dead_letter', last_error = $2
         WHERE id = $1`,
        [id, message],
      );
      return;
    }
    const transientish =
      err instanceof FiscalTransientError ? message : `unexpected: ${message}`;
    await this.workerPool.query(
      `UPDATE fiscal_documents
       SET status = 'failed', last_error = $2,
           next_attempt_at = now() + make_interval(secs => $3)
       WHERE id = $1`,
      [id, transientish, backoffSeconds(attempts)],
    );
  }
}
