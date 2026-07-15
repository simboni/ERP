import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import { loadConfig } from "../config";
import { makePool } from "../db/pool";

export const NOTIFICATION_PROVIDER = "NOTIFICATION_PROVIDER";

export interface NotificationSendRequest {
  channel: "sms" | "whatsapp" | "email";
  recipient: string;
  body: string;
}

export interface NotificationProvider {
  send(req: NotificationSendRequest): Promise<{ providerRef: string }>;
}

/** Sandbox provider: succeeds deterministically; real adapters (Africa's
 *  Talking SMS, WhatsApp Business Cloud API) implement the same interface. */
export class SandboxNotificationProvider implements NotificationProvider {
  sent: NotificationSendRequest[] = [];
  async send(req: NotificationSendRequest): Promise<{ providerRef: string }> {
    if (req.recipient.endsWith("0000000")) {
      throw new Error("sandbox: undeliverable recipient");
    }
    this.sent.push(req);
    return { providerRef: `NTF-SBX-${this.sent.length}` };
  }
}

/** Message templates — Swahili/English pairs land with the i18n pass. */
const TEMPLATES: Record<string, (p: Record<string, unknown>) => string> = {
  invoice_issued: (p) =>
    `${p.businessName}: Invoice #${p.invoiceNo} for KES ${p.totalKes}. ` +
    `Pay via M-Pesa paybill ${p.paybill ?? "-"}, account INV-${p.invoiceNo}. ` +
    `eTIMS: ${p.controlNumber ?? "processing"}`,
  payment_received: (p) =>
    `${p.businessName}: Payment of KES ${p.amountKes} received (${p.receipt}). ` +
    `Invoice #${p.invoiceNo} is now PAID. Asante!`,
  deadline_reminder: (p) =>
    `${p.businessName}: ${p.label} due ${p.dueDate} (${p.daysRemaining} days). ` +
    `Jenga ERP has your figures ready.`,
};

const MAX_ATTEMPTS = 5;
const STALE_SENDING_SECONDS = 120;

/**
 * Durable notification outbox: enqueue() joins the caller's tenant
 * transaction so the message and the business event commit together;
 * the worker sends two-phase (claim -> external call -> finalize) exactly
 * like the fiscal queue.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly workerPool: Pool;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(NOTIFICATION_PROVIDER) private readonly provider: NotificationProvider,
  ) {
    this.workerPool = makePool(loadConfig().workerDbUrl, 2);
  }

  onModuleInit(): void {
    if (process.env.NOTIFY_WORKER_ENABLED === "true") {
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

  render(templateKey: string, payload: Record<string, unknown>): string {
    const template = TEMPLATES[templateKey];
    if (!template) throw new Error(`Unknown template: ${templateKey}`);
    return template(payload);
  }

  async enqueue(
    client: PoolClient,
    tenantId: string,
    input: {
      channel: "sms" | "whatsapp" | "email";
      recipient: string;
      templateKey: string;
      payload: Record<string, unknown>;
    },
  ): Promise<string> {
    const rendered = this.render(input.templateKey, input.payload);
    const res = await client.query(
      `INSERT INTO notifications
         (tenant_id, channel, recipient, template_key, payload, rendered)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        tenantId,
        input.channel,
        input.recipient,
        input.templateKey,
        JSON.stringify(input.payload),
        rendered,
      ],
    );
    return res.rows[0].id;
  }

  async processOnce(): Promise<string | null> {
    const client = await this.workerPool.connect();
    let claimed: {
      id: string;
      channel: "sms" | "whatsapp" | "email";
      recipient: string;
      rendered: string;
      attempts: number;
    } | null = null;
    try {
      await client.query("BEGIN");
      const due = await client.query(
        `SELECT id, channel, recipient, rendered, attempts
         FROM notifications
         WHERE (status IN ('pending', 'failed') AND next_attempt_at <= now())
            OR (status = 'sending'
                AND next_attempt_at <= now() - interval '${STALE_SENDING_SECONDS} seconds')
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      if (!due.rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      claimed = { ...due.rows[0], attempts: due.rows[0].attempts + 1 };
      await client.query(
        `UPDATE notifications
         SET status = 'sending', attempts = attempts + 1, next_attempt_at = now()
         WHERE id = $1`,
        [claimed!.id],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    try {
      const res = await this.provider.send({
        channel: claimed!.channel,
        recipient: claimed!.recipient,
        body: claimed!.rendered,
      });
      await this.workerPool.query(
        `UPDATE notifications
         SET status = 'sent', provider_ref = $2, sent_at = now(), last_error = NULL
         WHERE id = $1`,
        [claimed!.id, res.providerRef],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (claimed!.attempts >= MAX_ATTEMPTS) {
        await this.workerPool.query(
          `UPDATE notifications SET status = 'dead_letter', last_error = $2 WHERE id = $1`,
          [claimed!.id, message],
        );
      } else {
        await this.workerPool.query(
          `UPDATE notifications
           SET status = 'failed', last_error = $2,
               next_attempt_at = now() + make_interval(secs => $3)
           WHERE id = $1`,
          [claimed!.id, message, Math.min(2 ** claimed!.attempts, 60)],
        );
      }
    }
    return claimed!.id;
  }
}
