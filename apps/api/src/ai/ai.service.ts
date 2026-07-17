import {
  Injectable,
  ServiceUnavailableException,
  BadRequestException,
} from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import type { TenantTokenClaims } from "@jenga/shared";
import { DbService } from "../db/db.service";
import { QuotesService } from "../invoicing/quotes.service";
import { InvoicesService, InvoiceLineInput } from "../invoicing/invoices.service";
import { ComplianceService } from "../compliance/compliance.service";

/** A document the assistant created this turn, for the UI to render as a card. */
export interface AiArtifact {
  type: "quote" | "invoice";
  id: string;
  label: string;
  href: string;
  totalCents?: number;
}

export interface AskResult {
  reply: string;
  artifacts: AiArtifact[];
}

/**
 * A file attached to a user turn. Full bytes (dataBase64) travel only on the
 * newest turn; for older turns the client re-sends the name alone and the
 * model sees a cheap text marker instead of megabytes of base64 again.
 */
export interface AiAttachmentInput {
  name: string;
  mime?: string;
  dataBase64?: string;
}

/** Client-visible chat turns (tool exchanges stay server-side per request). */
export interface AiTurn {
  role: "user" | "assistant";
  content: string;
  attachments?: AiAttachmentInput[];
}

const MODEL = "claude-opus-4-8";
const MAX_LOOP = 8;
const MAX_TURNS = 20;
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // matches the Documents module
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageMime = (typeof IMAGE_MIMES)[number];

const SYSTEM_PROMPT = `You are the Jenga Assistant inside Jenga ERP, a business platform for Kenyan SMEs (invoicing, quotes, VAT/eTIMS compliance, M-Pesa payments, payroll).

You help the signed-in business owner or staff member run their business by answering questions from their books and preparing sales documents.

Rules:
- Use the provided tools for ALL facts and actions. Never invent customers, amounts, or balances.
- Money: tools return amounts in cents; always present them to the user as KES with thousands separators (e.g. KES 61,480.00). When creating documents you pass unit prices in KES (the tool converts).
- VAT: line prices are VAT-EXCLUSIVE. Default vatRate is "0.16" (standard 16%) unless the user says zero-rated ("0") or exempt ("exempt").
- You may CREATE drafts (quotes, draft invoices) and convert quotes to draft invoices. You can NOT issue invoices, fiscalize with KRA, send documents, or move money — after creating a draft, tell the user to review and issue it from the linked page. This is a deliberate control: issuing is a legal/tax act that requires a human.
- If a customer name doesn't match exactly, use find_customers and confirm your best match with the user; only create a new customer when they clearly want one.
- The user may attach photos or PDFs (receipts, supplier bills, LPOs, price lists, handwritten notes). Read them carefully and extract names, dates, quantities and amounts faithfully — never guess an unreadable figure, ask instead. Totals on receipts/bills are usually VAT-INCLUSIVE: for standard-rated lines derive the VAT-exclusive unit price (divide by 1.16) and say you did so. State what you extracted before creating any document from it.
- Reply in the language the user writes in (English or Kiswahili). Be brief and concrete: lead with the outcome, then key figures.
- If asked something outside the business/books, politely steer back.`;

/** Raw JSON-Schema tool definitions (Anthropic.Tool shape). */
const TOOLS: Anthropic.Tool[] = [
  {
    name: "find_customers",
    description:
      "Search the tenant's customers by (partial, case-insensitive) name. Call this before creating documents to resolve the customer id.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name or part of it. Empty lists recent customers." },
      },
      required: [],
    },
  },
  {
    name: "create_customer",
    description:
      "Create a new customer. Only when the user clearly wants a customer that does not exist yet.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "find_items",
    description:
      "Search the product/service catalogue (name, SKU, unit price) to price lines the user references by product name.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: [],
    },
  },
  {
    name: "list_invoices",
    description:
      "List recent invoices with customer, status (draft/issued/paid/void), totals and due dates. Use overdueOnly for receivables/collections questions.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "issued", "paid", "void"] },
        overdueOnly: { type: "boolean" },
      },
      required: [],
    },
  },
  {
    name: "list_quotes",
    description: "List recent quotations with customer, status and totals.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_vat_summary",
    description:
      "VAT3 return draft for a month (YYYY-MM): output VAT on sales, deductible input VAT (eTIMS-backed only) and net VAT payable.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", description: "YYYY-MM, e.g. 2026-07" },
      },
      required: ["period"],
    },
  },
  {
    name: "create_quote",
    description:
      "Create a DRAFT quotation for a customer. Returns the quote number and total. The user reviews/sends it from the Quotes page.",
    input_schema: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        validUntil: { type: "string", description: "YYYY-MM-DD (optional)" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number" },
              unitPriceKes: { type: "number", description: "VAT-exclusive unit price in KES" },
              vatRate: { type: "string", enum: ["0.16", "0", "exempt"] },
            },
            required: ["description", "quantity", "unitPriceKes"],
          },
        },
      },
      required: ["customerId", "lines"],
    },
  },
  {
    name: "create_invoice_draft",
    description:
      "Create a DRAFT invoice for a customer. It is NOT issued or fiscalized — the user must review and issue it from the invoice page.",
    input_schema: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        dueDate: { type: "string", description: "YYYY-MM-DD (optional)" },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              description: { type: "string" },
              quantity: { type: "number" },
              unitPriceKes: { type: "number", description: "VAT-exclusive unit price in KES" },
              vatRate: { type: "string", enum: ["0.16", "0", "exempt"] },
            },
            required: ["description", "quantity", "unitPriceKes"],
          },
        },
      },
      required: ["customerId", "lines"],
    },
  },
  {
    name: "convert_quote_to_invoice",
    description:
      "Convert an open quotation into a DRAFT invoice (quote becomes 'converted'). The draft still needs human review and issue.",
    input_schema: {
      type: "object",
      properties: { quoteId: { type: "string" } },
      required: ["quoteId"],
    },
  },
];

interface RawLine {
  description: string;
  quantity: number;
  unitPriceKes: number;
  vatRate?: string;
}

/**
 * AI assistant: a tool-using agentic loop over the tenant's own books.
 *
 * Every tool executes inside db.withTenant(), so row-level security bounds
 * the model exactly like the signed-in user — it can never read or write
 * another tenant. Write tools produce DRAFTS only; issuing/fiscalizing and
 * money movement stay behind the existing human flows by construction
 * (there is simply no tool for them).
 *
 * Uses the stable Messages API with a manual tool loop (no beta helper
 * dependency); the loop is bounded and the model/base URL come from env so
 * tests can point at a mock server.
 */
@Injectable()
export class AiService {
  private client: Anthropic | null = null;

  constructor(
    private readonly db: DbService,
    private readonly quotes: QuotesService,
    private readonly invoices: InvoicesService,
    private readonly compliance: ComplianceService,
  ) {
    if (process.env.ANTHROPIC_API_KEY) {
      // Reads ANTHROPIC_BASE_URL from env automatically (used by tests).
      this.client = new Anthropic();
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async ask(claims: TenantTokenClaims, turns: AiTurn[]): Promise<AskResult> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        "AI assistant is not configured yet (missing ANTHROPIC_API_KEY).",
      );
    }
    const history = (turns ?? [])
      .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
      .slice(-MAX_TURNS);
    const last = history[history.length - 1];
    const lastAtts = this.cleanAttachments(last?.attachments);
    if (
      !last ||
      last.role !== "user" ||
      (!last.content.trim() && !lastAtts.some((a) => a.dataBase64))
    ) {
      throw new BadRequestException(
        "Last turn must be a user message with text or an attachment",
      );
    }

    // Validate + convert the newest turn's files into model blocks first so a
    // bad file 400s before anything is persisted or sent.
    const freshBlocks: Anthropic.ContentBlockParam[] = [];
    const freshFiles: { name: string; mime: string; bytes: Buffer }[] = [];
    for (const a of lastAtts) {
      if (!a.dataBase64) continue;
      const { block, bytes, mime } = this.toAttachmentBlock(a);
      freshBlocks.push(block);
      freshFiles.push({ name: a.name, mime, bytes });
    }
    if (freshFiles.length > 0) await this.fileAttachments(claims, freshFiles);

    const artifacts: AiArtifact[] = [];
    const messages: Anthropic.MessageParam[] = history.map((t, idx) => {
      const text = t.content.slice(0, 4000);
      const atts = idx === history.length - 1 ? lastAtts : this.cleanAttachments(t.attachments);
      if (t.role === "assistant" || atts.length === 0) {
        return { role: t.role, content: text };
      }
      if (idx === history.length - 1 && freshBlocks.length > 0) {
        const blocks: Anthropic.ContentBlockParam[] = [...freshBlocks];
        if (text.trim()) blocks.push({ type: "text", text });
        return { role: "user", content: blocks };
      }
      // Older (or stripped) turns: a text marker keeps the model aware a file
      // was shared without re-sending its bytes on every request.
      const markers = atts
        .map((a) => `[Attached file: ${a.name.slice(0, 120)}]`)
        .join(" ");
      return { role: "user", content: `${text}\n${markers}`.trim() };
    });

    let reply = "";
    for (let i = 0; i < MAX_LOOP; i++) {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        reply = text || reply;
        break;
      }

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        let content: string;
        let isError = false;
        try {
          content = JSON.stringify(
            await this.executeTool(claims, tu.name, tu.input as Record<string, unknown>, artifacts),
          );
        } catch (err) {
          isError = true;
          content = err instanceof Error ? err.message : String(err);
        }
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content,
          is_error: isError,
        });
      }
      messages.push({ role: "user", content: results });
    }

    return { reply: reply || "Sorry — I couldn't complete that. Please try again.", artifacts };
  }

  /** Execute one tenant-scoped tool. Public for direct testing. */
  async executeTool(
    claims: TenantTokenClaims,
    name: string,
    input: Record<string, unknown>,
    artifacts: AiArtifact[],
  ): Promise<unknown> {
    switch (name) {
      case "find_customers":
        return this.db.withTenant(claims.tid, claims.sub, async (c) => {
          const q = `%${String(input.query ?? "")}%`;
          const r = await c.query(
            `SELECT id, name, phone, email, kra_pin FROM customers
             WHERE name ILIKE $1 ORDER BY name LIMIT 15`,
            [q],
          );
          return r.rows;
        });

      case "create_customer":
        return this.db.withTenant(claims.tid, claims.sub, async (c) => {
          if (!String(input.name ?? "").trim()) throw new Error("name is required");
          const r = await c.query(
            `INSERT INTO customers (tenant_id, name, phone, email)
             VALUES ($1, $2, $3, $4) RETURNING id, name`,
            [claims.tid, String(input.name).trim(), input.phone ?? null, input.email ?? null],
          );
          return r.rows[0];
        });

      case "find_items":
        return this.db.withTenant(claims.tid, claims.sub, async (c) => {
          const q = `%${String(input.query ?? "")}%`;
          const r = await c.query(
            `SELECT id, sku, name, price_cents, vat_rate FROM items
             WHERE name ILIKE $1 OR sku ILIKE $1 ORDER BY name LIMIT 15`,
            [q],
          );
          return r.rows;
        });

      case "list_invoices":
        return this.db.withTenant(claims.tid, claims.sub, async (c) => {
          const conds: string[] = [];
          const params: unknown[] = [];
          if (input.status) {
            params.push(input.status);
            conds.push(`i.status = $${params.length}`);
          }
          if (input.overdueOnly) {
            conds.push(`i.status = 'issued' AND i.due_date < current_date`);
          }
          const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
          const r = await c.query(
            `SELECT i.id, i.invoice_no, i.status, i.total_cents, i.issue_date, i.due_date,
                    (i.status = 'issued' AND i.due_date < current_date) AS overdue,
                    c2.name AS customer_name
             FROM invoices i JOIN customers c2 ON c2.id = i.customer_id
             ${where} ORDER BY i.created_at DESC LIMIT 25`,
            params,
          );
          return r.rows;
        });

      case "list_quotes":
        return this.db.withTenant(claims.tid, claims.sub, async (c) => {
          const r = await c.query(
            `SELECT q.id, q.quote_no, q.status, q.total_cents, q.valid_until,
                    c2.name AS customer_name
             FROM quotes q JOIN customers c2 ON c2.id = q.customer_id
             ORDER BY q.created_at DESC LIMIT 25`,
          );
          return r.rows;
        });

      case "get_vat_summary":
        return this.db.withTenant(claims.tid, claims.sub, (c) =>
          this.compliance.vatReturnDraft(c, String(input.period ?? "")),
        );

      case "create_quote": {
        const lines = this.toLines(input.lines);
        return this.db.withTenant(claims.tid, claims.sub, async (c) => {
          const branchId = await this.ensureBranch(c, claims.tid);
          const res = await this.quotes.createDraft(c, {
            tenantId: claims.tid,
            userId: claims.sub,
            branchId,
            customerId: String(input.customerId),
            validUntil: input.validUntil ? String(input.validUntil) : undefined,
            lines,
          });
          artifacts.push({
            type: "quote",
            id: res.id,
            label: `Q-${res.quoteNo}`,
            href: "/quotes",
            totalCents: res.totalCents,
          });
          return { quoteId: res.id, quoteNo: res.quoteNo, totalCents: res.totalCents, status: "draft" };
        });
      }

      case "create_invoice_draft": {
        const lines = this.toLines(input.lines);
        return this.db.withTenant(claims.tid, claims.sub, async (c) => {
          const branchId = await this.ensureBranch(c, claims.tid);
          const res = await this.invoices.createDraft(c, {
            tenantId: claims.tid,
            userId: claims.sub,
            branchId,
            customerId: String(input.customerId),
            dueDate: input.dueDate ? String(input.dueDate) : undefined,
            lines,
          });
          const tot = await c.query(
            `SELECT total_cents FROM invoices WHERE id = $1`,
            [res.id],
          );
          const totalCents = Number(tot.rows[0]?.total_cents ?? 0);
          artifacts.push({
            type: "invoice",
            id: res.id,
            label: "Draft invoice",
            href: `/invoices/view?id=${res.id}`,
            totalCents,
          });
          return { invoiceId: res.id, status: "draft", totalCents };
        });
      }

      case "convert_quote_to_invoice":
        return this.db.withTenant(claims.tid, claims.sub, async (c) => {
          const res = await this.quotes.convert(c, {
            tenantId: claims.tid,
            userId: claims.sub,
            quoteId: String(input.quoteId),
          });
          artifacts.push({
            type: "invoice",
            id: res.invoiceId,
            label: "Draft invoice (from quote)",
            href: `/invoices/view?id=${res.invoiceId}`,
          });
          return { invoiceId: res.invoiceId, status: "draft" };
        });

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private toLines(raw: unknown): InvoiceLineInput[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error("lines are required");
    }
    return (raw as RawLine[]).map((l) => {
      const vr = l.vatRate === "0" || l.vatRate === "exempt" ? l.vatRate : "0.16";
      const qty = Number(l.quantity);
      const price = Number(l.unitPriceKes);
      if (!l.description || !(qty > 0) || !(price >= 0)) {
        throw new Error("Each line needs description, quantity > 0 and unitPriceKes >= 0");
      }
      return {
        description: String(l.description).slice(0, 300),
        quantity: qty,
        unitPriceCents: Math.round(price * 100),
        vatRate: vr,
      };
    });
  }

  /** Drop malformed entries and cap the count; never trust client arrays. */
  private cleanAttachments(raw: unknown): AiAttachmentInput[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (a): a is AiAttachmentInput =>
          !!a && typeof a === "object" && typeof (a as AiAttachmentInput).name === "string" &&
          (a as AiAttachmentInput).name.trim().length > 0,
      )
      .slice(0, MAX_ATTACHMENTS);
  }

  /** Decode + validate one attachment and build its Anthropic content block. */
  private toAttachmentBlock(a: AiAttachmentInput): {
    block: Anthropic.ContentBlockParam;
    bytes: Buffer;
    mime: string;
  } {
    const name = a.name.trim().slice(0, 200);
    const mime = (a.mime ?? "").toLowerCase().split(";")[0].trim();
    const bytes = Buffer.from(a.dataBase64 ?? "", "base64");
    if (bytes.length === 0) {
      throw new BadRequestException(`${name}: file is empty or not valid base64`);
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException(
        `${name}: file too large: ${Math.round(bytes.length / 1024 / 1024)}MB (max 5MB)`,
      );
    }
    // Re-encode so whitespace/url-safe variants normalize to clean base64.
    const data = bytes.toString("base64");
    if ((IMAGE_MIMES as readonly string[]).includes(mime)) {
      return {
        block: {
          type: "image",
          source: { type: "base64", media_type: mime as ImageMime, data },
        },
        bytes,
        mime,
      };
    }
    if (mime === "application/pdf") {
      return {
        block: {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data },
        },
        bytes,
        mime,
      };
    }
    throw new BadRequestException(
      `${name}: only images (JPEG, PNG, GIF, WebP) and PDFs are supported`,
    );
  }

  /**
   * File assistant uploads into the Documents cabinet (an "Assistant" folder),
   * mirroring chat: the source receipt/bill outlives the conversation and is
   * there for the auditor.
   */
  private async fileAttachments(
    claims: TenantTokenClaims,
    files: { name: string; mime: string; bytes: Buffer }[],
  ): Promise<void> {
    await this.db.withTenant(claims.tid, claims.sub, async (c) => {
      const existing = await c.query(
        `SELECT id FROM document_folders WHERE name = 'Assistant' AND parent_id IS NULL LIMIT 1`,
      );
      const folderId =
        existing.rows[0]?.id ??
        (
          await c.query(
            `INSERT INTO document_folders (tenant_id, name, parent_id, created_by)
             VALUES ($1, 'Assistant', NULL, $2) RETURNING id`,
            [claims.tid, claims.sub],
          )
        ).rows[0].id;
      for (const f of files) {
        await c.query(
          `INSERT INTO documents
             (tenant_id, name, mime, size_bytes, data, uploaded_by,
              folder_id, category, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'other', 'Uploaded to the Jenga Assistant')`,
          [
            claims.tid,
            f.name.trim().slice(0, 200),
            f.mime,
            f.bytes.length,
            f.bytes,
            claims.sub,
            folderId,
          ],
        );
      }
    });
  }

  /** Get the tenant's first branch, creating HQ if none exists (same as the UI). */
  private async ensureBranch(
    c: import("pg").PoolClient,
    tenantId: string,
  ): Promise<string> {
    const b = await c.query(`SELECT id FROM branches ORDER BY created_at LIMIT 1`);
    if (b.rows[0]) return b.rows[0].id;
    const created = await c.query(
      `INSERT INTO branches (tenant_id, code, name) VALUES ($1, 'HQ', 'Main') RETURNING id`,
      [tenantId],
    );
    return created.rows[0].id;
  }
}
