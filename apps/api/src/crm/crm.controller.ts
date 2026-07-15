import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { TenantTokenClaims } from "@jenga/shared";
import {
  JwtAuthGuard,
  Roles,
  RolesGuard,
  TenantClaims,
  TenantContextGuard,
} from "../auth/guards";
import { DbService } from "../db/db.service";
import { QuotesService } from "../invoicing/quotes.service";

const CRM_ROLES = ["owner", "admin", "accountant", "cashier"] as const;
const CONTACT_STAGES = ["lead", "opportunity", "customer"] as const;
const DEAL_STAGES = ["new", "qualified", "proposal", "won", "lost"] as const;

/**
 * CRM: contacts move lead -> opportunity -> customer; deals carry values
 * through a pipeline; activities record touches and follow-ups. Winning
 * is wired into the money engine: a deal converts into a draft quote for
 * the (auto-created) accounting customer, so the funnel ends in an
 * eTIMS-ready document, not a dead end.
 */
@Controller("tenants/current/crm")
@UseGuards(JwtAuthGuard, TenantContextGuard, RolesGuard)
export class CrmController {
  constructor(
    private readonly db: DbService,
    private readonly quotes: QuotesService,
  ) {}

  @Get("summary")
  async summary(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const [pipeline, followUps, stages] = await Promise.all([
        client.query(
          `SELECT stage, count(*)::int AS deals,
                  coalesce(sum(value_cents), 0)::bigint AS value_cents
           FROM deals GROUP BY stage`,
        ),
        client.query(
          `SELECT a.id, a.kind, a.body, a.due_date, c.name AS contact_name
           FROM crm_activities a
           JOIN crm_contacts c ON c.id = a.contact_id
           WHERE NOT a.done AND a.due_date IS NOT NULL
             AND a.due_date <= current_date + 7
           ORDER BY a.due_date
           LIMIT 20`,
        ),
        client.query(
          `SELECT stage, count(*)::int AS contacts
           FROM crm_contacts GROUP BY stage`,
        ),
      ]);
      return {
        pipeline: pipeline.rows,
        followUps: followUps.rows,
        contactStages: stages.rows,
      };
    });
  }

  @Get("contacts")
  async listContacts(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT ct.id, ct.name, ct.company, ct.phone, ct.email, ct.stage,
                ct.source, ct.customer_id, ct.created_at,
                count(d.id) FILTER (WHERE d.stage NOT IN ('won','lost'))::int
                  AS open_deals
         FROM crm_contacts ct
         LEFT JOIN deals d ON d.contact_id = ct.id
         GROUP BY ct.id
         ORDER BY ct.created_at DESC
         LIMIT 500`,
      );
      return res.rows;
    });
  }

  @Post("contacts")
  @Roles(...CRM_ROLES)
  async createContact(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      name?: string;
      company?: string;
      phone?: string;
      email?: string;
      source?: string;
    },
  ) {
    if (!body?.name?.trim()) throw new BadRequestException("name is required");
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO crm_contacts (tenant_id, name, company, phone, email,
                                   source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, stage`,
        [
          claims.tid,
          body.name!.trim(),
          body.company?.trim() || null,
          body.phone?.trim() || null,
          body.email?.trim() || null,
          body.source?.trim() || null,
          claims.sub,
        ],
      );
      return res.rows[0];
    });
  }

  @Patch("contacts/:id")
  @Roles(...CRM_ROLES)
  async editContact(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) contactId: string,
    @Body()
    body: {
      name?: string;
      company?: string;
      phone?: string;
      email?: string;
      source?: string;
    },
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `UPDATE crm_contacts SET
           name    = coalesce($2, name),
           company = coalesce($3, company),
           phone   = coalesce($4, phone),
           email   = coalesce($5, email),
           source  = coalesce($6, source)
         WHERE id = $1
         RETURNING id, name, company, phone, email, stage, source`,
        [
          contactId,
          body.name?.trim() || null,
          body.company?.trim() || null,
          body.phone?.trim() || null,
          body.email?.trim() || null,
          body.source?.trim() || null,
        ],
      );
      if (!res.rows[0]) throw new NotFoundException("Contact not found");
      return res.rows[0];
    });
  }

  @Post("contacts/:id/stage")
  @HttpCode(200)
  @Roles(...CRM_ROLES)
  async setContactStage(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) contactId: string,
    @Body() body: { stage?: string },
  ) {
    if (!CONTACT_STAGES.includes(body?.stage as never)) {
      throw new BadRequestException(
        `stage must be one of ${CONTACT_STAGES.join(" | ")}`,
      );
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      // Graduating to 'customer' materializes an accounting customer so
      // invoices/quotes can be raised immediately.
      if (body.stage === "customer") {
        const ct = (
          await client.query(
            `SELECT * FROM crm_contacts WHERE id = $1 FOR UPDATE`,
            [contactId],
          )
        ).rows[0];
        if (!ct) throw new BadRequestException("Contact not found");
        if (!ct.customer_id) {
          const cust = await client.query(
            `INSERT INTO customers (tenant_id, name, phone, email)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [claims.tid, ct.company ?? ct.name, ct.phone, ct.email],
          );
          await client.query(
            "UPDATE crm_contacts SET customer_id = $2 WHERE id = $1",
            [contactId, cust.rows[0].id],
          );
        }
      }
      const res = await client.query(
        `UPDATE crm_contacts SET stage = $2 WHERE id = $1
         RETURNING id, stage, customer_id`,
        [contactId, body.stage],
      );
      if (!res.rows[0]) throw new BadRequestException("Contact not found");
      return res.rows[0];
    });
  }

  @Get("deals")
  async listDeals(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT d.id, d.title, d.value_cents, d.stage, d.expected_close,
                d.quote_id, d.created_at, c.name AS contact_name, c.id AS contact_id
         FROM deals d JOIN crm_contacts c ON c.id = d.contact_id
         ORDER BY d.created_at DESC LIMIT 500`,
      );
      return res.rows;
    });
  }

  @Post("deals")
  @Roles(...CRM_ROLES)
  async createDeal(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      contactId?: string;
      title?: string;
      valueCents?: number;
      expectedClose?: string;
    },
  ) {
    if (!body?.contactId || !body?.title?.trim()) {
      throw new BadRequestException("contactId and title are required");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO deals (tenant_id, contact_id, title, value_cents,
                            expected_close, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, title, stage, value_cents`,
        [
          claims.tid,
          body.contactId,
          body.title!.trim(),
          Math.max(0, Math.round(body.valueCents ?? 0)),
          body.expectedClose || null,
          claims.sub,
        ],
      );
      return res.rows[0];
    });
  }

  @Post("deals/:id/stage")
  @HttpCode(200)
  @Roles(...CRM_ROLES)
  async setDealStage(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) dealId: string,
    @Body() body: { stage?: string },
  ) {
    if (!DEAL_STAGES.includes(body?.stage as never)) {
      throw new BadRequestException(
        `stage must be one of ${DEAL_STAGES.join(" | ")}`,
      );
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `UPDATE deals SET stage = $2 WHERE id = $1 RETURNING id, stage`,
        [dealId, body.stage],
      );
      if (!res.rows[0]) throw new BadRequestException("Deal not found");
      return res.rows[0];
    });
  }

  /**
   * Convert a deal into a draft quote: graduates the contact to customer
   * (creating the accounting record if needed) and creates a one-line
   * draft quote at the deal's value. Returns the quote id for editing.
   */
  @Post("deals/:id/quote")
  @HttpCode(200)
  @Roles(...CRM_ROLES)
  async dealToQuote(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) dealId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const deal = (
        await client.query(`SELECT * FROM deals WHERE id = $1 FOR UPDATE`, [
          dealId,
        ])
      ).rows[0];
      if (!deal) throw new BadRequestException("Deal not found");
      if (deal.quote_id) {
        return { quoteId: deal.quote_id, alreadyConverted: true };
      }
      if (Number(deal.value_cents) <= 0) {
        throw new BadRequestException(
          "Set a deal value before converting to a quote",
        );
      }
      const contact = (
        await client.query(
          `SELECT * FROM crm_contacts WHERE id = $1 FOR UPDATE`,
          [deal.contact_id],
        )
      ).rows[0];
      let customerId: string = contact.customer_id;
      if (!customerId) {
        const cust = await client.query(
          `INSERT INTO customers (tenant_id, name, phone, email)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [
            claims.tid,
            contact.company ?? contact.name,
            contact.phone,
            contact.email,
          ],
        );
        customerId = cust.rows[0].id;
        await client.query(
          `UPDATE crm_contacts SET customer_id = $2, stage = 'customer'
           WHERE id = $1`,
          [contact.id, customerId],
        );
      }
      const branch = (
        await client.query("SELECT id FROM branches ORDER BY created_at LIMIT 1")
      ).rows[0];
      if (!branch) {
        throw new BadRequestException(
          "Create a branch first (Settings) — quotes need one",
        );
      }
      const quote = await this.quotes.createDraft(client, {
        tenantId: claims.tid,
        userId: claims.sub,
        branchId: branch.id,
        customerId,
        lines: [
          {
            description: deal.title,
            quantity: 1,
            unitPriceCents: Number(deal.value_cents),
            vatRate: "0.16",
          },
        ],
      });
      await client.query("UPDATE deals SET quote_id = $2 WHERE id = $1", [
        dealId,
        quote.id,
      ]);
      return { quoteId: quote.id, quoteNo: quote.quoteNo };
    });
  }

  @Get("activities")
  async listActivities(@TenantClaims() claims: TenantTokenClaims) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `SELECT a.id, a.kind, a.body, a.due_date, a.done, a.created_at,
                c.name AS contact_name, d.title AS deal_title
         FROM crm_activities a
         JOIN crm_contacts c ON c.id = a.contact_id
         LEFT JOIN deals d ON d.id = a.deal_id
         ORDER BY a.done ASC, a.due_date NULLS LAST, a.created_at DESC
         LIMIT 300`,
      );
      return res.rows;
    });
  }

  @Post("activities")
  @Roles(...CRM_ROLES)
  async createActivity(
    @TenantClaims() claims: TenantTokenClaims,
    @Body()
    body: {
      contactId?: string;
      dealId?: string;
      kind?: string;
      body?: string;
      dueDate?: string;
    },
  ) {
    if (!body?.contactId || !body?.body?.trim()) {
      throw new BadRequestException("contactId and body are required");
    }
    const kind = body.kind ?? "note";
    if (!["note", "call", "meeting", "task"].includes(kind)) {
      throw new BadRequestException("kind must be note | call | meeting | task");
    }
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `INSERT INTO crm_activities
           (tenant_id, contact_id, deal_id, kind, body, due_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, kind, due_date`,
        [
          claims.tid,
          body.contactId,
          body.dealId || null,
          kind,
          body.body!.trim(),
          body.dueDate || null,
          claims.sub,
        ],
      );
      return res.rows[0];
    });
  }

  @Post("activities/:id/done")
  @HttpCode(200)
  @Roles(...CRM_ROLES)
  async markDone(
    @TenantClaims() claims: TenantTokenClaims,
    @Param("id", ParseUUIDPipe) activityId: string,
  ) {
    return this.db.withTenant(claims.tid, claims.sub, async (client) => {
      const res = await client.query(
        `UPDATE crm_activities SET done = true WHERE id = $1
         RETURNING id, done`,
        [activityId],
      );
      if (!res.rows[0]) throw new BadRequestException("Activity not found");
      return res.rows[0];
    });
  }
}
